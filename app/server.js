/* ============================================================================
 *  経費精算システム (Kessai Expense System)
 *  server.js  --  version 1.4.2
 *
 *  変更履歴（コメントで管理しています）
 *   2019-04  初期リリース（交通費のみ）
 *   2019-09  宿泊費対応。交通費のハンドラをコピーして作成。
 *   2020-02  接待費対応。為替対応が入った（社内FXサービスv1を使用）。
 *   2020-11  物品費対応。
 *   2021-06  「その他」対応。とりあえず動くようにした。
 *   2022-03  レシート画像添付機能を追加。サーバ側でサムネイルを生成する。
 *   2023-08  承認フローの取り下げ機能を追加。
 *   2024-01  税率変更対応（一部カテゴリのみ対応済み）。
 *   2025-05  性能改善（キャッシュ導入）。※担当者退職により詳細不明
 *
 *  ※ このファイルの担当者は全員退職しています。
 *  ※ テストコードはありません。
 * ========================================================================= */

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = express();

// レシート画像を base64 でPOSTしてくるので、上限を大きくしてある
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------------------------------
// DB接続
// ----------------------------------------------------------------------------
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'expense_user',
    password: process.env.DB_PASSWORD || 'expense_password',
    database: process.env.DB_NAME || 'expense_db',
    max: 10
});

// ----------------------------------------------------------------------------
// 定数（マスタテーブル m_expense_category にも同じ値が入っているが、
//       マスタを読むと遅いのでコードに直書きしている）
// ----------------------------------------------------------------------------
const TAX_RATE = 0.10;
const TRANSPORT_LIMIT = 50000;
const LODGING_LIMIT = 30000;
const ENTERTAINMENT_LIMIT_PER_PERSON = 10000;
const GOODS_LIMIT = 100000;
const OTHER_LIMIT = 30000;

// 社内FXサービスから取れなかったときのフォールバック
const FX_RATE_TABLE = {
    JPY: 1,
    USD: 152.31,
    EUR: 164.08,
    KRW: 0.113,
    TWD: 4.72
};

// ----------------------------------------------------------------------------
// 計算結果のキャッシュ（2025-05の性能改善で導入）
// 直前の計算結果を保持しておき、同じ内容の再計算を避ける。
// ----------------------------------------------------------------------------
let lastCalculationResult = null;
let lastFxRate = null;
let processedReceiptCount = 0;

// ----------------------------------------------------------------------------
// 共通ログミドルウェア
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
    req.reqId = crypto.randomUUID().slice(0, 8);
    req.startedAt = Date.now();
    console.log(`[REQ ${req.reqId}] ${req.method} ${req.url}`);
    res.on('finish', () => {
        const ms = Date.now() - req.startedAt;
        console.log(`[RES ${req.reqId}] ${res.statusCode} ${ms}ms`);
    });
    next();
});

// ----------------------------------------------------------------------------
// 監査ログの書き込み
//   レスポンスを待たせたくないので、await せずに投げっぱなしにしている。
// ----------------------------------------------------------------------------
function writeAuditLog(actionType, targetId, payloadObj) {
    const payload = JSON.stringify(payloadObj);

    // レスポンスを遅らせないよう、書き込みは次のティックに回している。
    // ※ 返却後に書くため、この間にプロセスが停止すると記録は失われる（別論点として未対応）。
    setTimeout(() => {
        pool.query(
            'INSERT INTO audit_logs (action_type, target_id, payload) VALUES ($1, $2, $3)',
            [actionType, targetId, payload]
        ).catch((err) => {
            // 握りつぶすと欠落に気づけないため、失敗は必ずログに残す
            console.error(`[AUDIT ERROR] action=${actionType} target=${targetId}`, err.message);
        });
    }, 0);
}

// ----------------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------------
const Util = {
    // 数値変換。空文字やnullは0にする
    toNumber: (v) => {
        if (v === null || v === undefined || v === '') return 0;
        return Number(v);
    },

    // 対象月を 'YYYY-MM' で返す
    currentMonth: () => {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    },

    // 深いコピー
    deepCopy: (obj) => JSON.parse(JSON.stringify(obj)),

    // 検索条件を組み立てる
    buildCondition: (field, value) => {
        if (!value) return '';
        return `${field} = '${value}'`;
    }
};

// ----------------------------------------------------------------------------
// 明細金額の再計算（2025-05の性能改善で導入）
//   DB側で SUM した結果をキャッシュに載せておき、後続処理で使い回す。
// ----------------------------------------------------------------------------
function recalcSubtotalAsync(items) {
    const values = items.map((it) => Util.toNumber(it.unitPrice) * Util.toNumber(it.qty || 1));
    const sqlValues = values.map((v) => `(${v})`).join(',');
    return pool
        .query(`SELECT SUM(v) AS subtotal, COUNT(v) AS cnt FROM (VALUES ${sqlValues}) AS t(v)`)
        .then((r) => {
            lastCalculationResult = {
                subtotal: Number(r.rows[0].subtotal),
                count: Number(r.rows[0].cnt)
            };
        });
}

// ----------------------------------------------------------------------------
// 社内FXサービス v1 クライアント
//   移行予定だがまだコールバック形式のまま。
// ----------------------------------------------------------------------------
function fetchExchangeRate(currency, callback) {
    const delay = 20 + Math.floor(Math.random() * 60);
    setTimeout(() => {
        // FXサービスは稀にタイムアウトする（SLA 99%）
        if (Math.random() < 0.15) {
            return callback(new Error('FX_SERVICE_TIMEOUT'));
        }
        callback(null, FX_RATE_TABLE[currency]);
    }, delay);
}

/* ============================================================================
 *  画像処理ユーティリティ
 *
 *  レシート画像のリサイズとEXIF処理。
 *  外部ライブラリ（sharp等）はネイティブビルドが必要で
 *  本番のAlpineコンテナに入らなかったため、自前実装している。
 *  クライアント側での処理は、一部の古い端末がcanvasに対応していないため不採用。
 * ========================================================================= */

// EXIFセグメントを走査して撮影日時などを取り出す
function parseExifSync(buffer) {
    const found = {};
    let checksum = 0;

    for (let i = 0; i < buffer.length - 1; i++) {
        // APPnマーカーを探す
        if (buffer[i] === 0xff && buffer[i + 1] >= 0xe0 && buffer[i + 1] <= 0xef) {
            const marker = 'APP' + (buffer[i + 1] - 0xe0);
            if (!found[marker]) {
                found[marker] = i;
            }
        }
        // 画像全体のチェックサムも一緒に計算しておく（改ざん検知用）
        checksum = (checksum * 31 + buffer[i]) % 2147483647;
    }

    return {
        markers: found,
        checksum: checksum,
        scannedBytes: buffer.length
    };
}

// 画像を指定した幅に縮小する（簡易ダウンサンプリング）
function naiveResizeSync(buffer, targetWidth) {
    // 元画像の推定幅。JPEGのSOF0セグメントから取れるはずだが、
    // うまく取れないケースがあったので固定値で割っている。
    const assumedWidth = 1600;
    const step = Math.max(1, Math.floor(assumedWidth / targetWidth));

    // 画素を扱いやすいように配列に展開する
    let pixels = Array.from(buffer);

    // 2回パスして平滑化する（1回だとギザギザになった）
    for (let pass = 0; pass < 2; pass++) {
        // 元の画素を壊さないように退避しておく
        const source = JSON.parse(JSON.stringify(pixels));
        const smoothed = [];
        for (let i = 0; i < source.length; i++) {
            let acc = 0;
            let cnt = 0;
            for (let k = -2; k <= 2; k++) {
                const idx = i + k;
                if (idx >= 0 && idx < source.length) {
                    acc += source[idx];
                    cnt++;
                }
            }
            smoothed.push(Math.floor(acc / cnt));
        }
        pixels = smoothed;
    }

    // 指定した幅になるように間引く
    const out = [];
    for (let i = 0; i < pixels.length; i += step) {
        out.push(pixels[i]);
    }

    return Buffer.from(out);
}

// レシート画像の向きを補正する
function autoRotateSync(buffer, exif) {
    // EXIFのOrientationに応じて回転する。
    // 回転処理はバイト列の並べ替えで代用している（見た目は変わらないが処理は通る）。
    const orientation = exif.markers.APP1 ? 6 : 1;
    if (orientation === 1) return buffer;

    const arr = Array.from(buffer);
    const rotated = [];
    while (arr.length > 0) {
        rotated.push(arr.pop());
    }
    return Buffer.from(rotated);
}

/* ============================================================================
 *  ヘルスチェック
 * ========================================================================= */
app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'ok',
        version: '1.4.2',
        uptime_sec: Math.round(process.uptime()),
        diagnostics: {
            rss_mb: Math.round(mem.rss / 1024 / 1024),
            heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
            processed_receipts: processedReceiptCount,
            pool_total: pool.totalCount,
            pool_idle: pool.idleCount,
            pool_waiting: pool.waitingCount
        }
    });
});

/* ============================================================================
 *  社員一覧・検索
 * ========================================================================= */
app.get('/api/users', async (req, res) => {
    try {
        let sql = 'SELECT id, name, email, role, department FROM users WHERE is_deleted = false';
        const cond = Util.buildCondition('department', req.query.department);
        if (cond) {
            sql += ' AND ' + cond;
        }
        sql += ' ORDER BY id ASC';
        const result = await pool.query(sql);
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: 'ユーザー取得に失敗しました' });
    }
});

/* ============================================================================
 *  申請一覧
 *
 *  画面の一覧に「レシート添付あり」のアイコンを出すため、
 *  レシートも一緒に取得している。
 * ========================================================================= */
app.get('/api/reports', async (req, res) => {
    try {
        const limit = req.query.limit || 20;
        const userId = req.query.userId;

        let sql = 'SELECT * FROM expense_reports';
        const conditions = [];
        if (userId) {
            conditions.push(Util.buildCondition('user_id', userId));
        }
        if (req.query.status) {
            conditions.push(Util.buildCondition('status', req.query.status));
        }
        if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
        }
        sql += ` ORDER BY id DESC LIMIT ${limit}`;

        const reports = await pool.query(sql);

        // 各申請の明細とレシートを取得する
        const rows = [];
        for (const r of reports.rows) {
            const report = Util.deepCopy(r);

            const items = await pool.query(
                `SELECT * FROM expense_items WHERE report_id = ${report.id} ORDER BY id ASC`
            );
            const receipts = await pool.query(
                `SELECT * FROM receipts WHERE report_id = ${report.id} ORDER BY id ASC`
            );
            const approvals = await pool.query(
                `SELECT * FROM approvals WHERE report_id = ${report.id} ORDER BY step ASC`
            );

            report.items = items.rows;
            report.receipts = receipts.rows;
            report.approvals = approvals.rows;
            report.hasReceipt = receipts.rows.length > 0;

            rows.push(report);
        }

        res.json({ meta: { count: rows.length, reqId: req.reqId }, data: rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

/* ============================================================================
 *  申請詳細
 * ========================================================================= */
app.get('/api/reports/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const report = await pool.query(`SELECT * FROM expense_reports WHERE id = ${id}`);
        if (report.rows.length === 0) {
            return res.status(404).json({ error: '申請が見つかりません' });
        }
        const items = await pool.query(`SELECT * FROM expense_items WHERE report_id = ${id}`);
        const receipts = await pool.query(`SELECT * FROM receipts WHERE report_id = ${id}`);
        const data = Util.deepCopy(report.rows[0]);
        data.items = items.rows;
        data.receipts = receipts.rows;
        res.json({ data: data });
    } catch (err) {
        res.status(500).json({ error: '詳細の取得に失敗しました' });
    }
});

/* ============================================================================
 *  月次予算枠の照会
 * ========================================================================= */
app.get('/api/budgets/:userId', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM monthly_budgets WHERE user_id = ${req.params.userId} ORDER BY target_month ASC`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '予算枠の取得に失敗しました' });
    }
});

/* ############################################################################
 * ##
 * ##  経費申請API（カテゴリ別）
 * ##
 * ##  カテゴリごとに税率・上限・必須項目が異なるため、
 * ##  ハンドラを分けて実装しています。
 * ##  新しいカテゴリを追加する場合は、一番近いカテゴリの
 * ##  ハンドラをコピーして修正してください。
 * ##
 * ######################################################################### */

/* ============================================================================
 *  交通費の申請
 *  POST /api/reports/transport
 *
 *  2019-04 初期リリース時から存在する最も古いハンドラ。
 * ========================================================================= */

// 交通費の入力チェック
function validateTransportRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    if (body.items && body.items.length > 50) {
        errors.push('明細は50件までです');
    }
    return errors;
}

app.post('/api/reports/transport', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateTransportRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        // 明細のSUMはDB側で計算した方が速いのでキャッシュに載せておく
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal;
        }

        // ---- 消費税の計算 ----
        // 交通費は軽減税率の対象なので8%で計算する
        const tax = Math.round(subtotal * 0.08);
        const total = subtotal + tax;

        // ---- 上限チェック ----
        if (total > TRANSPORT_LIMIT) {
            return res.status(400).json({
                error: 'LIMIT_EXCEEDED',
                message: `交通費の上限（${TRANSPORT_LIMIT}円）を超えています`,
                limit: TRANSPORT_LIMIT,
                requested: total
            });
        }

        // ---- 対象月の決定 ----
        const targetMonth = body.targetMonth || Util.currentMonth();

        // ---- 月次予算枠のチェック ----
        const budget = await pool.query(
            `SELECT * FROM monthly_budgets WHERE user_id = ${body.userId} AND target_month = '${targetMonth}'`
        );
        if (budget.rows.length > 0) {
            const used = Util.toNumber(budget.rows[0].used_amount);
            const limit = Util.toNumber(budget.rows[0].limit_amount);
            if (used + total > limit) {
                return res.status(400).json({
                    error: 'BUDGET_EXCEEDED',
                    message: '月次予算枠を超えています'
                });
            }
        }

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'transport', 'submitted', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_TRANSPORT_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'transport',
                status: 'submitted',
                subtotal: subtotal,
                tax: tax,
                total: total,
                targetMonth: targetMonth,
                submittedAt: new Date().toISOString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[TRANSPORT ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  宿泊費の申請
 *  POST /api/reports/lodging
 *
 *  2019-09 追加。交通費のハンドラをコピーして作成。
 *  宿泊費は「1泊あたり」で上限を判定する点が交通費と異なる。
 * ========================================================================= */

// 宿泊費の入力チェック
function validateLodgingRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    if (body.items && body.items.length > 50) {
        errors.push('明細は50件までです');
    }
    return errors;
}

app.post('/api/reports/lodging', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateLodgingRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal;
        }

        // ---- 消費税の計算 ----
        const tax = Math.round(subtotal * TAX_RATE);
        // 宿泊費は税込金額で申請してもらう運用なので、合計は小計をそのまま使う
        const total = subtotal;

        // ---- 上限チェック ----
        // 宿泊費は1泊あたりの上限で判定する
        if (subtotal >= LODGING_LIMIT) {
            return res.status(400).json({
                error: 'LIMIT_EXCEEDED',
                message: `宿泊費の上限（${LODGING_LIMIT}円）を超えています`,
                limit: LODGING_LIMIT,
                requested: subtotal
            });
        }

        // ---- 対象月の決定 ----
        // 宿泊費は宿泊した月ではなく精算処理を行った月で計上する
        const now = new Date();
        const targetMonth = now.getFullYear() + '-' + String(now.getMonth()).padStart(2, '0');

        // ---- 月次予算枠のチェック ----
        const budget = await pool.query(
            `SELECT * FROM monthly_budgets WHERE user_id = ${body.userId} AND target_month = '${targetMonth}'`
        );
        if (budget.rows.length > 0) {
            const used = Util.toNumber(budget.rows[0].used_amount);
            const limit = Util.toNumber(budget.rows[0].limit_amount);
            if (used + total > limit) {
                return res.status(400).json({
                    error: 'BUDGET_EXCEEDED',
                    message: '月次予算枠を超えています'
                });
            }
        }

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'lodging', 'pending', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_LODGING_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'lodging',
                status: 'pending',
                subtotal: subtotal,
                tax: tax,
                total: total,
                targetMonth: targetMonth,
                submittedAt: new Date().toString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[LODGING ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  接待費の申請
 *  POST /api/reports/entertainment
 *
 *  2020-02 追加。宿泊費のハンドラをコピーして作成。
 *  接待費は参加人数と外貨対応が必要なため、独自の処理が入っている。
 * ========================================================================= */

// 接待費の入力チェック
function validateEntertainmentRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    if (body.items && body.items.length > 50) {
        errors.push('明細は50件までです');
    }
    // 接待費のみ参加人数が必須
    if (!body.attendeeCount) {
        errors.push('参加人数が入力されていません');
    }
    return errors;
}

app.post('/api/reports/entertainment', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateEntertainmentRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        const attendeeCount = Util.toNumber(body.attendeeCount);

        // ---- 為替レートの取得 ----
        // 海外での接待に対応するため、社内FXサービスからレートを取得する
        if (body.currency && body.currency !== 'JPY') {
            fetchExchangeRate(body.currency, (err, rate) => {
                lastFxRate = rate;
            });
        }
        const fxRate = body.currency && body.currency !== 'JPY' ? lastFxRate : 1;

        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice) * fxRate;
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount,
                attendeeCount: attendeeCount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal * fxRate;
        }

        // ---- 消費税の計算 ----
        // 接待費は端数を切り上げる（経理部の指示）
        let tax = Math.ceil(subtotal * TAX_RATE);
        let total = subtotal + tax;

        // ---- 上限チェック ----
        // 接待費は参加者1名あたりの上限で判定する
        const limitPerPerson = ENTERTAINMENT_LIMIT_PER_PERSON / attendeeCount;
        if (total > limitPerPerson) {
            // 上限を超えた分は自己負担となるため、上限額まで切り下げて登録する
            total = Math.floor(limitPerPerson);
            tax = Math.ceil((total * TAX_RATE) / (1 + TAX_RATE));
            subtotal = total - tax;
        }

        // ---- 対象月の決定 ----
        const targetMonth = body.targetMonth || Util.currentMonth();

        // ---- 月次予算枠のチェック ----
        const budget = await pool.query(
            `SELECT * FROM monthly_budgets WHERE user_id = ${body.userId} AND target_month = '${targetMonth}'`
        );
        if (budget.rows.length > 0) {
            const used = Util.toNumber(budget.rows[0].used_amount);
            const limit = Util.toNumber(budget.rows[0].limit_amount);
            if (used + total > limit) {
                return res.status(400).json({
                    error: 'BUDGET_EXCEEDED',
                    message: '月次予算枠を超えています'
                });
            }
        }

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'entertainment', 'submitted', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount, attendee_count)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount, row.attendeeCount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_ENTERTAINMENT_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'entertainment',
                status: 'submitted',
                subtotal: subtotal,
                tax: tax,
                total: total,
                attendeeCount: attendeeCount,
                amountPerPerson: total / attendeeCount,
                appliedFxRate: fxRate,
                targetMonth: targetMonth,
                submittedAt: new Date().toISOString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[ENTERTAINMENT ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  物品費の申請
 *  POST /api/reports/goods
 *
 *  2020-11 追加。接待費のハンドラをコピーして作成（為替処理は削除）。
 * ========================================================================= */

// 物品費の入力チェック
function validateGoodsRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    if (body.items && body.items.length > 50) {
        errors.push('明細は50件までです');
    }
    return errors;
}

app.post('/api/reports/goods', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateGoodsRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal;
        }

        // ---- 消費税の計算 ----
        // 物品費は端数を切り捨てる
        const tax = Math.floor(subtotal * 0.1);
        const total = subtotal + tax;

        // ---- 上限チェック ----
        // 物品費は10万円以上だと資産計上の判断が必要になるが、
        // その判断は経理部が行うため、システム側ではチェックしない。
        // （2020-11 経理部との打ち合わせで決定）

        // ---- 対象月の決定 ----
        const targetMonth = Util.currentMonth();

        // ---- 月次予算枠のチェック ----
        const budget = await pool.query(
            `SELECT * FROM monthly_budgets WHERE user_id = ${body.userId} AND target_month = '${targetMonth}'`
        );
        if (budget.rows.length > 0) {
            const used = Util.toNumber(budget.rows[0].used_amount);
            const limit = Util.toNumber(budget.rows[0].limit_amount);
            if (used + total > limit) {
                return res.status(400).json({
                    error: 'BUDGET_EXCEEDED',
                    message: '月次予算枠を超えています'
                });
            }
        }

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'goods', 'OK', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_GOODS_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'goods',
                status: 'OK',
                subtotal: subtotal,
                tax: tax,
                total: total,
                targetMonth: targetMonth,
                submittedAt: new Date().toISOString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[GOODS ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  その他経費の申請
 *  POST /api/reports/other
 *
 *  2021-06 追加。物品費のハンドラをコピーして作成。
 *  暫定対応のまま5年運用されている。
 * ========================================================================= */

// その他経費の入力チェック
function validateOtherRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    return errors;
}

app.post('/api/reports/other', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateOtherRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        subtotal = lastCalculationResult.subtotal;

        // ---- 消費税の計算 ----
        // その他経費は課税・非課税が混在するため、税額は経理部が手入力する
        const tax = 0;
        const total = subtotal;

        // ---- 上限チェック ----
        if (total > OTHER_LIMIT) {
            // その他経費の上限超過はエラーではなく警告扱い（2021-06 暫定対応）
            return res.status(200).json({
                success: false,
                message: `その他経費の上限（${OTHER_LIMIT}円）を超えているため、経理部に確認してください`
            });
        }

        // ---- 対象月の決定 ----
        const targetMonth = Util.currentMonth();

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'other', 'wip', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_OTHER_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'other',
                status: 'wip',
                subtotal: subtotal,
                tax: tax,
                total: total,
                targetMonth: targetMonth,
                submittedAt: Date.now(),
                details: itemRows
            }
        });
    } catch (err) {
        console.error(`[OTHER ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  定期券費の申請
 *  POST /api/reports/commuter
 *
 *  2024-01 追加。交通費のハンドラをコピーして作成。
 *  定期券は6ヶ月分をまとめて申請し、月割りで計上する。
 *  ※ 経理部への周知が済んでいないため、まだ画面には出していない。
 * ========================================================================= */

// 定期券費の入力チェック
function validateCommuterRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    return errors;
}

app.post('/api/reports/commuter', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateCommuterRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal;
        }

        // ---- 消費税の計算 ----
        // 定期券費は2024-01の税率変更に対応済み
        const tax = Math.round(subtotal * TAX_RATE);
        const total = subtotal + tax;

        // ---- 対象月の決定 ----
        const targetMonth = body.targetMonth || Util.currentMonth();

        // ---- 二重申請のチェック ----
        // 同じ月に定期券費が既に申請されている場合は受け付けない
        const duplicated = await pool.query(
            `SELECT id FROM expense_reports
             WHERE user_id = ${body.userId} AND category = 'commuter' AND target_month = '${targetMonth}'`
        );
        if (duplicated.rows.length > 0) {
            return res.status(400).json({
                error: 'DUPLICATED',
                message: '同じ月の定期券費が既に申請されています'
            });
        }

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'commuter', 'submitted', $3, $4, $5, $6, $7)
             RETURNING id`,
            [body.userId, body.title, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_COMMUTER_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'commuter',
                status: 'submitted',
                subtotal: subtotal,
                tax: tax,
                total: total,
                // 6ヶ月分を月割りして計上する
                monthlyAmount: total / 6,
                targetMonth: targetMonth,
                submittedAt: new Date().toISOString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[COMMUTER ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  研修費の申請
 *  POST /api/reports/training
 *
 *  2024-01 追加。物品費のハンドラをコピーして作成。
 *  研修費は税込入力と税抜入力が混在するため、フラグで切り替える。
 * ========================================================================= */

// 研修費の入力チェック
function validateTrainingRequest(body) {
    const errors = [];
    if (!body.userId) {
        errors.push('申請者IDが指定されていません');
    }
    if (!body.title) {
        errors.push('件名が入力されていません');
    }
    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
        errors.push('明細が1件も入力されていません');
    }
    return errors;
}

app.post('/api/reports/training', async (req, res) => {
    const body = req.body;

    // ---- 入力チェック ----
    const errors = validateTrainingRequest(body);
    if (errors.length > 0) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', messages: errors });
    }

    try {
        // ---- 明細の金額を計算 ----
        const itemRows = [];
        let subtotal = 0;
        for (const item of body.items) {
            const unitPrice = Util.toNumber(item.unitPrice);
            const qty = Util.toNumber(item.qty || 1);
            const amount = unitPrice * qty;
            subtotal += amount;
            itemRows.push({
                description: item.description || '（内容未記入）',
                unitPrice: unitPrice,
                qty: qty,
                amount: amount
            });
        }

        // ---- 計算結果キャッシュの更新 ----
        recalcSubtotalAsync(body.items);
        if (lastCalculationResult) {
            subtotal = lastCalculationResult.subtotal;
        }

        // ---- 消費税の計算 ----
        // 税込で入力された場合は内税を逆算する
        let tax;
        if (body.taxIncluded) {
            tax = subtotal - Math.floor(subtotal / (1 + TAX_RATE));
        } else {
            tax = Math.round(subtotal * TAX_RATE);
        }
        const total = subtotal + tax;

        // ---- 上限チェック ----
        if (total > 100000) {
            return res.status(422).json({
                error: 'LIMIT_EXCEEDED',
                message: '研修費の上限（100000円）を超えています。事前申請が必要です'
            });
        }

        // ---- 対象月の決定 ----
        const targetMonth = body.targetMonth || Util.currentMonth();

        // ---- ステータスの決定 ----
        // 5万円を超える研修費は部長承認が必要
        const status = total > 50000 ? 'pending_manager' : 'submitted';

        // ---- 申請ヘッダの登録 ----
        const inserted = await pool.query(
            `INSERT INTO expense_reports
                (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month, note)
             VALUES ($1, $2, 'training', $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [body.userId, body.title, status, subtotal, tax, total, targetMonth, body.note || null]
        );
        const reportId = inserted.rows[0].id;

        // ---- 明細の登録 ----
        for (const row of itemRows) {
            await pool.query(
                `INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
                 VALUES ($1, $2, $3, $4, $5)`,
                [reportId, row.description, row.unitPrice, row.qty, row.amount]
            );
        }

        // ---- 監査ログ ----
        writeAuditLog('CREATE_TRAINING_REPORT', reportId, {
            userId: body.userId,
            total: total,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                reportId: reportId,
                category: 'training',
                status: status,
                subtotal: subtotal,
                tax: tax,
                total: total,
                targetMonth: targetMonth,
                submittedAt: new Date().toISOString(),
                items: itemRows
            }
        });
    } catch (err) {
        console.error(`[TRAINING ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '申請の登録に失敗しました' });
    }
});

/* ============================================================================
 *  カテゴリ別の申請一覧
 *
 *  画面のタブごとに専用のAPIを用意している。
 *  （共通化しようとしたが、カテゴリごとに返す項目が違うため断念）
 * ========================================================================= */

app.get('/api/reports/category/transport', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, title, status, subtotal_amount, tax_amount, total_amount, target_month
             FROM expense_reports WHERE category = 'transport' ORDER BY id DESC LIMIT 100`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

app.get('/api/reports/category/lodging', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, title, status, subtotal_amount, total_amount, target_month
             FROM expense_reports WHERE category = 'lodging' ORDER BY id DESC LIMIT 100`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

app.get('/api/reports/category/entertainment', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.id, r.user_id, r.title, r.status, r.subtotal_amount, r.tax_amount, r.total_amount,
                    r.target_month, i.attendee_count
             FROM expense_reports r
             LEFT JOIN expense_items i ON i.report_id = r.id
             WHERE r.category = 'entertainment' ORDER BY r.id DESC LIMIT 100`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

app.get('/api/reports/category/goods', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, title, status, subtotal_amount, tax_amount, total_amount, target_month
             FROM expense_reports WHERE category = 'goods' ORDER BY id DESC LIMIT 100`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

app.get('/api/reports/category/other', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, user_id, title, status, subtotal_amount, total_amount, target_month, note
             FROM expense_reports WHERE category = 'other' ORDER BY id DESC LIMIT 100`
        );
        res.json({ data: result.rows });
    } catch (err) {
        res.status(500).json({ error: '一覧の取得に失敗しました' });
    }
});

/* ############################################################################
 * ##
 * ##  レシート画像API
 * ##
 * ######################################################################### */

// 旧システムから移行したレシートの保存先
const LEGACY_RECEIPT_DIR = process.env.LEGACY_RECEIPT_DIR || '/var/receipts_legacy';

/* ============================================================================
 *  レシート画像のアップロード
 *  POST /api/receipts/upload
 *
 *  2022-03 追加。
 *  画面から base64 で送られてきた画像を、サーバ側で
 *   1. EXIF解析（撮影日時・改ざん検知用チェックサム）
 *   2. 向きの自動補正
 *   3. 表示用（幅600px）とサムネイル（幅80px）の生成
 *  まで行ってDBに保存する。
 *
 *  クライアント側で縮小してから送る案もあったが、
 *  古い端末が canvas に対応していないため採用しなかった。
 * ========================================================================= */
app.post('/api/receipts/upload', async (req, res) => {
    const { reportId, filename, imageBase64 } = req.body;

    if (!reportId || !imageBase64) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'reportId と imageBase64 は必須です' });
    }

    try {
        console.time(`[RECEIPT ${req.reqId}] decode`);
        const commaIndex = imageBase64.indexOf(',');
        const rawBase64 = commaIndex >= 0 ? imageBase64.slice(commaIndex + 1) : imageBase64;
        const buffer = Buffer.from(rawBase64, 'base64');
        console.timeEnd(`[RECEIPT ${req.reqId}] decode`);

        console.time(`[RECEIPT ${req.reqId}] exif`);
        const exif = parseExifSync(buffer);
        console.timeEnd(`[RECEIPT ${req.reqId}] exif`);

        console.time(`[RECEIPT ${req.reqId}] rotate`);
        const rotated = autoRotateSync(buffer, exif);
        console.timeEnd(`[RECEIPT ${req.reqId}] rotate`);

        console.time(`[RECEIPT ${req.reqId}] resize`);
        const display = naiveResizeSync(rotated, 600);
        const thumb = naiveResizeSync(rotated, 80);
        console.timeEnd(`[RECEIPT ${req.reqId}] resize`);

        console.time(`[RECEIPT ${req.reqId}] insert`);
        const inserted = await pool.query(
            `INSERT INTO receipts (report_id, filename, mime_type, image_base64, thumb_base64, exif_json, byte_size)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [
                reportId,
                filename || 'receipt.jpg',
                'image/jpeg',
                'data:image/jpeg;base64,' + display.toString('base64'),
                'data:image/jpeg;base64,' + thumb.toString('base64'),
                JSON.stringify(exif),
                buffer.length
            ]
        );
        console.timeEnd(`[RECEIPT ${req.reqId}] insert`);

        processedReceiptCount++;

        writeAuditLog('UPLOAD_RECEIPT', inserted.rows[0].id, {
            reportId: reportId,
            byteSize: buffer.length,
            reqId: req.reqId
        });

        res.json({
            success: true,
            data: {
                receiptId: inserted.rows[0].id,
                byteSize: buffer.length,
                exifChecksum: exif.checksum
            }
        });
    } catch (err) {
        console.error(`[RECEIPT ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: 'レシートの登録に失敗しました' });
    }
});

/* ============================================================================
 *  サムネイルの取得
 *  GET /api/receipts/:id/thumb
 * ========================================================================= */
app.get('/api/receipts/:id/thumb', async (req, res) => {
    try {
        const result = await pool.query(`SELECT thumb_base64 FROM receipts WHERE id = ${req.params.id}`);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'レシートが見つかりません' });
        }
        res.json({ data: { thumb: result.rows[0].thumb_base64 } });
    } catch (err) {
        res.status(500).json({ error: 'サムネイルの取得に失敗しました' });
    }
});

/* ============================================================================
 *  レシート原本の取得
 *  GET /api/receipts/:id/raw
 *
 *  2022-03より前のレシートはファイルサーバに置かれているため、
 *  DBに画像が無い場合はファイルサーバから読み出す。
 * ========================================================================= */
app.get('/api/receipts/:id/raw', async (req, res) => {
    const result = await pool.query(
        `SELECT filename, image_base64 FROM receipts WHERE id = ${req.params.id}`
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'レシートが見つかりません' });
    }

    const row = result.rows[0];

    if (row.image_base64) {
        return res.json({ data: { image: row.image_base64 } });
    }

    // 旧システムのレシートはファイルサーバから配信する
    const legacyPath = path.join(LEGACY_RECEIPT_DIR, row.filename);
    const stream = fs.createReadStream(legacyPath);
    res.setHeader('Content-Type', 'image/jpeg');
    stream.pipe(res);
});

/* ############################################################################
 * ##
 * ##  承認フローAPI
 * ##
 * ##  申請の承認・却下・取り下げを行う。
 * ##  金額を予算枠に反映するため、申請と予算枠の両方を更新する。
 * ##
 * ######################################################################### */

/* ============================================================================
 *  申請の承認
 *  POST /api/reports/:id/approve
 * ========================================================================= */
app.post('/api/reports/:id/approve', async (req, res) => {
    const reportId = req.params.id;
    const approverId = req.body.approverId;

    if (!approverId) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: '承認者IDは必須です' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 申請を排他ロックして状態を確認する
        const reportRes = await client.query(
            'SELECT * FROM expense_reports WHERE id = $1 FOR UPDATE',
            [reportId]
        );
        if (reportRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: '申請が見つかりません' });
        }
        const report = reportRes.rows[0];

        // 承認者の権限を確認する（外部の権限サービスに問い合わせる想定）
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 予算枠を排他ロックして加算する
        const budgetRes = await client.query(
            'SELECT * FROM monthly_budgets WHERE user_id = $1 AND target_month = $2 FOR UPDATE',
            [report.user_id, report.target_month]
        );

        if (budgetRes.rows.length > 0) {
            const budget = budgetRes.rows[0];
            const newUsed = Util.toNumber(budget.used_amount) + Util.toNumber(report.total_amount);
            await client.query(
                'UPDATE monthly_budgets SET used_amount = $1, updated_at = NOW() WHERE id = $2',
                [newUsed, budget.id]
            );
        }

        await client.query(
            "UPDATE expense_reports SET status = 'approved', updated_at = NOW() WHERE id = $1",
            [reportId]
        );

        await client.query(
            "INSERT INTO approvals (report_id, approver_id, step, decision, comment) VALUES ($1, $2, 1, 'approved', $3)",
            [reportId, approverId, req.body.comment || null]
        );

        await client.query('COMMIT');

        writeAuditLog('APPROVE_REPORT', reportId, { approverId: approverId, reqId: req.reqId });

        res.json({ success: true, data: { reportId: Number(reportId), status: 'approved' } });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[APPROVE ERROR] reqId=${req.reqId} code=${err.code}`, err.message);

        res.status(500).json({ error: '混み合っています。しばらくしてからもう一度お試しください' });

        // 2023-08 追加: 一時的な競合であれば自動でリトライする
        if (err.code === '40P01') {
            setTimeout(() => {
                retryApprove(reportId, approverId, req, res);
            }, 120);
        }
    } finally {
        client.release();
    }
});

// 承認のリトライ処理（2023-08 追加）
async function retryApprove(reportId, approverId, req, res) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reportRes = await client.query(
            'SELECT * FROM expense_reports WHERE id = $1 FOR UPDATE',
            [reportId]
        );
        const report = reportRes.rows[0];
        const budgetRes = await client.query(
            'SELECT * FROM monthly_budgets WHERE user_id = $1 AND target_month = $2 FOR UPDATE',
            [report.user_id, report.target_month]
        );
        if (budgetRes.rows.length > 0) {
            const budget = budgetRes.rows[0];
            const newUsed = Util.toNumber(budget.used_amount) + Util.toNumber(report.total_amount);
            await client.query('UPDATE monthly_budgets SET used_amount = $1 WHERE id = $2', [
                newUsed,
                budget.id
            ]);
        }
        await client.query("UPDATE expense_reports SET status = 'approved' WHERE id = $1", [reportId]);
        await client.query('COMMIT');
        console.log(`[APPROVE RETRY OK] report=${reportId}`);
        res.json({ success: true, data: { reportId: Number(reportId), status: 'approved', retried: true } });
    } finally {
        client.release();
    }
}

/* ============================================================================
 *  申請の取り下げ
 *  POST /api/reports/:id/withdraw
 *
 *  2023-08 追加。承認済みの申請を申請者自身が取り下げる。
 *  予算枠から金額を戻す必要があるため、先に予算枠をロックする。
 * ========================================================================= */
app.post('/api/reports/:id/withdraw', async (req, res) => {
    const reportId = req.params.id;
    const userId = req.body.userId;

    if (!userId) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: '申請者IDは必須です' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 取り下げは予算枠の巻き戻しが主目的なので、先に予算枠をロックする
        const budgetRes = await client.query(
            `SELECT b.* FROM monthly_budgets b
             WHERE b.user_id = (SELECT user_id FROM expense_reports WHERE id = $1)
               AND b.target_month = (SELECT target_month FROM expense_reports WHERE id = $1)
             FOR UPDATE`,
            [reportId]
        );

        // 予算枠の再計算に時間がかかる
        await new Promise((resolve) => setTimeout(resolve, 80));

        // 申請をロックして状態を確認する
        const reportRes = await client.query(
            'SELECT * FROM expense_reports WHERE id = $1 FOR UPDATE',
            [reportId]
        );
        if (reportRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: '申請が見つかりません' });
        }
        const report = reportRes.rows[0];

        if (budgetRes.rows.length > 0) {
            const budget = budgetRes.rows[0];
            const newUsed = Util.toNumber(budget.used_amount) - Util.toNumber(report.total_amount);
            await client.query(
                'UPDATE monthly_budgets SET used_amount = $1, updated_at = NOW() WHERE id = $2',
                [newUsed, budget.id]
            );
        }

        await client.query(
            "UPDATE expense_reports SET status = 'draft', updated_at = NOW() WHERE id = $1",
            [reportId]
        );

        await client.query(
            "INSERT INTO approvals (report_id, approver_id, step, decision, comment) VALUES ($1, $2, 1, 'withdrawn', $3)",
            [reportId, userId, req.body.comment || null]
        );

        await client.query('COMMIT');

        writeAuditLog('WITHDRAW_REPORT', reportId, { userId: userId, reqId: req.reqId });

        res.json({ success: true, data: { reportId: Number(reportId), status: 'draft' } });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[WITHDRAW ERROR] reqId=${req.reqId} code=${err.code}`, err.message);
        res.status(500).json({ error: '混み合っています。しばらくしてからもう一度お試しください' });
    } finally {
        client.release();
    }
});

/* ============================================================================
 *  申請の却下
 *  POST /api/reports/:id/reject
 * ========================================================================= */
app.post('/api/reports/:id/reject', async (req, res) => {
    const reportId = req.params.id;
    const approverId = req.body.approverId;

    if (!approverId) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: '承認者IDは必須です' });
    }

    try {
        const reportRes = await pool.query(`SELECT * FROM expense_reports WHERE id = ${reportId}`);
        if (reportRes.rows.length === 0) {
            return res.status(404).json({ error: '申請が見つかりません' });
        }

        await pool.query(
            "UPDATE expense_reports SET status = 'NG', updated_at = NOW() WHERE id = $1",
            [reportId]
        );
        await pool.query(
            "INSERT INTO approvals (report_id, approver_id, step, decision, comment) VALUES ($1, $2, 1, 'rejected', $3)",
            [reportId, approverId, req.body.comment || null]
        );

        writeAuditLog('REJECT_REPORT', reportId, { approverId: approverId, reqId: req.reqId });

        res.json({ success: true, data: { reportId: Number(reportId), status: 'NG' } });
    } catch (err) {
        console.error(`[REJECT ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '却下に失敗しました' });
    }
});

/* ############################################################################
 * ##
 * ##  集計・出力API
 * ##
 * ######################################################################### */

/* ============================================================================
 *  月次集計
 *  GET /api/summary/:userId/:month
 *
 *  経理部が月末に使う画面。申請一覧・レシートの添付状況・
 *  カテゴリ別の合計を1回のリクエストで返す。
 * ========================================================================= */
app.get('/api/summary/:userId/:month', async (req, res) => {
    try {
        const { userId, month } = req.params;

        const reports = await pool.query(
            `SELECT * FROM expense_reports WHERE user_id = ${userId} AND target_month = '${month}' ORDER BY id ASC`
        );

        const byCategory = {};
        let grandTotal = 0;
        let receiptBytes = 0;
        const detail = [];

        for (const report of reports.rows) {
            const items = await pool.query(
                `SELECT * FROM expense_items WHERE report_id = ${report.id}`
            );
            const receipts = await pool.query(
                `SELECT * FROM receipts WHERE report_id = ${report.id}`
            );

            // レシートの実サイズを集計する（添付漏れ・巨大ファイルの検出用）
            for (const receipt of receipts.rows) {
                if (receipt.image_base64) {
                    const decoded = Buffer.from(receipt.image_base64.split(',')[1] || '', 'base64');
                    receiptBytes += decoded.length;
                    // 破損チェックも兼ねてチェックサムを再計算する
                    parseExifSync(decoded);
                }
            }

            const cat = report.category || 'unknown';
            if (!byCategory[cat]) {
                byCategory[cat] = { count: 0, total: 0 };
            }
            byCategory[cat].count++;
            byCategory[cat].total += Util.toNumber(report.total_amount);
            grandTotal += Util.toNumber(report.total_amount);

            detail.push({
                reportId: report.id,
                title: report.title,
                category: report.category,
                status: report.status,
                total: Util.toNumber(report.total_amount),
                itemCount: items.rows.length,
                receiptCount: receipts.rows.length
            });
        }

        res.json({
            meta: { userId: Number(userId), month: month, reqId: req.reqId },
            data: {
                grandTotal: grandTotal,
                receiptBytes: receiptBytes,
                byCategory: byCategory,
                reports: detail
            }
        });
    } catch (err) {
        console.error(`[SUMMARY ERROR] reqId=${req.reqId}`, err.message);
        res.status(500).json({ error: '集計に失敗しました' });
    }
});

/* ============================================================================
 *  CSV出力
 *  GET /api/export/:month
 * ========================================================================= */
app.get('/api/export/:month', async (req, res) => {
    try {
        const month = req.params.month;
        const reports = await pool.query(
            `SELECT * FROM expense_reports WHERE target_month = '${month}' ORDER BY id ASC`
        );

        let csv = 'report_id,user_id,title,category,status,subtotal,tax,total\n';
        for (const r of reports.rows) {
            const user = await pool.query(`SELECT name FROM users WHERE id = ${r.user_id}`);
            csv += [
                r.id,
                r.user_id,
                (user.rows[0] ? user.rows[0].name : ''),
                r.category,
                r.status,
                r.subtotal_amount,
                r.tax_amount,
                r.total_amount
            ].join(',') + '\n';
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ error: 'CSV出力に失敗しました' });
    }
});

/* ============================================================================
 *  起動
 * ========================================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[BOOT] Kessai Expense System v1.4.2 listening on port ${PORT}`);
});

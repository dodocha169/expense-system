/* ============================================================================
 *  一覧・集計・CSV出力の応答内容の特性テスト
 *
 *  対象: INQ-001（月末になると画面がすごく遅くなります）
 *
 *  N+1 と SELECT * を解消するにあたり、
 *  【応答の中身が変わっていないこと】を先に固定する。
 *  性能改善で内容が変わってしまえば、それは改善ではなく破壊である。
 *
 *  SELECT * をやめると receipts から画像データ（base64）が落ちるため、
 *  レシート要素のキー集合は意図的に変わる。それも固定して可視化する。
 *
 *  注意:
 *    期待値は「あるべき値」ではなく【計測した現在の値】を入れてある。
 *
 *  実行: bash test/run.sh
 * ========================================================================= */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TAG = 'listresp';
const MONTH = '2026-12';          // 既存データと混ざらない月を使う
const USER_ID = 40;

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const psqlValue = (q) => psql(q).split('\n')[0].trim();

async function getJson(url) {
    const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(120000) });
    return { status: res.status, json: await res.json() };
}
async function getText(url) {
    const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(120000) });
    return { status: res.status, text: await res.text() };
}

const observed = {};
let ids = [];

before(async () => {
    // ---- 検体を作る -----------------------------------------------------
    // 申請3件。明細はそれぞれ2件、レシートは1件目に2枚・2件目に1枚。
    psql(`DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
    ids = [];
    for (let i = 1; i <= 3; i++) {
        const id = psqlValue(
            `INSERT INTO expense_reports
               (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
             VALUES (${USER_ID}, '${TAG}-${i}', 'transport', 'approved', ${1000 * i}, ${100 * i}, ${1100 * i}, '${MONTH}')
             RETURNING id;`
        );
        ids.push(Number(id));
        psql(`INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
              VALUES (${id}, 'a', 500, 1, 500), (${id}, 'b', 500, 1, 500);`);
    }
    // レシート: 1件目に2枚、2件目に1枚。base64の長さを揃えて receiptBytes を確定させる
    const b64 = Buffer.alloc(300, 7).toString('base64');       // 300バイト -> base64
    psql(`INSERT INTO receipts (report_id, filename, mime_type, image_base64, thumb_base64, exif_json, byte_size)
          VALUES (${ids[0]}, 'r1.jpg', 'image/jpeg', 'data:image/jpeg;base64,${b64}', 'data:image/jpeg;base64,${b64}', '{}', 300),
                 (${ids[0]}, 'r2.jpg', 'image/jpeg', 'data:image/jpeg;base64,${b64}', 'data:image/jpeg;base64,${b64}', '{}', 300),
                 (${ids[1]}, 'r3.jpg', 'image/jpeg', 'data:image/jpeg;base64,${b64}', 'data:image/jpeg;base64,${b64}', '{}', 300);`);
    psql(`INSERT INTO approvals (report_id, approver_id, step, decision)
          VALUES (${ids[0]}, 8, 1, 'approved');`);

    // ---- 応答を採取する -------------------------------------------------
    const list = await getJson('/api/reports?limit=100');
    const byId = new Map(list.json.data.map((r) => [r.id, r]));
    observed.list = ids.map((id) => {
        const r = byId.get(id);
        return r ? {
            items: r.items.length,
            receipts: r.receipts.length,
            approvals: r.approvals.length,
            hasReceipt: r.hasReceipt,
            subtotal: r.subtotal_amount,
            receiptKeys: r.receipts[0] ? Object.keys(r.receipts[0]).sort() : null
        } : null;
    });

    const summary = await getJson(`/api/summary/${USER_ID}/${MONTH}`);
    observed.summary = {
        grandTotal: summary.json.data.grandTotal,
        receiptBytes: summary.json.data.receiptBytes,
        byCategory: summary.json.data.byCategory,
        reports: summary.json.data.reports
            .filter((r) => ids.includes(r.reportId))
            .map((r) => ({ itemCount: r.itemCount, receiptCount: r.receiptCount, total: r.total }))
    };

    observed.userName = psqlValue(`SELECT name FROM users WHERE id = ${USER_ID};`);
    const csv = await getText(`/api/export/${MONTH}`);
    observed.csv = {
        header: csv.text.split('\n')[0],
        lines: csv.text.split('\n').filter((l) => ids.some((id) => l.startsWith(`${id},`))).sort()
    };

    console.log('  観測値:', JSON.stringify(observed));
});

after(() => {
    psql(`DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
});

// ---------------------------------------------------------------------------
// 【不変】性能改善で変わってはいけない応答内容
// ---------------------------------------------------------------------------

test('[不変] 一覧が返す明細・レシート・承認履歴の件数', () => {
    assert.deepEqual(
        observed.list.map((r) => [r.items, r.receipts, r.approvals]),
        [[2, 2, 1], [2, 1, 0], [2, 0, 0]]
    );
});

test('[不変] 一覧の hasReceipt と金額', () => {
    assert.deepEqual(observed.list.map((r) => r.hasReceipt), [true, true, false]);
    assert.deepEqual(observed.list.map((r) => r.subtotal), ['1000.00', '2000.00', '3000.00']);
});

test('[不変] 月次集計の合計・カテゴリ別・件数', () => {
    assert.equal(observed.summary.grandTotal, 6600);
    assert.deepEqual(observed.summary.byCategory, { transport: { count: 3, total: 6600 } });
    assert.deepEqual(observed.summary.reports, [
        { itemCount: 2, receiptCount: 2, total: 1100 },
        { itemCount: 2, receiptCount: 1, total: 2200 },
        { itemCount: 2, receiptCount: 0, total: 3300 }
    ]);
});

test('[不変] 月次集計の receiptBytes（レシート3枚 × 300バイト）', () => {
    assert.equal(observed.summary.receiptBytes, 900);
});

/*  ★ 注意（別論点の未対応事項）
 *  見出しは title だが、3列目に入っているのは【社員名】である。
 *  給与システムへの連携ファイルなので、内容を変えると影響が及ぶ。
 *  性能改善では現在の出力をそのまま維持する必要があるため、
 *  社員名が入っている状態を期待値として固定している。
 */
test('[不変] CSV出力の見出しと明細行（3列目は社員名。見出しとの不一致は別論点）', () => {
    assert.equal(observed.csv.header, 'report_id,user_id,title,category,status,subtotal,tax,total');
    assert.deepEqual(observed.csv.lines, [
        `${ids[0]},${USER_ID},${observed.userName},transport,approved,1000.00,100.00,1100.00`,
        `${ids[1]},${USER_ID},${observed.userName},transport,approved,2000.00,200.00,2200.00`,
        `${ids[2]},${USER_ID},${observed.userName},transport,approved,3000.00,300.00,3300.00`
    ].sort());
});

// ---------------------------------------------------------------------------
// 【修正の検証】SELECT * をやめたことで応答から画像データが外れた
//
//   修正前は image_base64 / thumb_base64 も含まれており、
//   一覧では添付の有無しか使わないのに画像本体を毎回読み込んでいた。
//   画像が必要な場合は GET /api/receipts/:id/thumb または /raw を使う。
//
//   ★ これは応答内容の変更である。一覧から画像を読んでいた外部利用が
//     あれば影響を受ける（DECISIONS.md 参照）。
// ---------------------------------------------------------------------------

test('一覧のレシートから画像データ（base64）が外れ、メタ情報のみになる', () => {
    assert.deepEqual(observed.list[0].receiptKeys, [
        'byte_size', 'created_at', 'exif_json', 'filename',
        'id', 'mime_type', 'report_id'
    ]);
});

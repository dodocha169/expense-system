/* ============================================================================
 *  INQ-001 の計測（一覧・月次集計・CSV出力）
 *    「月末になると経費精算の画面がすごく遅くなります」
 *
 *  N+1（一覧が1件ごとに3クエリを発行）と SELECT *（使わない画像データまで
 *  読み込む）の影響を測る。実運用に近づけるため、一覧の先頭に来る申請に
 *  レシートを添付した状態で計測する。
 *
 *  検体は毎回同じ条件で作り直すので、改修前後で比較できる。
 *  使い方: node test/measure-inq001.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TAG = 'inq001fixture';
const USER_ID = 1;
const MONTH = '2026-07';
const REPORTS = 20;
const KB = 800;                       // レシート1枚あたりの base64 長（約800KB）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();

async function waitForHealth(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return; } catch { await sleep(300); }
    }
}

/** 検体を作り直す。md5を連結して圧縮の効かない文字列を作る */
function setupFixture() {
    // 外部キー制約が無いため、申請を削除しても明細・レシートは残る。
    // 前回の検体が孤児として残ると計測条件が変わるので、明示的に消す。
    psql(`DELETE FROM expense_items WHERE report_id IN
            (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM receipts WHERE report_id IN
            (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
    // 過去の実行で取り残された孤児も掃除する
    psql(`DELETE FROM receipts WHERE filename = 'perf.jpg'
            AND report_id NOT IN (SELECT id FROM expense_reports);`);
    psql(`DELETE FROM expense_items WHERE report_id NOT IN (SELECT id FROM expense_reports);`);
    psql('VACUUM receipts;');
    psql(`
        INSERT INTO expense_reports
          (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
        SELECT ${USER_ID}, '${TAG}-' || g, 'transport', 'approved', 10000, 1000, 11000, '${MONTH}'
        FROM generate_series(1, ${REPORTS}) AS g;`);
    // 明細を3件ずつ
    psql(`
        INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
        SELECT r.id, '明細' || g, 3333, 1, 3333
        FROM expense_reports r CROSS JOIN generate_series(1, 3) AS g
        WHERE r.title LIKE '${TAG}%';`);
    // レシートを1枚ずつ（表示用・サムネイルの2本を持つ現状の構造どおり）
    const chunks = Math.ceil((KB * 1024) / 32);
    psql(`
        INSERT INTO receipts (report_id, filename, mime_type, image_base64, thumb_base64, exif_json, byte_size)
        SELECT r.id, 'perf.jpg', 'image/jpeg',
               'data:image/jpeg;base64,' || (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, ${chunks})),
               'data:image/jpeg;base64,' || (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, ${Math.ceil(chunks / 10)})),
               '{}', ${KB * 1024}
        FROM expense_reports r WHERE r.title LIKE '${TAG}%';`);
    psql('ANALYZE receipts; ANALYZE expense_items; ANALYZE expense_reports;');
}

async function timed(url, runs = 3) {
    const ts = [];
    for (let i = 0; i < runs; i++) {
        const t = Date.now();
        try {
            const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(300000) });
            await res.text();
        } catch { return null; }
        ts.push(Date.now() - t);
    }
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
}

/** 1リクエストで発行されるSQL文の数を数える */
function queryCountOf(label) {
    return Number(psql(
        `SELECT COALESCE(SUM(calls), 0) FROM pg_stat_statements WHERE query LIKE '%${label}%';`
    ).split('\n')[0] || 0);
}

(async () => {
    console.log('=== INQ-001 計測（一覧・月次集計・CSV出力）===\n');
    await waitForHealth();

    console.log(`検体を作成: 申請${REPORTS}件 / 明細各3件 / レシート各1枚（約${KB}KB × 2本）`);
    setupFixture();
    console.log(`  receipts テーブル: ${psql("SELECT pg_size_pretty(pg_total_relation_size('receipts'));")}\n`);

    const targets = [
        ['GET /api/reports?limit=20', '/api/reports?limit=20'],
        ['GET /api/reports?limit=50', '/api/reports?limit=50'],
        ['GET /api/reports?limit=100', '/api/reports?limit=100'],
        [`GET /api/summary/${USER_ID}/${MONTH}`, `/api/summary/${USER_ID}/${MONTH}`],
        [`GET /api/export/${MONTH}`, `/api/export/${MONTH}`]
    ];

    console.log('--- 応答時間（各3回の中央値）---');
    for (const [label, url] of targets) {
        const ms = await timed(url);
        console.log(`  ${label.padEnd(32)} ${ms === null ? '失敗' : ms + 'ms'}`);
    }

    console.log('\n--- 応答サイズ ---');
    for (const [label, url] of targets) {
        try {
            const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(300000) });
            const text = await res.text();
            console.log(`  ${label.padEnd(32)} ${(text.length / 1024).toFixed(1)} KB`);
        } catch { console.log(`  ${label.padEnd(32)} 失敗`); }
    }

    console.log('\n検体は残してあります（改修後に同じ条件で再計測するため）。');
    console.log(`削除する場合: DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
})();

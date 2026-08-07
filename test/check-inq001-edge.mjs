/* ============================================================================
 *  INQ-001 の対応で導入した処理の境界条件チェック
 *
 *  N+1 / SELECT * の解消で以下を変更した。想定外の入力で壊れないか確認する。
 *    - 一覧: WHERE report_id = ANY($1) でまとめ取り
 *    - 月次集計: SUM(octet_length(decode(split_part(image_base64, ',', 2), 'base64')))
 *               ※ PostgreSQL の decode() は不正な base64 で例外を投げる。
 *                 変更前の Buffer.from(x,'base64') は不正文字を黙って無視していた
 *    - CSV出力: users を LEFT JOIN
 *
 *  使い方: node test/check-inq001-edge.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TAG = 'edgecheck';
const USER_ID = 39;
const MONTH = '2026-11';

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const psqlValue = (q) => psql(q).split('\n')[0].trim();

async function call(label, url) {
    try {
        const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(60000) });
        const text = await res.text();
        let detail = `${text.length}文字`;
        try {
            const j = JSON.parse(text);
            if (Array.isArray(j.data)) detail = `${j.data.length}件`;
            else if (j.data?.reports) detail = `申請${j.data.reports.length}件 receiptBytes=${j.data.receiptBytes}`;
            else if (j.error) detail = `error=${j.error}`;
        } catch { /* CSV */ }
        const ng = res.status !== 200;
        console.log(`  ${ng ? '★' : ' '} ${label.padEnd(46)} HTTP ${res.status}  ${detail}`);
        return res.status;
    } catch (e) {
        console.log(`  ★ ${label.padEnd(46)} 失敗: ${e.message}`);
        return 0;
    }
}

// 後片付け（外部キーが無いので明細・レシートも明示的に消す）
function cleanup() {
    psql(`DELETE FROM receipts WHERE report_id IN (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM expense_items WHERE report_id IN (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
}

console.log('=== INQ-001 の境界条件チェック ===\n');
cleanup();

console.log('--- 一覧: 結果が0件になる条件 ---');
await call('limit=0（reportIds が空配列になる）', '/api/reports?limit=0');
await call('存在しない status で0件', '/api/reports?status=nosuchstatus&limit=10');
await call('存在しない userId で0件', '/api/reports?userId=99999&limit=10');

console.log('\n--- 月次集計: 対象0件 ---');
await call('申請が1件も無い月', `/api/summary/${USER_ID}/1999-01`);

console.log('\n--- 月次集計: レシートの image_base64 が異常な値 ---');
const rid = psqlValue(
    `INSERT INTO expense_reports (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
     VALUES (${USER_ID}, '${TAG}-1', 'transport', 'approved', 1000, 100, 1100, '${MONTH}') RETURNING id;`
);
const cases = [
    ['NULL', 'NULL'],
    ['空文字', `''`],
    ['カンマ無し（data URI ではない）', `'AAAA'`],
    ['プレフィックスのみ（本体が空）', `'data:image/jpeg;base64,'`],
    ['base64として不正な文字を含む', `'data:image/jpeg;base64,!!!!'`],
    ['長さが4の倍数でない', `'data:image/jpeg;base64,AAA'`]
];
for (const [label, value] of cases) {
    psql(`DELETE FROM receipts WHERE report_id = ${rid};`);
    psql(`INSERT INTO receipts (report_id, filename, mime_type, image_base64, byte_size)
          VALUES (${rid}, 'x.jpg', 'image/jpeg', ${value}, 100);`);
    await call(`image_base64 = ${label}`, `/api/summary/${USER_ID}/${MONTH}`);
}

console.log('\n--- 一覧: 同じレシートを含む申請の取得 ---');
await call('一覧に上記の申請が含まれる', '/api/reports?limit=100');

console.log('\n--- CSV出力: 存在しない user_id を参照する申請（LEFT JOIN の確認）---');
psql(`UPDATE expense_reports SET user_id = 99999 WHERE id = ${rid};`);
await call('社員マスタに無い user_id', `/api/export/${MONTH}`);
console.log('     出力行: ' + (await (await fetch(`${BASE}/api/export/${MONTH}`)).text()).split('\n')[1]);

cleanup();
console.log('\n検体を削除しました。★が付いた行があれば要確認です。');

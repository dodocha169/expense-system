/* ============================================================================
 *  正常系の疎通確認（スモークテスト）
 *
 *  SQLインジェクション対策で多数のクエリを書き換えたため、
 *  主要な経路が壊れていないことを一通り確認する。
 *  合否ではなく応答内容を並べて目視できるようにしてある。
 *
 *  使い方: node test/smoke.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TAG = `smoke-${Date.now()}`;

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psqlValue = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q)
        .trim().split('\n')[0].trim();

async function call(label, method, url, body) {
    try {
        const res = await fetch(`${BASE}${url}`, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(60000)
        });
        const text = await res.text();
        let summary = `${text.length}文字`;
        try {
            const j = JSON.parse(text);
            if (Array.isArray(j.data)) summary = `${j.data.length}件`;
            else if (j.data?.reports) summary = `申請${j.data.reports.length}件 合計${j.data.grandTotal}`;
            else if (j.data?.reportId) summary = `id=${j.data.reportId} 状態=${j.data.status} 合計=${j.data.total}`;
            else if (j.data?.status) summary = `状態=${j.data.status}`;
            else if (j.error) summary = `${j.error}`;
        } catch { /* CSV */ }
        console.log(`  ${label.padEnd(34)} HTTP ${res.status}  ${summary}`);
        return { status: res.status, text };
    } catch (e) {
        console.log(`  ${label.padEnd(34)} 失敗: ${e.message}`);
        return { status: 0, text: '' };
    }
}

const item = [{ description: '明細', unitPrice: 1000, qty: 1 }];

console.log('=== 参照系 ===');
await call('社員一覧', 'GET', '/api/users');
await call('社員一覧（部署絞り込み）', 'GET', `/api/users?department=${encodeURIComponent('営業部')}`);
await call('申請一覧', 'GET', '/api/reports?limit=10');
await call('申請一覧（userId絞り込み）', 'GET', '/api/reports?userId=1&limit=10');
await call('申請一覧（status絞り込み）', 'GET', '/api/reports?status=submitted&limit=10');
await call('申請詳細', 'GET', '/api/reports/1');
await call('予算枠照会', 'GET', '/api/budgets/1');
await call('月次集計', 'GET', '/api/summary/1/2026-07');
const csv = await call('CSV出力', 'GET', '/api/export/2026-07');
console.log(`     CSV先頭行: ${csv.text.split('\n')[0]}`);

console.log('\n=== 申請の登録（全カテゴリ）===');
const created = {};
for (const cat of ['transport', 'lodging', 'entertainment', 'goods', 'other', 'commuter', 'training']) {
    const body = { userId: 1, title: `${TAG}-${cat}`, targetMonth: '2026-07', attendeeCount: 2, items: item };
    const r = await call(cat, 'POST', `/api/reports/${cat}`, body);
    try { created[cat] = JSON.parse(r.text)?.data?.reportId; } catch { /* noop */ }
}

console.log('\n=== 承認フロー ===');
const target = psqlValue(
    `INSERT INTO expense_reports (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
     VALUES (1, '${TAG}-approve', 'transport', 'submitted', 10000, 1000, 11000, '2026-07') RETURNING id;`
);
await call(`承認 id=${target}`, 'POST', `/api/reports/${target}/approve`, { approverId: 8 });
await call(`取り下げ id=${target}`, 'POST', `/api/reports/${target}/withdraw`, { userId: 1 });
await call(`却下 id=${target}`, 'POST', `/api/reports/${target}/reject`, { approverId: 8 });

console.log('\n=== レシート ===');
const img = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');
const up = await call('アップロード', 'POST', '/api/receipts/upload', { reportId: 1, filename: 's.jpg', imageBase64: img });
let rid = null;
try { rid = JSON.parse(up.text)?.data?.receiptId; } catch { /* noop */ }
if (rid) {
    await call(`サムネイル id=${rid}`, 'GET', `/api/receipts/${rid}/thumb`);
    await call(`原本 id=${rid}`, 'GET', `/api/receipts/${rid}/raw`);
}

console.log('\n=== 142行目 recalcSubtotalAsync の注入可否 ===');
console.log('  単価に文字列を渡す（Util.toNumber で NaN になるため注入は成立しないはず）');
await call('unitPrice に SQL断片', 'POST', '/api/reports/transport', {
    userId: 1, title: `${TAG}-inject`, targetMonth: '2026-07',
    items: [{ description: 'x', unitPrice: "1); DROP TABLE t_system_flags--", qty: 1 }]
});
console.log(`  t_system_flags の行数: ${psqlValue('SELECT COUNT(*) FROM t_system_flags;')}（3なら無事）`);

console.log('\n後片付け');
compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc',
    `DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
console.log('  検体を削除しました。');

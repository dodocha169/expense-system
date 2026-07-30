/* ============================================================================
 *  索引を追加した場合の書き込みコストの計測
 *
 *  前回は1回だけの測定でノイズに埋もれたため、
 *  索引の有無を交互に切り替えて複数回測り、中央値で比較する。
 *
 *  使い方: node test/measure-index-write.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS = 5;
const BATCH = 3000;

const psql = (q) =>
    execFileSync('docker',
        ['compose', 'exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q],
        { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const INDEXES = [
    ['idx_expense_items_report_id', 'expense_items(report_id)'],
    ['idx_receipts_report_id', 'receipts(report_id)'],
    ['idx_approvals_report_id', 'approvals(report_id)'],
    ['idx_expense_reports_user_month', 'expense_reports(user_id, target_month)'],
    ['idx_expense_reports_target_month', 'expense_reports(target_month)'],
    ['idx_monthly_budgets_user_month', 'monthly_budgets(user_id, target_month)']
];

const createAll = () => INDEXES.forEach(([n, d]) => psql(`CREATE INDEX IF NOT EXISTS ${n} ON ${d};`));
const dropAll = () => INDEXES.forEach(([n]) => psql(`DROP INDEX IF EXISTS ${n};`));

/** 明細を BATCH 件INSERTする時間。EXPLAIN ANALYZE はINSERTを実際に実行する */
function insertMs() {
    const out = psql(
        `EXPLAIN (ANALYZE, TIMING OFF)
         INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
         SELECT 1, 'wtest', 100, 1, 100 FROM generate_series(1, ${BATCH});`
    );
    const m = out.match(/Execution Time: ([\d.]+) ms/);
    psql("DELETE FROM expense_items WHERE description = 'wtest';");
    return m ? Number(m[1]) : null;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log('=== 索引の有無による書き込みコストの比較 ===');
console.log(`明細 ${BATCH}件のINSERTを、索引あり/なしで交互に ${ROUNDS} 回ずつ測定\n`);

dropAll();
const without = [], with_ = [];

for (let i = 1; i <= ROUNDS; i++) {
    dropAll();
    const a = insertMs();
    createAll();
    const b = insertMs();
    without.push(a); with_.push(b);
    console.log(`  ${i}回目  索引なし ${String(a).padStart(8)}ms   索引あり ${String(b).padStart(8)}ms`);
}

dropAll();

const mw = median(without), mi = median(with_);
console.log(`\n  中央値  索引なし ${mw}ms   索引あり ${mi}ms`);
console.log(`  倍率    ${(mi / mw).toFixed(2)}倍   1件あたりの増加 ${((mi - mw) / BATCH).toFixed(4)}ms`);
console.log('\n索引は削除済み。DBは調査前の状態です。');

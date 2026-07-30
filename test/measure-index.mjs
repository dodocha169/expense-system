/* ============================================================================
 *  索引追加の影響調査（INQ-001 / INQ-002）
 *
 *  db/init.sql には
 *    「本番でCREATE INDEXを流すと止まるので次のメンテ時に」と
 *    引き継がれたまま5年経過している
 *  というコメントがある。この判断材料を揃える。
 *
 *  測るもの:
 *    1. 索引を作る前後の実行計画（Seq Scan が消えるか）
 *    2. 索引の作成時間とサイズ
 *    3. APIの応答時間
 *    4. 書き込み性能への影響（索引の維持コスト）
 *
 *  ※ 調査目的のため、測定後に作成した索引を削除して元の状態に戻す。
 *  使い方: node test/measure-index.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();

/** 追加を検討している索引。コード上のWHERE句から導出したもの */
const INDEXES = [
    ['idx_expense_items_report_id', 'expense_items(report_id)'],
    ['idx_receipts_report_id', 'receipts(report_id)'],
    ['idx_approvals_report_id', 'approvals(report_id)'],
    ['idx_expense_reports_user_month', 'expense_reports(user_id, target_month)'],
    ['idx_expense_reports_target_month', 'expense_reports(target_month)'],
    ['idx_monthly_budgets_user_month', 'monthly_budgets(user_id, target_month)']
];

/** 一覧APIが1件ごとに実行するクエリなど、効果を見たいもの */
const PLAN_QUERIES = [
    ['明細の取得（一覧が1件ごとに実行）', 'SELECT * FROM expense_items WHERE report_id = 3000'],
    ['月次集計の対象抽出', "SELECT * FROM expense_reports WHERE user_id = 1 AND target_month = '2026-07'"],
    ['CSV出力の対象抽出', "SELECT * FROM expense_reports WHERE target_month = '2026-07'"],
    ['予算枠の照会', "SELECT * FROM monthly_budgets WHERE user_id = 1 AND target_month = '2026-07'"]
];

/** EXPLAIN の1行目（走査方法）と実行時間を取り出す */
function plan(sql) {
    const out = psql(`EXPLAIN (ANALYZE, TIMING ON) ${sql};`);
    const lines = out.split('\n');
    const scan = (lines[0] || '').trim().replace(/\s+\(cost.*/, '');
    const time = (out.match(/Execution Time: ([\d.]+) ms/) || [])[1];
    return { scan, time };
}

async function timedGet(url) {
    const t = Date.now();
    try {
        const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(120000) });
        await res.text();
        return Date.now() - t;
    } catch { return -1; }
}

/** 一覧・集計APIの応答時間（各3回の中央値） */
async function apiTimes() {
    const out = {};
    for (const [label, url] of [
        ['GET /api/reports?limit=20', '/api/reports?limit=20'],
        ['GET /api/reports?limit=100', '/api/reports?limit=100'],
        ['GET /api/summary/1/2026-07', '/api/summary/1/2026-07'],
        ['GET /api/export/2026-07', '/api/export/2026-07']
    ]) {
        const ts = [];
        for (let i = 0; i < 3; i++) ts.push(await timedGet(url));
        ts.sort((a, b) => a - b);
        out[label] = ts[1];
    }
    return out;
}

/** 書き込み性能: 明細を500件INSERTする時間 */
function writeCost() {
    const t = Date.now();
    psql(`INSERT INTO expense_items (report_id, description, unit_price, qty, amount)
          SELECT 1, 'idxtest', 100, 1, 100 FROM generate_series(1, 500);`);
    const ms = Date.now() - t;
    psql("DELETE FROM expense_items WHERE description = 'idxtest';");
    return ms;
}

(async () => {
    console.log('=== 索引追加の影響調査 ===\n');
    console.log(`対象データ量: expense_reports ${psql('SELECT COUNT(*) FROM expense_reports;')}件 / ` +
                `expense_items ${psql('SELECT COUNT(*) FROM expense_items;')}件\n`);

    // ---------------- 追加前 ----------------
    console.log('--- 追加前：実行計画 ---');
    const before = {};
    for (const [label, sql] of PLAN_QUERIES) {
        before[label] = plan(sql);
        console.log(`  ${label.padEnd(32)} ${before[label].scan.padEnd(46)} ${before[label].time}ms`);
    }
    const apiBefore = await apiTimes();
    const writeBefore = writeCost();

    // ---------------- 索引の作成 ----------------
    console.log('\n--- 索引の作成（作成時間とサイズ）---');
    let totalMs = 0;
    for (const [name, def] of INDEXES) {
        const t = Date.now();
        psql(`CREATE INDEX ${name} ON ${def};`);
        const ms = Date.now() - t;
        totalMs += ms;
        const size = psql(`SELECT pg_size_pretty(pg_relation_size('${name}'));`);
        console.log(`  ${name.padEnd(34)} ${String(ms + 'ms').padStart(8)}  ${size}`);
    }
    psql('ANALYZE;');
    console.log(`  合計 ${totalMs}ms`);

    // ---------------- 追加後 ----------------
    console.log('\n--- 追加後：実行計画 ---');
    for (const [label, sql] of PLAN_QUERIES) {
        const a = plan(sql);
        const b = before[label];
        const speed = b.time && a.time ? ` (${(b.time / a.time).toFixed(1)}倍)` : '';
        console.log(`  ${label.padEnd(32)} ${a.scan.padEnd(46)} ${a.time}ms${speed}`);
    }
    const apiAfter = await apiTimes();
    const writeAfter = writeCost();

    console.log('\n--- APIの応答時間（中央値）---');
    for (const k of Object.keys(apiBefore)) {
        const b = apiBefore[k], a = apiAfter[k];
        const r = b > 0 && a > 0 ? `${(b / a).toFixed(1)}倍` : '-';
        console.log(`  ${k.padEnd(28)} ${String(b + 'ms').padStart(8)} -> ${String(a + 'ms').padStart(8)}  ${r}`);
    }

    console.log('\n--- 書き込み性能（明細500件のINSERT）---');
    console.log(`  ${writeBefore}ms -> ${writeAfter}ms  (差 ${writeAfter - writeBefore}ms)`);

    console.log('\n--- 索引の総サイズ ---');
    console.log('  ' + psql(
        `SELECT string_agg(c.relname || ': ' || pg_size_pretty(pg_indexes_size(c.oid)), ' / ')
         FROM pg_class c WHERE c.relkind='r' AND c.relname IN ('expense_items','expense_reports','monthly_budgets','receipts','approvals');`
    ));

    // ---------------- 元に戻す ----------------
    console.log('\n--- 調査のため作成した索引を削除 ---');
    for (const [name] of INDEXES) psql(`DROP INDEX ${name};`);
    psql('ANALYZE;');
    console.log('  削除しました。DBは調査前の状態に戻っています。');
})();

/* ============================================================================
 *  CREATE INDEX がどれだけ書き込みを止めるかの実験
 *
 *  db/init.sql のコメント
 *    「本番でCREATE INDEXを流すと止まるので次のメンテ時に」
 *  の真偽と、CONCURRENTLY を使った場合の差を確かめる。
 *
 *  索引作成が一瞬で終わると差が観測できないため、
 *  専用の大きなテーブルを作って実験し、終わったら削除する。
 *  既存テーブルには一切触らない。
 *
 *  使い方: node test/measure-index-lock.mjs
 * ========================================================================= */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROWS = 3_000_000;   // 索引作成に数秒かかる程度の量

const args = (q) => ['compose', 'exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q];
const psql = (q) =>
    execFileSync('docker', args(q), { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const psqlAsync = (q) =>
    execFileAsync('docker', args(q), { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 索引作成中に INSERT を試み、待たされた時間を測る */
async function trial(label, createSql) {
    psql('DROP INDEX IF EXISTS idx_locktest_v;');

    const buildStart = Date.now();
    const build = psqlAsync(createSql);          // 待たずに走らせる

    await sleep(400);                            // 作成が始まるのを待つ

    // 作成中に書き込みを試みる
    const writeStart = Date.now();
    await psqlAsync("INSERT INTO t_locktest (v) VALUES (999999);");
    const writeMs = Date.now() - writeStart;

    await build;
    const buildMs = Date.now() - buildStart;

    console.log(`  ${label.padEnd(30)} 索引作成 ${String(buildMs + 'ms').padStart(8)}   ` +
                `作成中のINSERT ${String(writeMs + 'ms').padStart(8)}   ` +
                `${writeMs > buildMs * 0.4 ? '★書き込みが待たされた' : '書き込みは通った'}`);
    return { buildMs, writeMs };
}

(async () => {
    console.log('=== CREATE INDEX が書き込みを止めるかの実験 ===\n');
    console.log(`実験用テーブルを作成します（${ROWS.toLocaleString()}行）。既存テーブルには触りません。`);

    psql('DROP TABLE IF EXISTS t_locktest;');
    psql('CREATE TABLE t_locktest (id SERIAL PRIMARY KEY, v INTEGER);');
    const t = Date.now();
    psql(`INSERT INTO t_locktest (v) SELECT (random()*1000000)::int FROM generate_series(1, ${ROWS});`);
    console.log(`  投入完了 ${Date.now() - t}ms  サイズ ${psql("SELECT pg_size_pretty(pg_relation_size('t_locktest'));")}\n`);

    console.log('--- 実験結果 ---');
    const normal = await trial('CREATE INDEX', 'CREATE INDEX idx_locktest_v ON t_locktest(v);');
    const conc = await trial('CREATE INDEX CONCURRENTLY', 'CREATE INDEX CONCURRENTLY idx_locktest_v ON t_locktest(v);');

    console.log('\n--- 取得されるロック（PostgreSQLの仕様）---');
    console.log('  CREATE INDEX              : SHARE ロック。読み取りは可、書き込みは待たされる');
    console.log('  CREATE INDEX CONCURRENTLY : SHARE UPDATE EXCLUSIVE ロック。書き込みも通る');

    console.log('\n--- 比較 ---');
    console.log(`  作成時間        : ${normal.buildMs}ms -> ${conc.buildMs}ms （CONCURRENTLY は ${(conc.buildMs / normal.buildMs).toFixed(1)}倍）`);
    console.log(`  作成中のINSERT  : ${normal.writeMs}ms -> ${conc.writeMs}ms`);

    console.log('\n--- 後片付け ---');
    psql('DROP TABLE IF EXISTS t_locktest;');
    console.log('  実験用テーブルを削除しました。');
})();

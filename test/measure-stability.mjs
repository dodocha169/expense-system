/* ============================================================================
 *  安定性の計測（INQ-003 の改修前後を同じ方法で比較するため）
 *
 *  測るもの:
 *    - リクエストの成否内訳（HTTP200 / HTTPエラー / 接続断）
 *    - 計測中にプロセスが再起動した回数
 *    - 監査ログの記録率（申請件数に対する記録件数）
 *    - 応答時間（中央値 / P95）
 *    - 参考: 登録金額の不一致率（INQ-010。本改修の対象外だが継続監視のため）
 *
 *  使い方:
 *    node test/measure-stability.mjs --concurrent 10 --total 60
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';

const argv = process.argv.slice(2);
const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : def;
};
const CONCURRENT = arg('concurrent', 10);
const TOTAL = arg('total', 60);
const RUN_TAG = `stability-${Date.now()}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(...args) {
    return execFileSync('docker', ['compose', ...args], {
        cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
}
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const bootCount = () => (compose('logs', 'app').match(/\[BOOT\]/g) || []).length;

async function waitForHealth(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return; } catch { await sleep(300); }
    }
    throw new Error('アプリが起動しませんでした');
}

/** 1件申請する。単価は index ごとに一意にして、取り違えを検出できるようにする */
async function submit(index) {
    const expected = 1000 + index;
    const started = Date.now();
    try {
        const res = await fetch(`${BASE}/api/reports/transport`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: (index % 40) + 1,
                title: `${RUN_TAG} #${index}`,
                targetMonth: '2026-07',
                items: [{ description: `item${index}`, unitPrice: expected, qty: 1 }]
            })
        });
        const ms = Date.now() - started;
        if (res.status !== 200) return { kind: 'HTTP', code: res.status, ms };
        const json = await res.json();
        return { kind: 'OK', code: 200, ms, expected, actual: Number(json?.data?.subtotal) };
    } catch {
        return { kind: 'CONN', code: 0, ms: Date.now() - started };
    }
}

/** 同時実行数を CONCURRENT に保ちながら TOTAL 件を流す */
async function runLoad() {
    const results = [];
    let next = 0;
    const worker = async () => {
        while (next < TOTAL) {
            const i = next++;
            results.push(await submit(i));
        }
    };
    await Promise.all(Array.from({ length: CONCURRENT }, worker));
    return results;
}

// ---------------------------------------------------------------------------
(async () => {
    compose('restart', 'app');
    await waitForHealth();
    const bootsBefore = bootCount();

    const results = await runLoad();

    await sleep(3000);          // 監査ログの非同期書き込みと、落ちていれば復帰を待つ
    await waitForHealth();

    const boots = bootCount() - bootsBefore;
    const ok = results.filter((r) => r.kind === 'OK');
    const httpErr = results.filter((r) => r.kind === 'HTTP');
    const conn = results.filter((r) => r.kind === 'CONN');
    const mismatch = ok.filter((r) => r.actual !== r.expected);
    const times = ok.map((r) => r.ms).sort((a, b) => a - b);
    const pct = (n, d) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)}%`);

    const registered = Number(psql(`SELECT COUNT(*) FROM expense_reports WHERE title LIKE '${RUN_TAG}%';`));
    const audited = Number(psql(
        `SELECT COUNT(*) FROM audit_logs a JOIN expense_reports r ON r.id = a.target_id
         WHERE a.action_type = 'CREATE_TRANSPORT_REPORT' AND r.title LIKE '${RUN_TAG}%';`
    ));

    console.log(`\n=== 安定性計測  同時実行=${CONCURRENT} 総数=${TOTAL} ===`);
    console.log(`HTTP200 成功        : ${ok.length} / ${TOTAL}`);
    console.log(`HTTPエラー          : ${httpErr.length}`);
    console.log(`接続断              : ${conn.length}  (${pct(conn.length, TOTAL)})`);
    console.log(`計測中のプロセス再起動: ${boots} 回`);
    console.log(`DBに登録された申請  : ${registered} 件`);
    console.log(`うち監査ログ記録済み: ${audited} 件  (記録率 ${pct(audited, registered)})`);
    if (times.length) {
        console.log(`応答時間 中央値     : ${times[Math.floor(times.length / 2)]}ms`);
        console.log(`応答時間 P95        : ${times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]}ms`);
    }
    console.log(`[参考] 金額不一致    : ${mismatch.length} / ${ok.length}  (${pct(mismatch.length, ok.length)})  ※INQ-010。本改修の対象外`);
})();

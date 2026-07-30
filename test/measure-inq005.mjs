/* ============================================================================
 *  INQ-005 の計測
 *    「承認ボタンを押すと『混み合っています』と出て失敗することがあります。
 *      特に月末、申請者が申請を直しているタイミングで承認しようとすると
 *      失敗しやすいです。何度か押すと通るのですが、そのあと画面が真っ白に
 *      なって、リロードすると承認できていたことがありました。
 *      逆に、承認できていないこともあります」
 *
 *  仮説:
 *    approve は 申請 -> 予算枠 の順にロックし、
 *    withdraw は 予算枠 -> 申請 の順にロックしている（ロック順序の不一致）。
 *    同一申請に対して同時に実行するとデッドロックになるのではないか。
 *    さらに approve は 500 を返した「後」に retryApprove が同じ res に
 *    再度 res.json() するため、二重レスポンスで停止するのではないか。
 *
 *  使い方: node test/measure-inq005.mjs [試行回数]
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TRIALS = Number(process.argv[2] || 15);
const TARGET_MONTH = '2026-07';
const USER_ID = 1;
const APPROVER_ID = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const psqlValue = (q) => psql(q).split('\n')[0].trim();
const bootCount = () => (compose('logs', 'app').match(/\[BOOT\]/g) || []).length;
const deadlockCount = () =>
    (compose('logs', 'app').match(/code=40P01/g) || []).length;

async function waitForHealth(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return true; } catch { await sleep(300); }
    }
    return false;
}

async function post(url, body) {
    try {
        const res = await fetch(`${BASE}${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000)
        });
        let json = null;
        try { json = await res.json(); } catch { /* 本文が無い場合がある */ }
        return { code: res.status, json };
    } catch (e) {
        return { code: 0, err: e.message };
    }
}

/** 承認対象の申請を1件用意し、id と 合計金額 を返す */
function createReport(tag) {
    const id = psqlValue(
        `INSERT INTO expense_reports
           (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
         VALUES (${USER_ID}, '${tag}', 'transport', 'submitted', 10000, 1000, 11000, '${TARGET_MONTH}')
         RETURNING id;`
    );
    return { id, total: 11000 };
}

const usedAmount = () =>
    Number(psqlValue(
        `SELECT used_amount FROM monthly_budgets WHERE user_id = ${USER_ID} AND target_month = '${TARGET_MONTH}';`
    ));

(async () => {
    console.log(`=== INQ-005 計測: 同一申請への approve / withdraw 同時実行 （${TRIALS}試行）===\n`);

    compose('restart', 'app');
    await waitForHealth();
    const boots0 = bootCount();
    const deadlocks0 = deadlockCount();

    let http500 = 0, conn = 0, ok = 0;
    let inconsistent = 0;        // 500 を返したのに承認されている
    let budgetMismatch = 0;      // 予算枠の増減が最終ステータスと合わない
    const detail = [];

    for (let i = 1; i <= TRIALS; i++) {
        const { id, total } = createReport(`inq005-${Date.now()}-${i}`);
        const usedBefore = usedAmount();

        // 承認と取り下げを同時に投げる（申請者が直している最中に承認する状況）
        const [appr, wdrw] = await Promise.all([
            post(`/api/reports/${id}/approve`, { approverId: APPROVER_ID, comment: '' }),
            post(`/api/reports/${id}/withdraw`, { userId: USER_ID, comment: '' })
        ]);

        await sleep(600);
        await waitForHealth();

        const finalStatus = psqlValue(`SELECT status FROM expense_reports WHERE id = ${id};`);
        const usedAfter = usedAmount();
        const delta = usedAfter - usedBefore;

        for (const r of [appr, wdrw]) {
            if (r.code === 200) ok++;
            else if (r.code === 500) http500++;
            else if (r.code === 0) conn++;
        }

        // 承認が失敗表示なのに approved になっている＝画面と実データの食い違い
        if (appr.code !== 200 && finalStatus === 'approved') inconsistent++;

        // 予算枠の期待値: approved なら +total、draft なら 0（加算後に減算）または -total
        const expected = finalStatus === 'approved' ? total : 0;
        if (delta !== expected && !(finalStatus === 'draft' && (delta === 0 || delta === -total))) {
            budgetMismatch++;
        }

        detail.push({ i, id, appr: appr.code, wdrw: wdrw.code, finalStatus, delta });
    }

    await sleep(1500);
    const boots = bootCount() - boots0;
    const deadlocks = deadlockCount() - deadlocks0;

    console.log('試行  申請ID  approve  withdraw  最終状態   予算枠の増減');
    for (const d of detail) {
        console.log(
            `${String(d.i).padStart(3)}   ${String(d.id).padStart(6)}  ` +
            `${String(d.appr).padStart(7)}  ${String(d.wdrw).padStart(8)}  ` +
            `${String(d.finalStatus).padEnd(9)}  ${String(d.delta).padStart(8)}`
        );
    }

    const totalReq = TRIALS * 2;
    const pct = (n) => `${((100 * n) / totalReq).toFixed(1)}%`;
    console.log(`\n--- 集計（リクエスト総数 ${totalReq} = ${TRIALS}試行 × 2）---`);
    console.log(`HTTP 200            : ${ok}  (${pct(ok)})`);
    console.log(`HTTP 500「混み合っています」: ${http500}  (${pct(http500)})`);
    console.log(`接続断（プロセス停止）: ${conn}  (${pct(conn)})`);
    console.log(`DBデッドロック(40P01) : ${deadlocks} 件`);
    console.log(`プロセス再起動        : ${boots} 回`);
    console.log(`失敗表示なのに承認済み: ${inconsistent} / ${TRIALS} 試行`);
    console.log(`予算枠の増減が不整合  : ${budgetMismatch} / ${TRIALS} 試行`);

    psql(`DELETE FROM expense_reports WHERE title LIKE 'inq005-%';`);
    console.log('\n検体を削除しました。');
})();

/* ============================================================================
 *  月次予算枠の整合性の計測
 *
 *  仕様書 4.3:
 *    「使用済み金額は承認された時点で加算し、取り下げられた時点で減算する」
 *  仕様書 3章:
 *    「申請者は、承認される前であれば申請を取り下げて下書きに戻すことができる」
 *
 *  ここで測るのは同時実行ではなく、利用者が普通に行う操作の並びである。
 *  INQ-005 の同時実行とは別に、単独操作でも予算枠が壊れるかを確認する。
 *
 *  使い方: node test/measure-budget.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const MONTH = '2026-07';
const APPROVER_ID = 8;
const TOTAL = 11000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const psqlValue = (q) => psql(q).split('\n')[0].trim();

async function waitForHealth(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return; } catch { await sleep(300); }
    }
}

async function post(url, body) {
    try {
        const res = await fetch(`${BASE}${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000)
        });
        await res.text();
        return res.status;
    } catch { return 0; }
}

/** 社員ごとに検体を作り、他の検体と予算枠を共有しないようにする */
function createReport(userId, tag) {
    return psqlValue(
        `INSERT INTO expense_reports
           (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
         VALUES (${userId}, '${tag}', 'transport', 'submitted', 10000, 1000, ${TOTAL}, '${MONTH}')
         RETURNING id;`
    );
}
const used = (userId) =>
    Number(psqlValue(`SELECT used_amount FROM monthly_budgets WHERE user_id = ${userId} AND target_month = '${MONTH}';`));

const scenarios = [
    {
        name: 'S1 承認を2回押す',
        note: '承認は1回しか効かないはず',
        expected: TOTAL,
        run: async (id, uid) => {
            await post(`/api/reports/${id}/approve`, { approverId: APPROVER_ID });
            await post(`/api/reports/${id}/approve`, { approverId: APPROVER_ID });
        }
    },
    {
        name: 'S2 未承認の申請を取り下げ',
        note: '仕様3章の正常操作。加算前なので減算されないはず',
        expected: 0,
        run: async (id, uid) => {
            await post(`/api/reports/${id}/withdraw`, { userId: uid });
        }
    },
    {
        name: 'S3 承認したあと取り下げ',
        note: '加算のあと減算。差し引き0のはず',
        expected: 0,
        run: async (id, uid) => {
            await post(`/api/reports/${id}/approve`, { approverId: APPROVER_ID });
            await post(`/api/reports/${id}/withdraw`, { userId: uid });
        }
    },
    {
        name: 'S4 承認したあと却下',
        note: '仕様に記載が無い（却下時の減算が未定義）',
        expected: null,
        run: async (id, uid) => {
            await post(`/api/reports/${id}/approve`, { approverId: APPROVER_ID });
            await post(`/api/reports/${id}/reject`, { approverId: APPROVER_ID });
        }
    }
];

(async () => {
    console.log('=== 月次予算枠の整合性（単独操作・同時実行なし）===\n');
    compose('restart', 'app');
    await waitForHealth();

    console.log('シナリオ                       予算枠の増減   期待値    最終状態    判定');
    console.log('-'.repeat(78));

    for (let i = 0; i < scenarios.length; i++) {
        const s = scenarios[i];
        const userId = i + 1;                     // 社員ごとに分けて相互影響を避ける
        const id = createReport(userId, `budget-S${i + 1}-${Date.now()}`);
        const before = used(userId);

        await s.run(id, userId);
        await sleep(500);
        await waitForHealth();

        const delta = used(userId) - before;
        const status = psqlValue(`SELECT status FROM expense_reports WHERE id = ${id};`);
        const verdict = s.expected === null ? '（仕様未定義）' : (delta === s.expected ? 'OK' : '★不一致');

        console.log(
            `${s.name.padEnd(28)} ${String(delta).padStart(10)}  ` +
            `${String(s.expected === null ? '-' : s.expected).padStart(8)}  ` +
            `${String(status).padEnd(10)}  ${verdict}`
        );
        console.log(`   ${s.note}`);
    }

    console.log('\n--- 実施後の全体突き合わせ ---');
    console.log(psql(
        `WITH recon AS (
           SELECT b.used_amount AS kiroku, COALESCE(SUM(r.total_amount),0) AS shonin
           FROM monthly_budgets b
           LEFT JOIN expense_reports r
             ON r.user_id=b.user_id AND r.target_month=b.target_month AND r.status='approved'
           GROUP BY b.id, b.used_amount)
         SELECT COUNT(*) FILTER (WHERE kiroku <> shonin) || ' / ' || COUNT(*) || ' 行が不一致、差額合計 '
                || COALESCE(SUM(kiroku - shonin) FILTER (WHERE kiroku <> shonin), 0) || ' 円'
         FROM recon;`
    ));
})();

/* ============================================================================
 *  監査ログ書き込みの特性テスト（characterization test）
 *
 *  目的:
 *    INQ-003（何回か操作すると落ちる）と監査ログの欠落は、
 *    server.js の writeAuditLog() 内 'v2:' 分岐という単一の原因から出ている。
 *    修正の前後で「何が変わり、何が変わっていないか」を数値で言えるようにする。
 *
 *  注意:
 *    期待値は「あるべき値」ではなく【計測した現在の値】を入れてある。
 *    修正後にこのテストが落ちることで、挙動が変わったことを確認する。
 *
 *  実行:
 *    cd expense-system && node --test test/
 *    （事前に docker compose up -d --build で環境が起動していること）
 * ========================================================================= */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';

/** 申請の連続登録回数。修正前の writeAuditLog は 7 回に 1 回 'v2:' 分岐に入っていた */
const SUBMIT_COUNT = 7;

/** 実行ごとに一意のタグ。過去の実行で作られた申請を数えないようにする */
const RUN_TAG = `audit-test-${Date.now()}`;

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(...args) {
    return execFileSync('docker', ['compose', ...args], {
        cwd: PROJECT_DIR,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
}

function psql(query) {
    return compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', query).trim();
}

/** アプリのログに出た [BOOT] の数 = プロセスが起動した回数 */
function bootCount() {
    return (compose('logs', 'app').match(/\[BOOT\]/g) || []).length;
}

async function health() {
    const res = await fetch(`${BASE}/api/health`);
    return res.json();
}

async function waitForHealth(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await health();
            return true;
        } catch {
            await sleep(300);
        }
    }
    throw new Error('アプリが起動しませんでした');
}

/** 交通費を1件申請する。プロセスが落ちていれば 0 を返す */
async function submitTransport(index) {
    try {
        const res = await fetch(`${BASE}/api/reports/transport`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: 1,
                title: `${RUN_TAG} #${index}`,
                targetMonth: '2026-07',
                items: [{ description: 'テスト明細', unitPrice: 100, qty: 1 }]
            })
        });
        return res.status;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// シナリオを1回だけ実行し、各テストはその結果を検証する
// ---------------------------------------------------------------------------
const observed = {};

before(async () => {
    // プロセスを再起動して auditWriteCount を 0 に戻す
    compose('restart', 'app');
    await waitForHealth();

    psql('TRUNCATE audit_logs;');
    const bootsBefore = bootCount();

    const statuses = [];
    for (let i = 1; i <= SUBMIT_COUNT; i++) {
        statuses.push(await submitTransport(i));
        await sleep(150);
    }

    // 監査ログは setTimeout でレスポンス後に書かれる。落ちた場合は復帰も待つ
    await sleep(3000);
    await waitForHealth();

    observed.statuses = statuses;
    observed.bootsDuringSubmit = bootCount() - bootsBefore;
    observed.auditLogCount = Number(psql("SELECT COUNT(*) FROM audit_logs WHERE action_type = 'CREATE_TRANSPORT_REPORT';"));
    observed.reportCount = Number(psql(`SELECT COUNT(*) FROM expense_reports WHERE title LIKE '${RUN_TAG}%';`));

    console.log('  観測値:', JSON.stringify(observed));
});

// ---------------------------------------------------------------------------
// 【修正の検証】v2分岐の削除によって直った挙動
//   修正前はそれぞれ 6件 / 1回 だった（計測値は DECISIONS.md 参照）
// ---------------------------------------------------------------------------

test('申請7件に対し、監査ログが7件記録される（欠落しない）', () => {
    assert.equal(
        observed.auditLogCount,
        SUBMIT_COUNT,
        `監査ログが ${SUBMIT_COUNT} 件である想定。実際は ${observed.auditLogCount} 件`
    );
});

test('申請7件の途中でプロセスが再起動しない', () => {
    assert.equal(
        observed.bootsDuringSubmit,
        0,
        `プロセス起動が0回である想定。実際は ${observed.bootsDuringSubmit} 回`
    );
});

// ---------------------------------------------------------------------------
// 【不変】修正の前後で変わってはいけない挙動（回帰の検出用）
// ---------------------------------------------------------------------------

test('[不変] 申請7件はすべてDBに登録される', () => {
    assert.equal(
        observed.reportCount,
        SUBMIT_COUNT,
        `申請が ${SUBMIT_COUNT} 件登録される想定。実際は ${observed.reportCount} 件`
    );
});

test('[不変] 申請APIはすべて HTTP 200 を返す', () => {
    assert.deepEqual(
        observed.statuses,
        Array(SUBMIT_COUNT).fill(200),
        `全て200である想定。実際は ${JSON.stringify(observed.statuses)}`
    );
});

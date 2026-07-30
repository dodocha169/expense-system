/* ============================================================================
 *  レシート原本取得 GET /api/receipts/:id/raw の特性テスト
 *
 *  対象: INQ-014（古いレシートを開くとシステム全体が使えなくなる）
 *        および同ルートで数値でないIDを渡した場合の停止
 *
 *  このルートだけ try/catch が無く、さらに
 *    - fs.createReadStream の 'error' が未ハンドル
 *    - id を文字列連結しているためDBエラーが未処理のPromise拒否になる
 *  という2経路でプロセスが停止する。
 *
 *  注意:
 *    期待値は「あるべき値」ではなく【計測した現在の値】を入れてある。
 *    修正後にこのテストが落ちることで、挙動が変わったことを確認する。
 *
 *  実行: bash test/run.sh
 * ========================================================================= */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function compose(...args) {
    return execFileSync('docker', ['compose', ...args], {
        cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024
    });
}
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
/** RETURNING 付き INSERT は "1\nINSERT 0 1" と返るため1行目だけ取る */
const psqlValue = (q) => psql(q).split('\n')[0].trim();
const bootCount = () => (compose('logs', 'app').match(/\[BOOT\]/g) || []).length;

async function waitForHealth(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return true; } catch { await sleep(300); }
    }
    throw new Error('アプリが起動しませんでした');
}

/** レシート原本を取得する。プロセス停止で接続が切れた場合は code=0 */
async function getRaw(id) {
    try {
        const res = await fetch(`${BASE}/api/receipts/${id}/raw`, { signal: AbortSignal.timeout(20000) });
        await res.text();
        return res.status;
    } catch {
        return 0;
    }
}

/** 各ケースを独立に測る。前のケースの停止が次に混ざらないよう毎回再起動する */
async function probe(id) {
    compose('restart', 'app');
    await waitForHealth();
    const boots0 = bootCount();

    const status = await getRaw(id);

    // 停止していれば復帰を待つ
    await sleep(2500);
    await waitForHealth();

    return { status, boots: bootCount() - boots0 };
}

const observed = {};

before(async () => {
    compose('restart', 'app');
    await waitForHealth();

    // 2022-03 より前に移行された、DBに画像を持たないレシート
    const legacyId = psqlValue(
        `INSERT INTO receipts (report_id, filename, mime_type, image_base64, thumb_base64, byte_size, created_at)
         VALUES (1, 'legacy_2021_0001.jpg', 'image/jpeg', NULL, NULL, 0, '2021-11-30')
         RETURNING id;`
    );
    // 比較用: DBに画像を持つ通常のレシート
    const normalId = psqlValue(
        `INSERT INTO receipts (report_id, filename, mime_type, image_base64, thumb_base64, byte_size)
         VALUES (1, 'normal.jpg', 'image/jpeg', 'data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,AAAA', 3)
         RETURNING id;`
    );

    observed.normal = await probe(normalId);
    observed.legacy = await probe(legacyId);
    observed.notNumeric = await probe('abc');
    observed.outOfRange = await probe('99999999999');   // int4 の範囲外
    observed.missing = await probe(999999);

    psql(`DELETE FROM receipts WHERE id IN (${legacyId}, ${normalId});`);
    console.log('  観測値:', JSON.stringify(observed));
});

// ---------------------------------------------------------------------------
// 【不変】修正の前後で変わってはいけない挙動
// ---------------------------------------------------------------------------

test('[不変] DBに画像があるレシートは 200 を返し、プロセスは落ちない', () => {
    assert.equal(observed.normal.status, 200, `200 の想定。実際は ${observed.normal.status}`);
    assert.equal(observed.normal.boots, 0, `再起動0回の想定。実際は ${observed.normal.boots} 回`);
});

test('[不変] 存在しないIDは 404 を返し、プロセスは落ちない', () => {
    assert.equal(observed.missing.status, 404, `404 の想定。実際は ${observed.missing.status}`);
    assert.equal(observed.missing.boots, 0, `再起動0回の想定。実際は ${observed.missing.boots} 回`);
});

// ---------------------------------------------------------------------------
// 【修正の検証】例外処理の追加によって直った挙動
//   修正前はどちらも「接続断 + プロセス再起動1回」だった
// ---------------------------------------------------------------------------

test('旧レシート（画像がDBに無い）を開いてもプロセスは停止せず、500 を返す', () => {
    assert.equal(observed.legacy.status, 500, `500 の想定。実際は ${observed.legacy.status}`);
    assert.equal(observed.legacy.boots, 0, `再起動0回の想定。実際は ${observed.legacy.boots} 回`);
});

test('数値でないIDは 400 を返し、プロセスは停止しない', () => {
    assert.equal(observed.notNumeric.status, 400, `400 の想定。実際は ${observed.notNumeric.status}`);
    assert.equal(observed.notNumeric.boots, 0, `再起動0回の想定。実際は ${observed.notNumeric.boots} 回`);
});

test('int4 の範囲を超えるIDは 400 を返し、プロセスは停止しない', () => {
    assert.equal(observed.outOfRange.status, 400, `400 の想定。実際は ${observed.outOfRange.status}`);
    assert.equal(observed.outOfRange.boots, 0, `再起動0回の想定。実際は ${observed.outOfRange.boots} 回`);
});

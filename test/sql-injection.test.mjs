/* ============================================================================
 *  SQLインジェクションの特性テスト
 *
 *  対象: Util.buildCondition と、SQL文への文字列連結が行われている全経路。
 *        利用者入力（クエリ文字列・パスパラメータ・リクエストボディ）が
 *        そのままSQLに埋め込まれている。
 *
 *  ここで使う検体はすべて読み取りのみで、破壊的な操作は行わない。
 *  「本来returnされない行が返ってくる」ことで注入の成立を判定する。
 *
 *  注意:
 *    期待値は「あるべき値」ではなく【計測した現在の値】を入れてある。
 *    修正後にこのテストが落ちることで、挙動が変わったことを確認する。
 *
 *  実行: bash test/run.sh
 * ========================================================================= */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:3100';

/** 注入検体。クォートを閉じて常に真になる条件を足す古典的な形 */
const ALWAYS_TRUE = "x' OR '1'='1";

async function get(url) {
    try {
        const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(60000) });
        const text = await res.text();
        let count = null;
        try {
            const json = JSON.parse(text);
            if (Array.isArray(json.data)) count = json.data.length;
            else if (json.data && Array.isArray(json.data.reports)) count = json.data.reports.length;
        } catch { /* CSV など非JSONの応答 */ }
        return { status: res.status, count, length: text.length };
    } catch (e) {
        return { status: 0, count: null, length: 0, err: e.message };
    }
}

const observed = {};

before(async () => {
    // --- 対照群（正常な入力） ---
    observed.normalStatus = await get('/api/reports?limit=5&status=submitted');
    observed.noSuchStatus = await get('/api/reports?limit=5&status=nosuchstatus');
    observed.normalDept = await get(`/api/users?department=${encodeURIComponent('営業部')}`);
    observed.normalSummary = await get('/api/summary/1/2026-07');

    // --- 注入（いずれも読み取りのみ） ---
    observed.injStatus = await get(`/api/reports?limit=5&status=${encodeURIComponent(ALWAYS_TRUE)}`);
    observed.injUserId = await get(`/api/reports?limit=5&userId=${encodeURIComponent("0' OR '1'='1")}`);
    observed.injLimit = await get(`/api/reports?limit=${encodeURIComponent('(SELECT 3)')}`);
    observed.injDept = await get(`/api/users?department=${encodeURIComponent(ALWAYS_TRUE)}`);
    observed.injSummary = await get(`/api/summary/${encodeURIComponent('1 OR 1=1')}/2026-07`);
    observed.injExport = await get(`/api/export/${encodeURIComponent(ALWAYS_TRUE)}`);

    console.log('  観測値:', JSON.stringify(observed));
});

// ---------------------------------------------------------------------------
// 【不変】正常な入力に対する挙動。修正前後で変わってはいけない
// ---------------------------------------------------------------------------

test('[不変] status で絞り込める', () => {
    assert.equal(observed.normalStatus.status, 200);
    assert.ok(observed.normalStatus.count > 0, `1件以上の想定。実際は ${observed.normalStatus.count}`);
});

test('[不変] 存在しない status では0件になる', () => {
    assert.equal(observed.noSuchStatus.status, 200);
    assert.equal(observed.noSuchStatus.count, 0);
});

test('[不変] department で絞り込める（全社員より少ない）', () => {
    assert.equal(observed.normalDept.status, 200);
    assert.ok(observed.normalDept.count > 0 && observed.normalDept.count < 40,
        `1〜39件の想定。実際は ${observed.normalDept.count}`);
});

test('[不変] 月次集計は指定した社員の分だけ返す', () => {
    assert.equal(observed.normalSummary.status, 200);
    assert.ok(observed.normalSummary.count > 0, `1件以上の想定。実際は ${observed.normalSummary.count}`);
});

// ---------------------------------------------------------------------------
// 【修正の検証】パラメータ化によって注入が成立しなくなった
//   修正前は順に 5件 / 5件 / 3件 / 40件 / 114件 / 154,006文字 が返っていた
//   注入検体が文字列として扱われるため、文字列カラムは0件、
//   整数カラムはキャストに失敗して 500 になる
// ---------------------------------------------------------------------------

test('status への注入は文字列として扱われ、0件になる', () => {
    assert.equal(observed.injStatus.status, 200);
    assert.equal(observed.injStatus.count, 0,
        `0件の想定。実際は ${observed.injStatus.count}`);
});

test('userId への注入は整数へのキャストに失敗し、行を返さない', () => {
    assert.equal(observed.injUserId.status, 500,
        `500 の想定。実際は ${observed.injUserId.status}`);
    assert.equal(observed.injUserId.count, null);
});

test('limit への注入は数値として解釈されず、行を返さない', () => {
    assert.equal(observed.injLimit.status, 500,
        `500 の想定。実際は ${observed.injLimit.status}`);
    assert.equal(observed.injLimit.count, null);
});

test('department への注入は文字列として扱われ、0件になる', () => {
    assert.equal(observed.injDept.status, 200);
    assert.equal(observed.injDept.count, 0,
        `0件の想定。実際は ${observed.injDept.count}`);
});

test('月次集計への注入は整数へのキャストに失敗し、他人のデータを返さない', () => {
    assert.equal(observed.injSummary.status, 500,
        `500 の想定。実際は ${observed.injSummary.status}`);
    assert.equal(observed.injSummary.count, null);
});

test('CSV出力への注入では見出し行のみが返り、データは流出しない', () => {
    assert.equal(observed.injExport.status, 200);
    assert.ok(observed.injExport.length < 200,
        `見出し行のみ（200文字未満）の想定。実際は ${observed.injExport.length} 文字`);
});

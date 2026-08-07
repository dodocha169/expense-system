/* ============================================================================
 *  月次集計の receiptBytes 算出の特性テスト
 *
 *  INQ-001 の N+1 解消にあたり、この値の算出方法を2度変更している。
 *
 *   (1) 変更前  : アプリ側で Buffer.from(image_base64, 'base64') を復号した長さ
 *   (2) 中間状態: DB側で decode(...) した長さ
 *                → 不正な base64 で decode() が例外を投げ、集計全体が 500 になった
 *   (3) 現在    : byte_size 列（アップロードされた元画像のサイズ）の合計
 *
 *  (3) により値の意味が変わっている。2MBの写真の場合:
 *      元画像            2,048,000  ← 現在の値
 *      変更前の値        1,024,000  （naiveResizeSync が1バイトおきに間引いた長さ）
 *      DBの実消費        1,501,918
 *
 *  ここでは「image_base64 の内容に一切左右されない」ことを固定する。
 *  中間状態で起きた 500 の再発防止も兼ねる。
 *
 *  実行: bash test/run.sh
 * ========================================================================= */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const TAG = 'sumbytes';
const USER_ID = 39;
const MONTH = '2026-11';          // 既存データと重ならない月

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();
const psqlValue = (q) => psql(q).split('\n')[0].trim();

function cleanup() {
    // 外部キー制約が無いため、明細・レシートも明示的に消す
    psql(`DELETE FROM receipts WHERE report_id IN (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM expense_items WHERE report_id IN (SELECT id FROM expense_reports WHERE title LIKE '${TAG}%');`);
    psql(`DELETE FROM expense_reports WHERE title LIKE '${TAG}%';`);
}

/** レシートを1件だけ作り直して月次集計を呼ぶ */
async function summaryWith(imageLiteral, byteSizeLiteral) {
    psql(`DELETE FROM receipts WHERE report_id = ${reportId};`);
    psql(`INSERT INTO receipts (report_id, filename, mime_type, image_base64, byte_size)
          VALUES (${reportId}, 'x.jpg', 'image/jpeg', ${imageLiteral}, ${byteSizeLiteral});`);
    const res = await fetch(`${BASE}/api/summary/${USER_ID}/${MONTH}`, { signal: AbortSignal.timeout(60000) });
    const text = await res.text();
    let bytes = null;
    try { bytes = JSON.parse(text)?.data?.receiptBytes; } catch { /* エラー応答 */ }
    return { status: res.status, bytes };
}

let reportId;
const observed = {};

before(async () => {
    cleanup();
    reportId = psqlValue(
        `INSERT INTO expense_reports
           (user_id, title, category, status, subtotal_amount, tax_amount, total_amount, target_month)
         VALUES (${USER_ID}, '${TAG}-1', 'transport', 'approved', 1000, 100, 1100, '${MONTH}')
         RETURNING id;`
    );

    // image_base64 の状態を変えても byte_size だけで決まることを確認する
    observed.validImage = await summaryWith(`'data:image/jpeg;base64,AAAA'`, 111);
    observed.nullImage = await summaryWith('NULL', 222);
    observed.emptyImage = await summaryWith(`''`, 333);
    observed.invalidChars = await summaryWith(`'data:image/jpeg;base64,!!!!'`, 444);
    observed.badLength = await summaryWith(`'data:image/jpeg;base64,AAA'`, 555);
    observed.nullByteSize = await summaryWith(`'data:image/jpeg;base64,AAAA'`, 'NULL');

    // 複数件の合計
    psql(`DELETE FROM receipts WHERE report_id = ${reportId};`);
    psql(`INSERT INTO receipts (report_id, filename, mime_type, image_base64, byte_size)
          VALUES (${reportId}, 'a.jpg', 'image/jpeg', NULL, 1000),
                 (${reportId}, 'b.jpg', 'image/jpeg', 'data:image/jpeg;base64,AAAA', 2000),
                 (${reportId}, 'c.jpg', 'image/jpeg', 'data:image/jpeg;base64,!!!!', 3000);`);
    const res = await fetch(`${BASE}/api/summary/${USER_ID}/${MONTH}`, { signal: AbortSignal.timeout(60000) });
    const json = await res.json();
    observed.multiple = {
        status: res.status,
        bytes: json?.data?.receiptBytes,
        receiptCount: json?.data?.reports?.[0]?.receiptCount
    };

    console.log('  観測値:', JSON.stringify(observed));
});

after(() => cleanup());

// ---------------------------------------------------------------------------
// receiptBytes は byte_size 列だけで決まる
// ---------------------------------------------------------------------------

test('receiptBytes は byte_size の値をそのまま返す', () => {
    assert.equal(observed.validImage.status, 200);
    assert.equal(observed.validImage.bytes, 111);
});

test('image_base64 が NULL でも byte_size が計上される（変更前は0だった）', () => {
    assert.equal(observed.nullImage.status, 200);
    assert.equal(observed.nullImage.bytes, 222,
        '画像がDBに無い旧レシートも計上される。変更前は常に0だった');
});

test('image_base64 が空文字でも byte_size が計上される', () => {
    assert.equal(observed.emptyImage.status, 200);
    assert.equal(observed.emptyImage.bytes, 333);
});

test('byte_size が NULL なら 0 として扱う', () => {
    assert.equal(observed.nullByteSize.status, 200);
    assert.equal(observed.nullByteSize.bytes, 0);
});

test('複数件は byte_size の合計になる', () => {
    assert.equal(observed.multiple.status, 200);
    assert.equal(observed.multiple.bytes, 6000, '1000 + 2000 + 3000');
    assert.equal(observed.multiple.receiptCount, 3);
});

// ---------------------------------------------------------------------------
// 中間状態で発生した回帰の再発防止
//   DB側で decode() していた時期は、不正な base64 が1件あるだけで
//   その社員のその月の集計が 500 になっていた
// ---------------------------------------------------------------------------

test('[回帰防止] base64として不正な文字を含んでも集計は成功する', () => {
    assert.equal(observed.invalidChars.status, 200,
        `200 の想定。実際は ${observed.invalidChars.status}`);
    assert.equal(observed.invalidChars.bytes, 444);
});

test('[回帰防止] base64の長さが4の倍数でなくても集計は成功する', () => {
    assert.equal(observed.badLength.status, 200,
        `200 の想定。実際は ${observed.badLength.status}`);
    assert.equal(observed.badLength.bytes, 555);
});

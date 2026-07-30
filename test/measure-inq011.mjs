/* ============================================================================
 *  INQ-011 の計測
 *    「データベースの容量が去年の3倍になっています。
 *      このペースだとディスクがあと4ヶ月で埋まります」
 *
 *  仮説:
 *    レシート画像を base64 文字列のまま TEXT に保存しており、
 *    さらに「表示用」と「サムネイル」の2本を持っている。
 *    naiveResizeSync は幅600pxへの縮小と称しているが、実際にはバイト列を
 *    step = 1600/targetWidth で間引いているだけなので、ほとんど小さくならない。
 *
 *  注意:
 *    テスト画像には必ず乱数を使うこと。規則的なパターンだと PostgreSQL の
 *    TOAST 圧縮が効いてしまい、実際のJPEG（圧縮済み＝ほぼ非圧縮）と
 *    かけ離れた結果になる。
 *
 *  使い方: node test/measure-inq011.mjs
 * ========================================================================= */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const compose = (...a) =>
    execFileSync('docker', ['compose', ...a], { cwd: PROJECT_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const psql = (q) =>
    compose('exec', '-T', 'db', 'psql', '-U', 'expense_user', '-d', 'expense_db', '-tAc', q).trim();

async function waitForHealth(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return; } catch { await sleep(300); }
    }
}

/** 実写真に近い＝圧縮の効かない画像を作る */
function makePhoto(kb) {
    const n = kb * 1024;
    const buf = randomBytes(n);
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
    buf[3] = 0xff; buf[4] = 0xe1;
    buf[n - 2] = 0xff; buf[n - 1] = 0xd9;
    return 'data:image/jpeg;base64,' + buf.toString('base64');
}

const receiptsBytes = () =>
    Number(psql("SELECT pg_total_relation_size('receipts');"));

(async () => {
    console.log('=== INQ-011 計測: レシート画像のDB保存量 ===\n');

    compose('restart', 'app');
    await waitForHealth();
    psql('DELETE FROM receipts;');
    psql('VACUUM FULL receipts;');

    const before = receiptsBytes();
    console.log(`レシート0件時の receipts テーブル: ${(before / 1024).toFixed(0)} kB\n`);

    const PHOTO_KB = 2000;      // スマホ写真の実サイズに近い2MB
    const COUNT = 5;

    for (let i = 0; i < COUNT; i++) {
        const res = await fetch(`${BASE}/api/receipts/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportId: 1, filename: `photo_${i}.jpg`, imageBase64: makePhoto(PHOTO_KB) }),
            signal: AbortSignal.timeout(300000)
        });
        await res.text();
    }

    psql('VACUUM ANALYZE receipts;');
    const after = receiptsBytes();
    const perReceipt = (after - before) / COUNT;

    console.log(`${PHOTO_KB / 1000}MB の写真を ${COUNT} 件アップロードした結果:`);
    console.log(`  receipts テーブル : ${(before / 1024).toFixed(0)} kB -> ${(after / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  1件あたりの実消費 : ${(perReceipt / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  元画像に対する比率: ${(perReceipt / (PHOTO_KB * 1024)).toFixed(2)} 倍\n`);

    console.log('--- 内訳（1件あたりの文字列長）---');
    console.log(psql(
        `SELECT byte_size AS 元画像, length(image_base64) AS 表示用, length(thumb_base64) AS サムネ,
                length(image_base64) + length(thumb_base64) AS 合計
         FROM receipts ORDER BY id DESC LIMIT 1;`
    ));

    console.log('\n--- 7年保持した場合の試算 ---');
    const perYear = (n) => (perReceipt * n) / 1024 / 1024 / 1024;
    for (const n of [1000, 5000, 20000]) {
        console.log(`  年間 ${String(n).padStart(6)} 件添付 → 1年 ${perYear(n).toFixed(1)} GB / 7年 ${(perYear(n) * 7).toFixed(1)} GB`);
    }

    console.log('\n--- 監査ログの増加 ---');
    console.log(psql(
        `SELECT COUNT(*) AS 行数, pg_size_pretty(pg_total_relation_size('audit_logs')) AS サイズ
         FROM audit_logs;`
    ));

    psql('DELETE FROM receipts;');
    console.log('\n検体を削除しました。');
})();

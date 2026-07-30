/* ============================================================================
 *  INQ-014 の計測
 *    「古い申請のレシートを確認しようとしたら、画像が表示されないどころか
 *      システム全体が使えなくなりました。2022年より前の申請だったと思います」
 *
 *  仮説:
 *    GET /api/receipts/:id/raw には try/catch が無い。
 *    2022-03 より前のレシートは image_base64 が NULL のため
 *    ファイルサーバ(/var/receipts_legacy)へフォールバックするが、
 *    fs.createReadStream の 'error' イベントが未ハンドルのため
 *    プロセス全体が停止するのではないか。
 *
 *  使い方: bash test/measure.sh は measure-stability 専用のため、
 *          node test/measure-inq014.mjs を直接実行する
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
/** RETURNING 付き INSERT は "1\nINSERT 0 1" のように返るため、1行目だけを取る */
const psqlValue = (q) => psql(q).split('\n')[0].trim();
const bootCount = () => (compose('logs', 'app').match(/\[BOOT\]/g) || []).length;

async function waitForHealth(timeoutMs = 40000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return true; } catch { await sleep(300); }
    }
    return false;
}

/** レシート取得を試みる。プロセス停止で接続が切れた場合は kind='CONN' */
async function getRaw(id) {
    const started = Date.now();
    try {
        const res = await fetch(`${BASE}/api/receipts/${id}/raw`, { signal: AbortSignal.timeout(20000) });
        const body = await res.text();
        return { kind: 'HTTP', code: res.status, ms: Date.now() - started, size: body.length };
    } catch (e) {
        return { kind: 'CONN', code: 0, ms: Date.now() - started, err: e.message };
    }
}

/** 無関係な利用者が同時刻に受ける影響を測る */
async function otherUserRequest() {
    try {
        const res = await fetch(`${BASE}/api/reports?limit=5`, { signal: AbortSignal.timeout(20000) });
        return `HTTP ${res.status}`;
    } catch (e) {
        return `到達不可 (${e.message})`;
    }
}

(async () => {
    console.log('=== INQ-014 計測: 2022-03 以前のレシート（image_base64 が NULL）の取得 ===\n');

    // --- 検体を用意する -----------------------------------------------------
    // 旧システムから移行したレシートを模擬する。DBに画像を持たない行。
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
    console.log(`検体: 旧レシート id=${legacyId}（image_base64=NULL） / 通常レシート id=${normalId}\n`);

    // 3ケースを1件ずつ独立に測る。各ケースの前にプロセスを再起動し、
    // 直前のケースのクラッシュが次のケースの結果に混ざらないようにする。
    const cases = [
        { name: '[対照] 通常レシート（DBに画像あり）', id: normalId },
        { name: '[本命] 旧レシート（image_base64 が NULL）', id: legacyId },
        { name: '[追加] 数値でないID', id: 'abc' }
    ];

    for (const c of cases) {
        compose('restart', 'app');
        await waitForHealth();
        const boots0 = bootCount();

        const r = await getRaw(c.id);
        const other = await otherUserRequest();

        await sleep(2500);
        const recovered = await waitForHealth();
        const boots = bootCount() - boots0;

        console.log(`${c.name}  id=${c.id}`);
        console.log(`   レシート取得   : ${r.kind} ${r.code} (${r.ms}ms) ${r.err || ''}`);
        console.log(`   直後の別要求   : ${other}`);
        console.log(`   プロセス再起動 : ${boots} 回 ${boots > 0 ? '★停止した' : ''}`);
        console.log(`   自動復帰       : ${recovered ? 'あり' : 'なし'}\n`);
    }

    // 後片付け
    psql(`DELETE FROM receipts WHERE id IN (${legacyId}, ${normalId});`);
    console.log('検体を削除しました。');
})();

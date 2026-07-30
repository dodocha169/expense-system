/* ============================================================================
 *  INQ-002 / INQ-001 の計測
 *    INQ-002「レシートの写真を付けて申請しようとすると画面が固まります。
 *             同じ時間に他の人が申請していると、その人も遅いと言っていました」
 *    INQ-001「月末になると画面がすごく遅くなります」
 *
 *  仮説:
 *    1. 画像処理(parseExifSync / naiveResizeSync)がすべて同期関数のため、
 *       処理中はイベントループが止まり、無関係な利用者まで待たされる
 *    2. 一覧APIは1件ごとに明細・レシート・承認履歴を個別に問い合わせており(N+1)、
 *       さらに SELECT * のため使わない画像(base64)まで毎回読んでいる
 *
 *  使い方: node test/measure-perf.mjs
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

async function waitForHealth(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await fetch(`${BASE}/api/health`); return; } catch { await sleep(300); }
    }
}

/** JPEGのマーカーを持つ合成画像。サーバは画像として復号せずバイト列として扱う */
function makeImage(kb) {
    const n = kb * 1024;
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff;
    buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
    buf[3] = 0xff; buf[4] = 0xe1;                    // APP1 = EXIF あり（向き補正パスを通す）
    buf[n - 2] = 0xff; buf[n - 1] = 0xd9;
    return 'data:image/jpeg;base64,' + buf.toString('base64');
}

async function timed(url, opts) {
    const t = Date.now();
    try {
        const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(300000) });
        await res.text();
        return { ms: Date.now() - t, code: res.status };
    } catch (e) {
        return { ms: Date.now() - t, code: 0, err: e.message };
    }
}

const stat = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return { med: s[Math.floor(s.length / 2)], max: s[s.length - 1], n: s.length };
};

/** 一覧APIの応答時間を測る */
async function measureList(label) {
    console.log(`\n--- 一覧・集計API ${label} ---`);
    for (const limit of [20, 50, 100]) {
        const ts = [];
        for (let i = 0; i < 5; i++) ts.push((await timed(`${BASE}/api/reports?limit=${limit}`)).ms);
        const s = stat(ts);
        console.log(`  GET /api/reports?limit=${String(limit).padEnd(3)} 中央値 ${String(s.med).padStart(6)}ms  最大 ${String(s.max).padStart(6)}ms`);
    }
    const sum = await timed(`${BASE}/api/summary/1/2026-07`);
    console.log(`  GET /api/summary/1/2026-07      ${String(sum.ms).padStart(6)}ms`);
}

(async () => {
    console.log('=== INQ-002 / INQ-001 計測 ===');

    compose('restart', 'app');
    await waitForHealth();
    psql('DELETE FROM receipts;');

    // ------------------------------------------------------------------
    // 1. レシート0件の状態での一覧（ベースライン）
    // ------------------------------------------------------------------
    await measureList('（レシート0件）');

    // ------------------------------------------------------------------
    // 2. アップロード中に、無関係な利用者がどれだけ待たされるか
    // ------------------------------------------------------------------
    console.log('\n--- レシートアップロード中の他利用者への波及 ---');
    console.log('  画像サイズ  アップロード  同時の/api/health 中央値  同左 最大  計測回数');

    for (const kb of [200, 800, 3000]) {
        compose('restart', 'app');
        await waitForHealth();

        const img = makeImage(kb);
        const latencies = [];
        let uploading = true;

        // アップロードを開始し、待たずに health を叩き続ける
        const upload = timed(`${BASE}/api/receipts/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportId: 1, filename: `perf_${kb}.jpg`, imageBase64: img })
        }).then((r) => { uploading = false; return r; });

        await sleep(80);   // アップロードがサーバに届くまで少し待つ
        while (uploading) {
            const h = await timed(`${BASE}/api/health`);
            latencies.push(h.ms);
            await sleep(30);
        }
        const up = await upload;
        const s = stat(latencies);
        console.log(
            `  ${String(kb + 'KB').padEnd(10)}  ${String(up.ms + 'ms').padEnd(12)}  ` +
            `${String(s.med + 'ms').padEnd(24)}  ${String(s.max + 'ms').padEnd(9)}  ${s.n}回`
        );
    }

    // ------------------------------------------------------------------
    // 3. レシートが付いた状態での一覧（N+1 と SELECT * の影響）
    // ------------------------------------------------------------------
    console.log('\n--- レシートを20件分の申請に添付してから再計測 ---');
    compose('restart', 'app');
    await waitForHealth();

    // 一覧の先頭に出る申請（id降順）にレシートを付ける
    const ids = psql('SELECT id FROM expense_reports ORDER BY id DESC LIMIT 20;')
        .split('\n').map((s) => s.trim()).filter(Boolean);
    const img = makeImage(800);
    for (const id of ids) {
        await timed(`${BASE}/api/receipts/upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportId: Number(id), filename: `list_${id}.jpg`, imageBase64: img })
        });
    }
    const rcount = psql('SELECT COUNT(*) FROM receipts;');
    console.log(`  レシート ${rcount} 件を添付しました`);

    await measureList('（レシートあり）');

    // ------------------------------------------------------------------
    // 4. 索引の有無
    // ------------------------------------------------------------------
    console.log('\n--- 一覧APIが1件ごとに実行するクエリの実行計画 ---');
    const plan = psql('EXPLAIN ANALYZE SELECT * FROM expense_items WHERE report_id = 3000;');
    console.log(plan.split('\n').map((l) => '  ' + l).join('\n'));
})();

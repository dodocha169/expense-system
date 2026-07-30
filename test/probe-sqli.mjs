/* 現状の注入成立状況を観測する（読み取りのみ。破壊的な操作は行わない） */
const BASE = process.env.BASE_URL || 'http://localhost:3100';

async function probe(label, url) {
    try {
        const res = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(60000) });
        const text = await res.text();
        let n = '-', extra = '';
        try {
            const j = JSON.parse(text);
            if (Array.isArray(j.data)) {
                n = j.data.length;
                const users = new Set(j.data.map((r) => r.user_id).filter((v) => v !== undefined));
                if (users.size) extra = ` 含まれる社員ID数=${users.size}`;
            } else if (j.data && Array.isArray(j.data.reports)) {
                n = j.data.reports.length;
            }
        } catch { n = `(非JSON ${text.length}文字)`; }
        console.log(`${label.padEnd(52)} HTTP ${res.status}  件数=${n}${extra}`);
    } catch (e) {
        console.log(`${label.padEnd(52)} 失敗: ${e.message}`);
    }
}

console.log('=== 正常系 ===');
await probe('status=submitted', '/api/reports?status=submitted&limit=5');
await probe('status=nosuchstatus', '/api/reports?status=nosuchstatus&limit=5');
await probe('department=営業部', `/api/users?department=${encodeURIComponent('営業部')}`);
await probe('summary 社員1 / 2026-07', '/api/summary/1/2026-07');

console.log('\n=== 注入の試行（読み取りのみ）===');
await probe("status=x' OR '1'='1", `/api/reports?limit=5&status=${encodeURIComponent("x' OR '1'='1")}`);
await probe("userId=0' OR '1'='1", `/api/reports?limit=5&userId=${encodeURIComponent("0' OR '1'='1")}`);
await probe('limit=(SELECT 3)', `/api/reports?limit=${encodeURIComponent('(SELECT 3)')}`);
await probe("department=x' OR '1'='1", `/api/users?department=${encodeURIComponent("x' OR '1'='1")}`);
await probe('summary userId=1 OR 1=1', `/api/summary/${encodeURIComponent('1 OR 1=1')}/2026-07`);
await probe("export month=x' OR '1'='1", `/api/export/${encodeURIComponent("x' OR '1'='1")}`);
await probe('receipts/abc/thumb', '/api/receipts/abc/thumb');

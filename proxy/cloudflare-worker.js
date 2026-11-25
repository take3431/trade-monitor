// TRADE MONITOR 用 CORS プロキシ（Cloudflare Workers・無料枠で動作）
// 使い方: Workers を新規作成 → このコードを貼り付けてデプロイ →
//        アプリ設定「CORSプロキシURL」に  https://<あなたのworker>.workers.dev/?url={url}  を入力
// Yahoo Finance 以外への中継は拒否します。必要なら ALLOW_ORIGIN を GitHub Pages の URL に限定してください。
const ALLOW_ORIGIN = '*'; // 例: 'https://yourname.github.io'
const ALLOW_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

export default {
  async fetch(req) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(req.url).searchParams.get('url');
    if (!target) return new Response('missing url', { status: 400, headers: cors });
    let u;
    try { u = new URL(target); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (u.protocol !== 'https:' || !ALLOW_HOSTS.includes(u.hostname)) {
      return new Response('forbidden', { status: 403, headers: cors });
    }
    const r = await fetch(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      cf: { cacheTtl: 30, cacheEverything: true },
    });
    const h = new Headers(cors);
    h.set('Content-Type', r.headers.get('Content-Type') || 'application/json');
    h.set('Cache-Control', 'public, max-age=30');
    return new Response(r.body, { status: r.status, headers: h });
  },
};

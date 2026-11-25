// データ取得・キャッシュ層
//  - Yahoo Finance v8 chart API（CORS プロキシ経由）
//  - メモリ + IndexedDB にチャートデータをキャッシュ
//  - 株価（現在値・前日比）は LocalStorage に保存し、起動直後から表示
import { isFresh, dayKey } from './market.js';

const YH1 = 'https://query1.finance.yahoo.com';
const YH2 = 'https://query2.finance.yahoo.com';

export const BUILTIN_PROXIES = [
  'https://corsproxy.io/?url={url}',
  'https://api.allorigins.win/raw?url={url}',
  'https://api.codetabs.com/v1/proxy?quest={url}',
];

// 足種ごとの取得条件
export const TF = {
  '5m': { label: '5分', title: '5分足 (5min)', interval: '5m', range: '5d', ma: [5, 25], ttlMul: 1,
    periods: [[66, '1日'], [132, '2日'], [330, '5日']], def: 132, short: '5m' },
  '1d': { label: '日足', title: '日足 (Daily)', interval: '1d', range: '2y', ma: [5, 25], ttlMul: 1,
    periods: [[63, '3ヶ月'], [126, '6ヶ月'], [250, '1年'], [490, '2年']], def: 126, short: '1D' },
  '1wk': { label: '週足', title: '週足 (Weekly)', interval: '1wk', range: '10y', ma: [13, 26], ttlMul: 3,
    periods: [[52, '1年'], [104, '2年'], [260, '5年'], [0, '全期間']], def: 104, short: '1W' },
  '1mo': { label: '月足', title: '月足 (Monthly)', interval: '1mo', range: 'max', ma: [12, 24], ttlMul: 3,
    periods: [[36, '3年'], [60, '5年'], [120, '10年'], [0, '全期間']], def: 120, short: '1M' },
};

const cfg = { proxy: BUILTIN_PROXIES[0], fallback: true, demo: false, ttlMs: 120e3, timeout: 12000 };
export function configure(o) { Object.assign(cfg, o); }
export function isDemo() { return cfg.demo; }

/* ---------------- HTTP ---------------- */
let preferred = null;

function proxied(tpl, url) {
  if (tpl === 'direct') return url;
  if (tpl.includes('{url}')) return tpl.replace('{url}', encodeURIComponent(url));
  if (tpl.includes('{rawurl}')) return tpl.replace('{rawurl}', url);
  return tpl + encodeURIComponent(url);
}

async function fetchJson(url) {
  let list = [];
  if (cfg.proxy) list.push(cfg.proxy.trim());
  if (cfg.fallback || !list.length) for (const p of BUILTIN_PROXIES) if (!list.includes(p)) list.push(p);
  if (preferred && list.includes(preferred)) list = [preferred, ...list.filter((p) => p !== preferred)];
  const reasons = [];
  for (const tpl of list) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
    let host = tpl;
    try { host = tpl === 'direct' ? 'direct' : new URL(tpl.replace(/\{(raw)?url\}/, '')).hostname; } catch { /* keep */ }
    try {
      const r = await fetch(proxied(tpl, url), { signal: ctrl.signal, cache: 'no-store' });
      if (!r.ok) {
        const why = r.status === 401 || r.status === 403 ? 'APIキー必要/拒否' : r.status === 429 ? '回数制限' : `HTTP ${r.status}`;
        throw new Error(why);
      }
      const j = await r.json();
      preferred = tpl;
      return j;
    } catch (e) {
      const why = e.name === 'AbortError' ? 'タイムアウト' : e instanceof SyntaxError ? '応答形式不正' : e.message === 'Failed to fetch' || e.name === 'TypeError' ? '接続不可' : e.message;
      reasons.push(`${host}: ${why}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error(reasons.join(' / ') || '取得失敗');
  err.proxyFailure = true;
  throw err;
}

/* ---------------- IndexedDB ---------------- */
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('trade-monitor', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('series');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
  }
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  if (!d) return null;
  return new Promise((res) => {
    try {
      const tx = d.transaction('series', mode);
      const q = fn(tx.objectStore('series'));
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    } catch { res(null); }
  });
}

const mem = new Map();
const keyOf = (code, tf) => `${cfg.demo ? 'demo|' : ''}${code}|${tf}`;

export async function getCached(code, tf) {
  const k = keyOf(code, tf);
  if (mem.has(k)) return mem.get(k);
  const v = await idb('readonly', (s) => s.get(k));
  if (v) mem.set(k, v);
  return v;
}

async function putCached(code, tf, entry) {
  const k = keyOf(code, tf);
  mem.set(k, entry);
  if (!cfg.demo) await idb('readwrite', (s) => s.put(entry, k));
}

export async function clearCache() {
  mem.clear();
  quotes.clear();
  saveQuotes();
  await idb('readwrite', (s) => s.clear());
}

/* ---------------- 株価（現在値）ストア ---------------- */
const QKEY = 'tm.quotes.v1';
const quotes = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem(QKEY)) || {}; } catch { return {}; } })()));
const demoQuotes = new Map();
function saveQuotes() { try { localStorage.setItem(QKEY, JSON.stringify(Object.fromEntries(quotes))); } catch { /* 容量超過等は無視 */ } }

export function getQuote(code) { return (cfg.demo ? demoQuotes : quotes).get(code) || null; }
export function removeQuote(code) { quotes.delete(code); saveQuotes(); }

export function quoteFrom(entry) {
  if (!entry) return null;
  const b = entry.bars;
  const meta = entry.meta || {};
  if (!b.length && meta.price == null) return null;
  const last = b[b.length - 1];
  const price = meta.price ?? last?.[4];
  const tTime = (meta.time || last?.[0] || 0) * 1000;
  let prev;
  if (last && dayKey(last[0] * 1000) === dayKey(tTime)) prev = b[b.length - 2]?.[4];
  else prev = last?.[4];
  if (prev == null) prev = meta.prevClose;
  const chg = prev != null ? price - prev : null;
  const pct = prev ? (chg / prev) * 100 : null;
  return { price, prev, chg, pct, time: tTime, name: meta.name || '', fetchedAt: entry.fetchedAt };
}

function storeQuote(code, entry) {
  const q = quoteFrom(entry);
  if (!q) return;
  (cfg.demo ? demoQuotes : quotes).set(code, q);
  if (!cfg.demo) saveQuotes();
}

/* ---------------- Yahoo 応答の整形 ---------------- */
function parseChart(json, tf) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'データなし');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const raw = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    raw.push([ts[i], o, h, l, c, q.volume?.[i] || 0]);
  }
  raw.sort((a, b) => a[0] - b[0]);
  // 同一期間の重複（Yahoo は最新期間を別タイムスタンプで返すことがある）を統合
  const bars = [];
  const periodKey = (t) => {
    const k = dayKey(t * 1000);
    if (tf === '1mo') return k.slice(0, 7);
    if (tf === '5m') return t;
    return k;
  };
  for (const bar of raw) {
    const prev = bars[bars.length - 1];
    const same = prev && (tf === '1wk' ? bar[0] - prev[0] < 6 * 86400 : periodKey(prev[0]) === periodKey(bar[0]));
    if (same) {
      bars[bars.length - 1] = [prev[0], prev[1], Math.max(prev[2], bar[2]), Math.min(prev[3], bar[3]), bar[4], Math.max(prev[5], bar[5])];
    } else {
      bars.push(bar);
    }
  }
  const m = r.meta || {};
  return {
    bars,
    meta: {
      price: m.regularMarketPrice ?? null,
      time: m.regularMarketTime ?? null,
      prevClose: m.previousClose ?? null,
      name: m.shortName || m.longName || '',
      exchange: m.fullExchangeName || m.exchangeName || '',
    },
  };
}

/* ---------------- デモデータ ---------------- */
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const tick = (p) => Math.round(p * 2) / 2;
const demoDailyCache = new Map();

function demoDaily(code) {
  if (demoDailyCache.has(code)) return demoDailyCache.get(code);
  const rnd = rng(hash(code));
  let p = 400 + rnd() * 6000;
  const bars = [];
  const today = dayKey(Date.now());
  for (let t = Date.UTC(2008, 0, 1); ; t += 86400e3) {
    const k = dayKey(t);
    if (k > today) break;
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const o = p * (1 + (rnd() - 0.5) * 0.01);
    const c = o * (1 + (rnd() - 0.495) * 0.035);
    const h = Math.max(o, c) * (1 + rnd() * 0.012);
    const l = Math.min(o, c) * (1 - rnd() * 0.012);
    const v = Math.round((0.5 + rnd() * 1.5) * 3e6 * (1 + Math.abs(c - o) / o * 20));
    bars.push([t / 1000, tick(o), tick(h), tick(l), tick(c), v]);
    p = c;
  }
  demoDailyCache.set(code, bars);
  return bars;
}

function aggregate(bars, keyFn) {
  const out = [];
  let cur = null, ck = null;
  for (const b of bars) {
    const k = keyFn(b[0]);
    if (k !== ck) { if (cur) out.push(cur); cur = [...b]; ck = k; continue; }
    cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += b[5];
  }
  if (cur) out.push(cur);
  return out;
}

function demoIntraday(daily, rnd) {
  const out = [];
  for (const d of daily.slice(-5)) {
    const steps = [];
    for (let m = 540; m < 690; m += 5) steps.push(m);
    for (let m = 750; m < 930; m += 5) steps.push(m);
    let p = d[1];
    const walk = steps.map(() => (p *= 1 + (rnd() - 0.5) * 0.004));
    const drift = (d[4] - walk[walk.length - 1]) / walk.length;
    let prev = d[1];
    steps.forEach((m, i) => {
      const c = tick(walk[i] + drift * (i + 1));
      const o = prev;
      out.push([d[0] + m * 60 - 9 * 3600, o, tick(Math.max(o, c) * (1 + rnd() * 0.0015)), tick(Math.min(o, c) * (1 - rnd() * 0.0015)), c, Math.round(rnd() * 2e5)]);
      prev = c;
    });
  }
  return out;
}

function demoSeries(code, tf) {
  const daily = demoDaily(code);
  let bars;
  if (tf === '1d') bars = daily.slice(-500);
  else if (tf === '1wk') bars = aggregate(daily, (t) => { const d = new Date(t * 1000); return t - ((d.getUTCDay() + 6) % 7) * 86400; });
  else if (tf === '1mo') bars = aggregate(daily, (t) => dayKey(t * 1000).slice(0, 7));
  else bars = demoIntraday(daily, rng(hash(code + 'i')));
  const last = daily[daily.length - 1];
  return { bars, meta: { price: last[4], time: last[0] + 6.5 * 3600, prevClose: null, name: '', exchange: 'Tokyo (Demo)' } };
}

/* ---------------- 公開 API ---------------- */
const inflight = new Map();

function ttlFor(tf) { return cfg.ttlMs * (TF[tf]?.ttlMul || 1); }

async function fetchSeries(code, tf) {
  const k = keyOf(code, tf);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    let parsed;
    if (cfg.demo) {
      await new Promise((r) => setTimeout(r, 120));
      parsed = demoSeries(code, tf);
    } else {
      const t = TF[tf];
      const url = `${YH1}/v8/finance/chart/${encodeURIComponent(code)}.T?interval=${t.interval}&range=${t.range}&includePrePost=false`;
      parsed = parseChart(await fetchJson(url), tf);
    }
    const entry = { ...parsed, fetchedAt: Date.now() };
    await putCached(code, tf, entry);
    if (tf === '1d') storeQuote(code, entry);
    return entry;
  })();
  inflight.set(k, p);
  try { return await p; } finally { inflight.delete(k); }
}

// 指定銘柄の必要な足種をまとめて取得（キャッシュ有効なら API を叩かない）
// 戻り値: { entries: {tf: entry|null}, fetched: bool, error: Error|null }
export async function loadSet(code, tfs, { force = false } = {}) {
  const entries = {};
  let fetched = false, error = null;
  await Promise.all(tfs.map(async (tf) => {
    const cached = await getCached(code, tf);
    entries[tf] = cached;
    if (!force && cached && isFresh(cached.fetchedAt, ttlFor(tf))) return;
    try {
      entries[tf] = await fetchSeries(code, tf);
      fetched = true;
    } catch (e) {
      error = e;
    }
  }));
  return { entries, fetched, error };
}

export async function cachedSet(code, tfs) {
  const entries = {};
  await Promise.all(tfs.map(async (tf) => { entries[tf] = await getCached(code, tf); }));
  return entries;
}

export async function searchRemote(q) {
  if (cfg.demo) return [];
  const url = `${YH2}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0&lang=ja-JP&region=JP`;
  const j = await fetchJson(url);
  return (j.quotes || [])
    .filter((x) => typeof x.symbol === 'string' && x.symbol.endsWith('.T'))
    .map((x) => ({ code: x.symbol.slice(0, -2), name: x.shortname || x.longname || '', source: 'Yahoo' }));
}

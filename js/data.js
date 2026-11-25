// データ取得・キャッシュ層
//
// 取得の工夫（チャートが出ない状態をなくすため）
//  1. 経路の複線化：Yahoo Finance へは複数の中継経路を用意し、成功率の高い順に使う。
//     応答が遅いときは別経路も並行して試し、先に返った方を採用する（ヘッジ要求）。
//     失敗した経路は一定時間休ませ、Yahoo の窓口 query1 / query2 も交互に使う。
//  2. 通信量の削減：日足10年分を1回だけ取得し、週足・月足はアプリ内で集計する。
//     以後は直近1か月分の小さなデータだけを取りに行き、手元のデータに継ぎ足す。
//  3. 優先度付きキュー：表示中 > 次の銘柄 > 裏での先回り取得 の順に通信し、同時通信数を制限する。
//  4. 保存済みデータは古くても必ず表示し（stale-while-revalidate）、裏で更新する。
import { isFresh, dayKey, marketPhase } from './market.js';
import { isUS } from './names.js';

// Yahoo のシンボル（日本株は .T を付ける。米国株はそのまま）
const ySym = (code) => (isUS(code) ? code : `${code}.T`);
const mkt = (code) => (isUS(code) ? 'US' : 'JP');

const YH = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

// 足種ごとの設定（1d/1wk/1mo は日足10年分から作る）
export const TF = {
  '5m': { label: '5分', title: '5分足 (5min)', ma: [5, 25],
    periods: [[66, '1日'], [132, '2日'], [330, '5日']], def: 132, short: '5m' },
  '1d': { label: '日足', title: '日足 (Daily)', ma: [5, 25],
    periods: [[63, '3ヶ月'], [126, '6ヶ月'], [250, '1年'], [490, '2年']], def: 126, short: '1D' },
  '1wk': { label: '週足', title: '週足 (Weekly)', ma: [13, 26],
    periods: [[52, '1年'], [104, '2年'], [260, '5年'], [0, '10年']], def: 104, short: '1W' },
  '1mo': { label: '月足', title: '月足 (Monthly)', ma: [12, 24],
    periods: [[36, '3年'], [60, '5年'], [0, '10年']], def: 0, short: '1M' },
};

const cfg = { proxy: '', fallback: true, demo: false, ttlMs: 120e3, timeout: 15000 };
export function configure(o) { Object.assign(cfg, o); }

/* ======================= 中継経路 ======================= */
const enc = encodeURIComponent;
const jsonBody = (t) => JSON.parse(t);
const ROUTES = [
  { id: 'jina', label: 'r.jina.ai', score: 0.9,
    build: (u) => `https://r.jina.ai/${u}`,
    parse: (t) => {
      const i = t.indexOf('{"chart"');
      const s = i >= 0 ? i : t.indexOf('{');
      if (s < 0) throw new Error('応答形式不正');
      return JSON.parse(t.slice(s, t.lastIndexOf('}') + 1));
    } },
  { id: 'allorigins-get', label: 'allorigins(get)', score: 0.4,
    build: (u) => `https://api.allorigins.win/get?url=${enc(u)}`,
    parse: (t) => JSON.parse(JSON.parse(t).contents) },
  { id: 'allorigins-raw', label: 'allorigins(raw)', score: 0.35,
    build: (u) => `https://api.allorigins.win/raw?url=${enc(u)}`, parse: jsonBody },
  { id: 'codetabs', label: 'codetabs', score: 0.3,
    build: (u) => `https://api.codetabs.com/v1/proxy?quest=${enc(u)}`, parse: jsonBody },
];
// 以前の設定で保存された公開プロキシは独自プロキシとして扱わない
const LEGACY = /corsproxy\.io|allorigins\.win|codetabs\.com/;

function customRoute() {
  const tpl = (cfg.proxy || '').trim();
  if (!tpl || LEGACY.test(tpl)) return null;
  if (!customRoute.r || customRoute.r.tpl !== tpl) {
    let label = 'custom';
    try { label = new URL(tpl.replace(/\{(raw)?url\}/, '')).hostname; } catch { /* keep */ }
    customRoute.r = {
      id: 'custom', label, tpl, score: 1,
      build: (u) => (tpl.includes('{url}') ? tpl.replace('{url}', enc(u)) : tpl.includes('{rawurl}') ? tpl.replace('{rawurl}', u) : tpl + enc(u)),
      parse: jsonBody,
    };
  }
  return customRoute.r;
}

const cooldown = new Map(); // id -> 再利用可能になる時刻

function routeOrder() {
  const c = customRoute();
  let list = c ? [c] : [];
  if (!c || cfg.fallback) list = list.concat(ROUTES);
  const now = Date.now();
  const ready = list.filter((r) => !(cooldown.get(r.id) > now)).sort((a, b) => b.score - a.score);
  if (ready.length) return ready;
  // 全部休止中なら、一番早く復帰するものを使う
  return list.sort((a, b) => (cooldown.get(a.id) || 0) - (cooldown.get(b.id) || 0)).slice(0, 1);
}

function routeOk(r) { r.score = r.score * 0.7 + 0.3; cooldown.delete(r.id); }
function routeFail(r, status) {
  r.score *= 0.6;
  const ms = status === 401 || status === 403 ? 30 * 60e3 : status === 429 ? 90e3 : 20e3;
  cooldown.set(r.id, Date.now() + ms);
  if (status === 429) pauseAll(15e3); // 回数制限を受けたら全体の通信も少し止める
}
export function routeStatus() {
  return [customRoute(), ...ROUTES].filter(Boolean).map((r) => `${r.label}: ${Math.round(r.score * 100)}%${cooldown.get(r.id) > Date.now() ? '（休止中）' : ''}`);
}

const HEDGE_MS = 4000;
let hostFlip = 0;

// 1件の Yahoo API 呼び出しを、経路を切り替えながら成功するまで試みる
function fetchYahoo(path) {
  const order = routeOrder();
  return new Promise((resolve, reject) => {
    let idx = 0, pending = 0, done = false;
    const errs = [], ctrls = [];
    let hedge = null;
    const finish = () => { done = true; clearTimeout(hedge); ctrls.forEach((c) => c.abort()); };
    const launch = () => {
      if (done || idx >= order.length) return;
      const r = order[idx++];
      const url = `${YH[hostFlip++ % 2]}${path}${path.includes('?') ? '&' : '?'}_=${Math.floor(Date.now() / 30000)}`;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
      pending++;
      (async () => {
        let status = 0;
        try {
          const res = await fetch(r.build(url), { signal: ctrl.signal, cache: 'no-store' });
          status = res.status;
          if (!res.ok) throw new Error(status === 401 || status === 403 ? '拒否' : status === 429 ? '回数制限' : `HTTP ${status}`);
          const json = r.parse(await res.text());
          if (!json || !json.chart) throw new Error('応答形式不正');
          if (done) return;
          routeOk(r);
          finish();
          resolve(json);
        } catch (e) {
          if (done) return;
          routeFail(r, status);
          const why = e.name === 'AbortError' ? 'タイムアウト' : e instanceof SyntaxError ? '応答形式不正' : e.name === 'TypeError' ? '接続不可' : e.message;
          errs.push(`${r.label}: ${why}`);
        } finally {
          clearTimeout(timer);
          pending--;
          if (!done) {
            if (idx < order.length) launch();
            else if (pending === 0) { finish(); reject(new Error(errs.join(' / ') || '取得失敗')); }
          }
        }
      })();
    };
    launch();
    hedge = setTimeout(launch, HEDGE_MS); // 遅いときは次の経路も並行して試す
  });
}

/* ======================= 優先度付きキュー ======================= */
export const PRIO = { show: 0, prefetch: 1, warm: 2 };
// 通信量の上限（中継先・Yahoo から制限されないための安全装置）
//  - 同時通信は2本まで、開始間隔は1.5秒以上
//  - 1分間に開始する通信は12回まで（表示中の銘柄は優先。裏の先回り取得は8回まで）
const MAX_ACTIVE = 2;
const MIN_GAP_MS = 1500;
const PER_MIN = 12;
const PER_MIN_WARM = 8;
let active = 0, lastStart = 0;
const starts = [];
const queue = [];
let hold = 0; // 回数制限を受けたら全体を一時停止する時刻
export function pauseAll(ms) { hold = Math.max(hold, Date.now() + ms); }

function schedule(prio, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ prio, fn, resolve, reject, t: Date.now() });
    queue.sort((a, b) => a.prio - b.prio || a.t - b.t);
    pump();
  });
}
function pump() {
  if (active >= MAX_ACTIVE || !queue.length) return;
  const now = Date.now();
  while (starts.length && now - starts[0] > 60e3) starts.shift();
  const limit = queue[0].prio === PRIO.warm ? PER_MIN_WARM : PER_MIN;
  let wait = Math.max(lastStart + MIN_GAP_MS - now, hold - now);
  if (starts.length >= limit) wait = Math.max(wait, starts[0] + 60e3 - now);
  if (wait > 0) { clearTimeout(pump.t); pump.t = setTimeout(pump, wait + 5); return; }
  const job = queue.shift();
  active++;
  lastStart = now;
  starts.push(now);
  job.fn().then(job.resolve, job.reject).finally(() => { active--; pump(); });
  pump();
}
export function isIdle() { return active === 0 && queue.length === 0; }

/* ======================= 保存（メモリ + IndexedDB） ======================= */
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
      const q = fn(d.transaction('series', mode).objectStore('series'));
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    } catch { res(null); }
  });
}
const mem = new Map();
const keyOf = (code, kind) => `${cfg.demo ? 'demo|' : ''}${code}|${kind}`;
async function getStored(code, kind) {
  const k = keyOf(code, kind);
  if (mem.has(k)) return mem.get(k);
  const v = await idb('readonly', (s) => s.get(k));
  if (v) mem.set(k, v);
  return v;
}
async function putStored(code, kind, v) {
  const k = keyOf(code, kind);
  mem.set(k, v);
  if (!cfg.demo) await idb('readwrite', (s) => s.put(v, k));
}
export async function clearCache() {
  mem.clear();
  derived.clear();
  await idb('readwrite', (s) => s.clear());
}

/* ======================= Yahoo 応答の整形 ======================= */
function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) {
    const e = new Error(`銘柄データなし（${json?.chart?.error?.description || json?.chart?.error?.code || '不明'}）`);
    e.noData = true;
    throw e;
  }
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push([ts[i], o, h, l, c, q.volume?.[i] || 0]);
  }
  bars.sort((a, b) => a[0] - b[0]);
  const m = r.meta || {};
  return { bars, meta: { price: m.regularMarketPrice ?? null, time: m.regularMarketTime ?? null, name: m.shortName || m.longName || '' } };
}

// 同じ日のバーは1本にまとめる（新しい方を採用）
function dedupeDaily(bars) {
  const out = [];
  for (const b of bars) {
    const last = out[out.length - 1];
    if (last && dayKey(last[0] * 1000) === dayKey(b[0] * 1000)) out[out.length - 1] = b;
    else out.push(b);
  }
  return out;
}
function mergeTail(base, tail) {
  if (!tail.length) return base;
  const from = dayKey(tail[0][0] * 1000);
  return dedupeDaily(base.filter((b) => dayKey(b[0] * 1000) < from).concat(tail));
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
const weekKey = (t) => { const d = new Date((t + 9 * 3600) * 1000); return dayKey((t - ((d.getUTCDay() + 6) % 7) * 86400) * 1000); };
const monthKey = (t) => dayKey(t * 1000).slice(0, 7);

// 日足は直近約2年分だけ保存し、週足・月足は10年分の集計結果を保存する（保存容量を約1/3に）
const KEEP_DAILY = 520;
function packBase(daily, prev, full) {
  const wkNew = aggregate(daily, weekKey);
  const moNew = aggregate(daily, monthKey);
  let wk = wkNew, mo = moNew;
  if (!full && prev) {
    // 継ぎ足し：手元の日足から作れる期間だけ差し替える（先頭の期間は途中からなので使わない）
    const splice = (old, fresh, keyFn) => {
      if (fresh.length < 2) return old || fresh;
      const from = keyFn(fresh[1][0]);
      return (old || []).filter((b) => keyFn(b[0]) < from).concat(fresh.slice(1));
    };
    const pw = prev.wk || aggregate(prev.bars, weekKey);
    const pm = prev.mo || aggregate(prev.bars, monthKey);
    wk = splice(pw, wkNew, weekKey);
    mo = splice(pm, moNew, monthKey);
  }
  return { bars: daily.slice(-KEEP_DAILY), wk, mo };
}

const derived = new Map();
function deriveEntry(code, base, tf) {
  if (!base) return null;
  if (tf === '1d') return base;
  if (tf === '1wk' && base.wk) return { ...base, bars: base.wk };
  if (tf === '1mo' && base.mo) return { ...base, bars: base.mo };
  const slot = `${keyOf(code, 'base')}|${tf}`;
  const hit = derived.get(slot);
  if (hit && hit.at === base.fetchedAt && hit.n === base.bars.length) return hit.v;
  const bars = aggregate(base.bars, tf === '1wk' ? weekKey : monthKey);
  const v = { ...base, bars };
  derived.set(slot, { at: base.fetchedAt, n: base.bars.length, v });
  return v;
}

/* ======================= デモデータ ======================= */
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const tick = (p) => Math.round(p * 2) / 2;
function demoDaily(code) {
  const rnd = rng(hash(code));
  let p = 400 + rnd() * 6000;
  const bars = [];
  const today = dayKey(Date.now());
  for (let t = Date.UTC(2016, 0, 4); dayKey(t) <= today; t += 86400e3) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const o = p * (1 + (rnd() - 0.5) * 0.01);
    const c = o * (1 + (rnd() - 0.495) * 0.035);
    const h = Math.max(o, c) * (1 + rnd() * 0.012);
    const l = Math.min(o, c) * (1 - rnd() * 0.012);
    bars.push([t / 1000, tick(o), tick(h), tick(l), tick(c), Math.round((0.5 + rnd() * 1.5) * 3e6)]);
    p = c;
  }
  return bars;
}
function demoIntraday(code) {
  const rnd = rng(hash(code + 'i'));
  const out = [];
  for (const d of demoDaily(code).slice(-5)) {
    let prev = d[1];
    const mins = [];
    for (let m = 540; m < 690; m += 5) mins.push(m);
    for (let m = 750; m < 930; m += 5) mins.push(m);
    mins.forEach((m, i) => {
      const target = d[1] + ((d[4] - d[1]) * (i + 1)) / mins.length;
      const c = tick(target * (1 + (rnd() - 0.5) * 0.004));
      out.push([d[0] + m * 60 - 9 * 3600, prev, tick(Math.max(prev, c) * 1.001), tick(Math.min(prev, c) * 0.999), c, Math.round(rnd() * 2e5)]);
      prev = c;
    });
  }
  return out;
}

/* ======================= 取得処理 ======================= */
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// 日足（10年分）を最新化する。手元にあれば直近1か月分だけ取得して継ぎ足す。
function refreshBase(code, prio) {
  return once(keyOf(code, 'base'), () => schedule(prio, async () => {
    const now = Date.now();
    if (cfg.demo) {
      const v = { ...packBase(demoDaily(code), null, true), meta: { name: '' }, fetchedAt: now, fullAt: now };
      await putStored(code, 'base', v);
      return v;
    }
    const base = await getStored(code, 'base');
    const lastT = base?.bars?.length ? base.bars[base.bars.length - 1][0] * 1000 : 0;
    const full = !base || !base.bars?.length || now - (base.fullAt || 0) > 30 * 86400e3 || now - lastT > 25 * 86400e3;
    const parsed = parseChart(await fetchYahoo(`/v8/finance/chart/${enc(ySym(code))}?interval=1d&range=${full ? '10y' : '1mo'}`));
    const daily = full ? dedupeDaily(parsed.bars) : mergeTail(base.bars, parsed.bars);
    const v = { ...packBase(daily, base, full), meta: parsed.meta, fetchedAt: now, fullAt: full ? now : base.fullAt };
    await putStored(code, 'base', v);
    return v;
  }));
}

function refreshIntraday(code, prio) {
  return once(keyOf(code, '5m'), () => schedule(prio, async () => {
    const now = Date.now();
    const bars = cfg.demo ? demoIntraday(code)
      : parseChart(await fetchYahoo(`/v8/finance/chart/${enc(ySym(code))}?interval=5m&range=5d`)).bars;
    const v = { bars, meta: {}, fetchedAt: now };
    await putStored(code, '5m', v);
    return v;
  }));
}

const kindOf = (tf) => (tf === '5m' ? '5m' : 'base');

// 保存済みデータ（古くても）をすぐ返す
export async function cachedSet(code, tfs) {
  const entries = {};
  for (const tf of tfs) entries[tf] = deriveEntry(code, await getStored(code, kindOf(tf)), tf === '5m' ? '1d' : tf);
  return entries;
}

// 必要なデータを最新化する。キャッシュが有効なら通信しない。
// maxAgeMs を指定すると「その時間より新しければ取得しない」（裏での先回り取得用）
// 失敗が続く銘柄（上場廃止・コード違いなど）は、間隔を空けてから再挑戦する
const failures = new Map(); // code -> { n, until }
export function failureOf(code) { return failures.get(code) || null; }

export async function loadSet(code, tfs, { force = false, onEntry = null, prio = PRIO.show, maxAgeMs = null } = {}) {
  const entries = await cachedSet(code, tfs);
  let fetched = false, error = null;
  const kinds = [...new Set(tfs.map(kindOf))];
  const market = mkt(code);
  const f = failures.get(code);
  // 表示中の銘柄は最短1分、裏の取得は 2,4,8…最大30分 空ける
  if (f && !force && Date.now() < (prio === PRIO.show ? Math.min(f.until, f.at + 60e3) : f.until)) {
    return { entries, fetched, error: f.error, skipped: true };
  }
  for (const kind of kinds) {
    const cur = await getStored(code, kind);
    const fresh = maxAgeMs != null && marketPhase(Date.now(), market).open
      ? cur && Date.now() - cur.fetchedAt < maxAgeMs
      : cur && isFresh(cur.fetchedAt, cfg.ttlMs, Date.now(), market);
    if (!force && fresh) continue;
    try {
      const v = kind === 'base' ? await refreshBase(code, prio) : await refreshIntraday(code, prio);
      for (const tf of tfs) if (kindOf(tf) === kind) entries[tf] = deriveEntry(code, v, tf === '5m' ? '1d' : tf);
      fetched = true;
      if (onEntry) onEntry({ ...entries });
    } catch (e) {
      error = e;
    }
  }
  if (error) {
    const n = (failures.get(code)?.n || 0) + 1;
    failures.set(code, { n, at: Date.now(), until: Date.now() + Math.min(30, 2 ** n) * 60e3, error });
  } else if (fetched) {
    failures.delete(code);
  }
  return { entries, fetched, error };
}

// 現在値（新規登録時の確認用）
export function quoteFrom(entry) {
  if (!entry?.bars?.length) return null;
  const last = entry.bars[entry.bars.length - 1];
  return { price: entry.meta?.price ?? last[4], name: entry.meta?.name || '' };
}

export async function searchRemote(q) {
  if (cfg.demo) return [];
  const json = await schedule(PRIO.show, async () => {
    const order = routeOrder();
    let last;
    for (const r of order) {
      try {
        const res = await fetch(r.build(`${YH[1]}/v1/finance/search?q=${enc(q)}&quotesCount=15&newsCount=0&lang=ja-JP&region=JP`), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t = await res.text();
        const i = t.indexOf('{');
        return r.id === 'allorigins-get' ? JSON.parse(JSON.parse(t).contents) : JSON.parse(t.slice(i, t.lastIndexOf('}') + 1));
      } catch (e) { last = e; }
    }
    throw last || new Error('検索失敗');
  });
  return (json.quotes || [])
    .filter((x) => typeof x.symbol === 'string' && /^(EQUITY|ETF)$/.test(x.quoteType || '')
      && (x.symbol.endsWith('.T') || /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/.test(x.symbol)))
    .map((x) => {
      const jp = x.symbol.endsWith('.T');
      return { code: jp ? x.symbol.slice(0, -2) : x.symbol, name: x.shortname || x.longname || '', market: jp ? '東証' : '米国' };
    });
}

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
import { isFresh, dayKey, dataLive } from './market.js?v=20261125113707';
import { isUS } from './names.js?v=20261125113707';

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

const cfg = {
  proxy: '', fallback: true, demo: false, ttlMs: 120e3, timeout: 15000,
  approxOpen: false,          // true：当日の始値を「最初の1分の値」で近似（表示対象が多いとき）
  upcoming: () => [],         // この先表示される銘柄（まとめて取得の対象を選ぶのに使う）
};
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

const HEDGE_MS = 6000;
let hostFlip = 0;

// 1件の Yahoo API 呼び出しを、経路を切り替えながら成功するまで試みる
/* ======================= 1日の通信回数の上限 =======================
   何があっても1日（日本時間0時区切り）300回を超えない。
   ・裏での初回読み込みは 240回まで（表示に必要な通信のために60回は残しておく）
   ・上限に達したら、その日は保存済みのデータで表示を続ける */
export const DAILY_CAP = 300;
const WARM_CAP = 240;
const BUDGET_KEY = 'tm.budget.v1';
let budget = { d: '', n: 0 };
try { budget = JSON.parse(localStorage.getItem(BUDGET_KEY)) || budget; } catch { /* ignore */ }
function budgetToday() {
  const today = dayKey(Date.now());
  if (budget.d !== today) budget = { d: today, n: 0 };
  return budget;
}
function useBudget(prio) {
  const b = budgetToday();
  if (b.n >= (prio === PRIO.warm ? WARM_CAP : DAILY_CAP)) return false;
  b.n++;
  try { localStorage.setItem(BUDGET_KEY, JSON.stringify(b)); } catch { /* ignore */ }
  return true;
}
export function budgetStatus() { const b = budgetToday(); return { used: b.n, cap: DAILY_CAP, over: b.n >= DAILY_CAP }; }
const overError = () => Object.assign(new Error('本日の通信上限（300回）に達しました'), { budget: true });

/* ======================= 通信の記録（画面の「通信状況」で表示） ======================= */
const LOG_MAX = 80;
const netLogList = [];
const netListeners = new Set();
const NET_DAY_KEY = 'tm.netcount.v1';
let netDay = { d: '', n: 0 };
try { netDay = JSON.parse(localStorage.getItem(NET_DAY_KEY)) || netDay; } catch { /* ignore */ }
let lastNetAt = 0;
export const onNetLog = (fn) => netListeners.add(fn);
export const netLog = () => netLogList;
function record(ev) {
  const today = dayKey(Date.now());
  if (netDay.d !== today) netDay = { d: today, n: 0 };
  netDay.n++;
  try { localStorage.setItem(NET_DAY_KEY, JSON.stringify(netDay)); } catch { /* ignore */ }
  lastNetAt = ev.t;
  netLogList.unshift(ev);
  if (netLogList.length > LOG_MAX) netLogList.pop();
  netListeners.forEach((f) => { try { f(ev); } catch { /* ignore */ } });
}
export function netStats() {
  const now = Date.now();
  const today = dayKey(now);
  return {
    lastMin: starts.filter((t) => now - t < 60e3).length,
    perMin: PER_MIN,
    today: netDay.d === today ? netDay.n : 0,
    active, queued: queue.length, lastAt: lastNetAt,
    pausedUntil: hold > now ? hold : 0,
  };
}

function fetchYahoo(path, ctx = {}, check = (j) => j && j.chart) {
  const order = routeOrder();
  return new Promise((resolve, reject) => {
    let idx = 0, pending = 0, done = false;
    const errs = [], ctrls = [];
    let hedge = null;
    const finish = () => { done = true; clearTimeout(hedge); ctrls.forEach((c) => c.abort()); };
    const launch = () => {
      if (done || idx >= order.length) return;
      if (!useBudget(ctx.prio)) {
        if (pending === 0) { finish(); reject(overError()); }
        return;
      }
      const r = order[idx++];
      const url = `${YH[hostFlip++ % 2]}${path}${path.includes('?') ? '&' : '?'}_=${Math.floor(Date.now() / 30000)}`;
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), cfg.timeout);
      pending++;
      (async () => {
        let status = 0;
        const t0 = Date.now();
        const ev = { t: t0, code: ctx.code || '', what: ctx.what || '', route: r.label, ok: false, ms: 0, note: '' };
        try {
          const res = await fetch(r.build(url), { signal: ctrl.signal, cache: 'no-store' });
          status = res.status;
          if (!res.ok) throw new Error(status === 401 || status === 403 ? '拒否' : status === 429 ? '回数制限' : `HTTP ${status}`);
          const json = r.parse(await res.text());
          if (!check(json)) throw new Error('応答形式不正');
          ev.ok = true; ev.ms = Date.now() - t0;
          if (done) { ev.note = '別経路が先に応答'; record(ev); return; }
          record(ev);
          routeOk(r);
          finish();
          resolve(json);
        } catch (e) {
          const why = e.name === 'AbortError' ? (done ? '中止（別経路が応答）' : 'タイムアウト') : e instanceof SyntaxError ? '応答形式不正' : e.name === 'TypeError' ? '接続不可' : e.message;
          ev.ms = Date.now() - t0; ev.note = why;
          record(ev);
          if (done) return;
          routeFail(r, status);
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
    // 遅いときは次の経路も並行して試す。ただし予備の経路が最近うまくいっている場合だけ（無駄打ちしない）
    hedge = setTimeout(() => { if (order[idx] && order[idx].score >= 0.5) launch(); }, HEDGE_MS);
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
  if (budgetStatus().over) { while (queue.length) queue.shift().reject(overError()); return; }
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
  let released = false;
  const release = () => { if (released) return; released = true; active--; pump(); };
  const guard = setTimeout(() => { job.reject(new Error('処理が長すぎるため中断')); release(); }, 60e3);
  Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { clearTimeout(guard); release(); });
  pump();
}
export function isIdle() { return active === 0 && queue.length === 0; }

/* ======================= 保存（メモリ + IndexedDB） ======================= */
let dbp = null;
const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
function resetDb() { const old = dbp; dbp = null; old?.then((d) => { try { d?.close(); } catch { /* ignore */ } }); }
function db() {
  if (!dbp) {
    dbp = withTimeout(new Promise((res, rej) => {
      const r = indexedDB.open('trade-monitor', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('series')) d.createObjectStore('series');
        // 目次：key -> 最終更新時刻（掃除のときに大きなデータを読まずに済むように）
        if (!d.objectStoreNames.contains('index')) d.createObjectStore('index');
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = resetDb;               // 接続が切れたら次回作り直す
        d.onversionchange = () => { d.close(); resetDb(); };
        res(d);
      };
      r.onerror = () => rej(r.error);
    }).catch(() => null), 4000, null);
  }
  return dbp;
}
let lastIdbError = '';
async function idb(mode, fn, store = 'series') {
  const d = await db();
  if (!d) { resetDb(); return null; }
  const op = new Promise((res) => {
    try {
      const q = fn(d.transaction(store, mode).objectStore(store));
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = (e) => { lastIdbError = q.error?.name || ''; e.preventDefault?.(); res(null); };
    } catch (e) { lastIdbError = e?.name || ''; if (e?.name !== 'QuotaExceededError') resetDb(); res(null); }
  });
  // 応答が無いときは諦める（保存済みデータはメモリにもあるので表示は続けられる）
  const v = await withTimeout(op, 3000, undefined);
  if (v === undefined) { resetDb(); return null; }
  return v;
}
// 使った順に並べ、上限を超えたら古いものから捨てる Map（保存先には残っているので、必要になれば読み直す）
class LRU extends Map {
  constructor(max) { super(); this.max = max; }
  get(k) { if (!super.has(k)) return undefined; const v = super.get(k); super.delete(k); super.set(k, v); return v; }
  set(k, v) { super.delete(k); super.set(k, v); while (this.size > this.max) super.delete(this.keys().next().value); return this; }
}
const MEM_MAX = 60;
const mem = new LRU(MEM_MAX);
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
  if (cfg.demo) return;
  let ok = await idb('readwrite', (s) => s.put(v, k));
  if (ok == null && lastIdbError === 'QuotaExceededError') {
    // 保存領域がいっぱい：不要なデータを掃除してからもう一度だけ試す（だめでもメモリ上のデータで表示は続く）
    await maintain({ aggressive: true });
    ok = await idb('readwrite', (s) => s.put(v, k));
  }
  if (ok != null) idb('readwrite', (s) => s.put(v.fetchedAt || Date.now(), k), 'index');
}
export async function clearCache() {
  mem.clear();
  derived.clear();
  await idb('readwrite', (s) => s.clear());
  await idb('readwrite', (s) => s.clear(), 'index');
}

/* ======================= 保存領域の掃除 =======================
   ・登録から外した銘柄のデータ：30日使わなければ削除（すぐ登録し直したときは差分だけで済むよう少し残す）
   ・5分足：3日以上更新していなければ削除（古い5分足は使わないため）
   ・旧版の形式のデータ・動作確認用のデータ：削除
   ・保存領域がいっぱいのとき：登録から外した銘柄をすべて削除し、それでも多ければ古いものから削除
   起動時と1日1回実行する。 */
let registered = () => [];
export function setRegistered(fn) { registered = fn; }
const KEEP_REMOVED_MS = 30 * 86400e3;
const KEEP_5M_MS = 3 * 86400e3;
const MAX_ENTRIES = 1300;
export async function maintain({ aggressive = false } = {}) {
  const keys = (await idb('readonly', (s) => s.getAllKeys())) || [];
  if (!keys.length) return { removed: 0, total: 0 };
  const stamps = new Map();
  const ikeys = (await idb('readonly', (s) => s.getAllKeys(), 'index')) || [];
  const ivals = (await idb('readonly', (s) => s.getAll(), 'index')) || [];
  ikeys.forEach((k, i) => stamps.set(k, ivals[i]));
  const reg = new Set(registered());
  const now = Date.now();
  const drop = [];
  const keepers = [];
  for (const k of keys) {
    const [code, kind, extra] = String(k).split('|');
    const at = stamps.get(k) || 0;
    if (extra !== undefined || code === 'demo' || (kind !== 'base' && kind !== '5m')) { drop.push(k); continue; } // 旧形式・デモ
    if (kind === '5m' && now - at > KEEP_5M_MS) { drop.push(k); continue; }
    if (!reg.has(code) && (aggressive || now - at > KEEP_REMOVED_MS)) { drop.push(k); continue; }
    keepers.push([k, at]);
  }
  const limit = aggressive ? Math.floor(MAX_ENTRIES * 0.8) : MAX_ENTRIES;
  if (keepers.length > limit) {
    keepers.sort((a, b) => a[1] - b[1]);
    drop.push(...keepers.slice(0, keepers.length - limit).map(([k]) => k));
  }
  for (const k of drop) {
    await idb('readwrite', (s) => s.delete(k));
    await idb('readwrite', (s) => s.delete(k), 'index');
    mem.delete(k);
  }
  return { removed: drop.length, total: keys.length - drop.length };
}
export async function storageInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const keys = (await idb('readonly', (s) => s.count())) || 0;
  return { usage: est?.usage || 0, quota: est?.quota || 0, entries: keys };
}
// 保存データをブラウザに自動で消されにくくする（対応ブラウザのみ）
navigator.storage?.persist?.().catch(() => {});

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

const derived = new LRU(MEM_MAX * 2);
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
    let full = !base || !base.bars?.length || now - (base.fullAt || 0) > 30 * 86400e3 || now - lastT > 25 * 86400e3;
    // 継ぎ足しは通常「直近5日分」だけ（約1KB）。4日以上空いたときは1か月分
    const range = full ? '10y' : now - lastT < 4 * 86400e3 ? '5d' : '1mo';
    const why = !base?.bars?.length ? '日足10年分（初回）' : base.fullAt === 0 ? '日足10年分（分割・併合の反映）' : '日足10年分（定期の取り直し）';
    let parsed = parseChart(await fetchYahoo(`/v8/finance/chart/${enc(ySym(code))}?interval=1d&range=${range}`,
      { code, prio, what: full ? why : `日足の更新（直近${range === '5d' ? '5日' : '1か月'}）` }));
    // 継ぎ足し分に含まれる確定済みの過去の終値が、保存済みと食い違えば分割・併合 → 10年分を取り直す
    if (!full && splitDetected(base.bars, parsed.bars.slice(0, -1).map((b) => [b[0], b[4]]))) {
      full = true;
      parsed = parseChart(await fetchYahoo(`/v8/finance/chart/${enc(ySym(code))}?interval=1d&range=10y`,
        { code, prio, what: '日足10年分（分割・併合を検知して取り直し）' }));
    }
    const daily = full ? dedupeDaily(parsed.bars) : mergeTail(base.bars, parsed.bars);
    // 値が前回と同じ（取引が無かった等）なら、保存済みのデータは書き換えず取得時刻だけ更新する
    const lastOld = base?.bars?.[base.bars.length - 1];
    const lastNew = daily[daily.length - 1];
    if (!full && lastOld && lastNew && base.bars.length && lastOld.join() === lastNew.join() && base.meta?.price === parsed.meta.price) {
      const same = { ...base, fetchedAt: now, unchanged: true };
      mem.set(keyOf(code, 'base'), same);
      return same;
    }
    const v = { ...packBase(daily, base, full), meta: parsed.meta, fetchedAt: now, fullAt: full ? now : base.fullAt };
    await putStored(code, 'base', v);
    return v;
  }));
}

function refreshIntraday(code, prio) {
  return once(keyOf(code, '5m'), () => schedule(prio, async () => {
    const now = Date.now();
    const bars = cfg.demo ? demoIntraday(code)
      : parseChart(await fetchYahoo(`/v8/finance/chart/${enc(ySym(code))}?interval=5m&range=5d`, { code, prio, what: '5分足' })).bars;
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
  entries.quote = quoteOfBase(await getStored(code, 'base'));
  return entries;
}

// 必要なデータを最新化する。キャッシュが有効なら通信しない。
// maxAgeMs を指定すると「その時間より新しければ取得しない」（裏での先回り取得用）
/* ======================= まとめて取得（最大20銘柄を1回の通信で更新） =======================
   Yahoo の spark 窓口で、現在値・当日の高値/安値・出来高・直近5日の終値をまとめて取る。
   当日の足は「始値」だけ取れないので、
     ・すでに当日の足を持っていれば（その日2回目以降）始値はそのまま使う
     ・持っていなければ：通常は1銘柄ずつ通常の方法で取得（正確）
                        表示対象が多いときは、最初の1分の値で近似（まとめて1回）
   過去の足が抜けている銘柄（久しぶりに表示する等）は、1銘柄ずつ通常の方法で不足分だけ取得する。 */
const BATCH_MAX = 20;
const batchWaiters = new Map(); // code -> 進行中のまとめて取得
const openCache = new LRU(400); // `${code}|${日付}` -> 近似の始値

function sparkResults(json) {
  const out = new Map();
  for (const r of json?.spark?.result || []) {
    const x = r?.response?.[0];
    if (x?.meta && x.timestamp?.length) out.set(r.symbol, x);
  }
  return out;
}

// 1銘柄分の spark の結果を、保存済みの日足に反映する。反映できなければ理由を返す
/* 株式分割・併合の検知
   Yahoo の過去の株価は、分割・併合があると分割後の基準に書き換わる。手元に保存した過去分は古い基準のままなので、
   そのまま継ぎ足すとチャートに段差ができる。新しく届いた「確定済みの過去の終値」と保存済みの終値を同じ日で比べ、
   3%以上食い違う日があれば分割・併合が起きたと判断して、その銘柄だけ10年分を取り直す（追加の通信は取り直しの1回だけ）。
   ※通常、確定済みの終値は変わらない（配当では close は調整されない）。 */
const SPLIT_TOLERANCE = 0.03;
function splitDetected(storedBars, pairs) {
  // pairs: [[timestamp(秒), 終値], ...]（当日分は値が動くので含めない）
  if (!storedBars?.length || !pairs.length) return false;
  const byDay = new Map(storedBars.slice(-40).map((b) => [dayKey(b[0] * 1000), b[4]]));
  for (const [t, c] of pairs) {
    const old = byDay.get(dayKey(t * 1000));
    if (old == null || c == null || !old || !c) continue;
    if (Math.abs(old / c - 1) > SPLIT_TOLERANCE) return true;
  }
  return false;
}
const needsFull = (b) => !b?.bars?.length || Date.now() - (b.fullAt || 0) > 30 * 86400e3;

function mergeSpark(base, x, approxOpen) {
  const ts = x.timestamp;
  const lastT = ts[ts.length - 1];
  const today = dayKey(lastT * 1000);
  const bars = base.bars;
  const last = bars[bars.length - 1];
  const lastDay = dayKey(last[0] * 1000);
  // 当日より前の足が手元にそろっているか（そろっていなければ通常の方法で不足分を取る）
  if (lastDay > today) return { need: 'gap' };
  if (ts.length >= 2 && lastDay < dayKey(ts[ts.length - 2] * 1000)) return { need: 'gap' };
  const m = x.meta;
  const closes = x.indicators?.quote?.[0]?.close || [];
  // 当日より前の終値（確定済み）を保存済みの値と比べて、分割・併合を検知
  if (splitDetected(bars, ts.slice(0, -1).map((t, i) => [t, closes[i]]))) return { need: 'split' };
  const price = m.regularMarketPrice ?? closes[closes.length - 1];
  if (price == null) return { need: 'gap' };
  let open;
  if (lastDay === today) open = last[1];
  else if (approxOpen) open = openCache.get(`${x.meta.symbol}|${today}`);
  if (open == null) return { need: 'open' };
  const high = Math.max(m.regularMarketDayHigh ?? price, open, price);
  const low = Math.min(m.regularMarketDayLow ?? price, open, price);
  const bar = [lastDay === today ? last[0] : lastT, open, high, low, price, m.regularMarketVolume ?? (lastDay === today ? last[5] : 0)];
  const daily = lastDay === today ? bars.slice(0, -1).concat([bar]) : bars.concat([bar]);
  return { daily, meta: { ...base.meta, price, time: m.regularMarketTime ?? base.meta?.time } };
}

// 近似の始値：当日の1分足の最初の値（まとめて1回）
async function fetchApproxOpens(codes, prio) {
  if (!codes.length) return;
  const json = await fetchYahoo(`/v7/finance/spark?symbols=${codes.map((c) => enc(ySym(c))).join(',')}&range=1d&interval=1m`,
    { code: `${codes.length}銘柄`, prio, what: '当日の始値（近似）' }, (j) => j && j.spark);
  for (const [sym, x] of sparkResults(json)) {
    const first = (x.indicators?.quote?.[0]?.close || []).find((v) => v != null);
    if (first == null) continue;
    const code = sym.endsWith('.T') ? sym.slice(0, -2) : sym;
    openCache.set(`${sym}|${dayKey(x.timestamp[0] * 1000)}`, first);
    openCache.set(`${ySym(code)}|${dayKey(x.timestamp[0] * 1000)}`, first);
  }
}

// codes をまとめて更新する。まとめて更新できなかった銘柄は Set で返す（呼び出し側が個別に取得）
async function runBatch(codes, prio) {
  const now = Date.now();
  const bases = new Map();
  for (const c of codes) bases.set(c, await getStored(c, 'base'));
  const json = await schedule(prio, () => fetchYahoo(
    `/v7/finance/spark?symbols=${codes.map((c) => enc(ySym(c))).join(',')}&range=5d&interval=1d`,
    { code: codes.length === 1 ? codes[0] : `${codes.length}銘柄`, prio, what: 'まとめて更新' }, (j) => j && j.spark));
  const results = sparkResults(json);
  const leftover = new Set();
  const needOpen = [];
  const pending = [];
  for (const c of codes) {
    const x = results.get(ySym(c));
    const base = bases.get(c);
    if (!x || !base?.bars?.length) { leftover.add(c); continue; }
    const m = mergeSpark(base, x, cfg.approxOpen);
    if (m.need === 'open' && cfg.approxOpen) { needOpen.push(c); pending.push([c, x, base]); continue; }
    if (m.need === 'split') {
      // 取り直すまでの間も表示は続けられるよう、データは残したまま「要取り直し」の印を付ける
      record({ t: Date.now(), code: c, what: '株式分割・併合を検知（次の表示で10年分を取り直し）', route: '—', ok: true, ms: 0, note: '' });
      await putStored(c, 'base', { ...base, fullAt: 0, fetchedAt: 0 });
      leftover.add(c);
      continue;
    }
    if (m.need) { leftover.add(c); continue; }
    await saveMerged(c, base, m, now);
  }
  if (needOpen.length) {
    try { await schedule(prio, () => fetchApproxOpens(needOpen, prio)); } catch { /* 取れなければ個別取得へ */ }
    for (const [c, x, base] of pending) {
      const m = mergeSpark(base, x, true);
      if (m.need) leftover.add(c); else await saveMerged(c, base, m, now);
    }
  }
  return leftover;
}

async function saveMerged(code, base, m, now) {
  const last = base.bars[base.bars.length - 1];
  const nl = m.daily[m.daily.length - 1];
  if (last.join() === nl.join() && base.meta?.price === m.meta.price) {
    mem.set(keyOf(code, 'base'), { ...base, fetchedAt: now, unchanged: true });
    return;
  }
  await putStored(code, 'base', { ...packBase(m.daily, base, false), meta: m.meta, fetchedAt: now, fullAt: base.fullAt });
}

// code の更新を、この先表示される銘柄と一緒にまとめて行う（最大20銘柄）
// 当日の足をすでに持っているか（最後の足が20時間以内に始まったもの＝直近の取引日の足）
const hasTodayBar = (b) => Date.now() - b.bars[b.bars.length - 1][0] * 1000 < 20 * 3600e3;

async function refreshViaBatch(code, prio) {
  if (batchWaiters.has(code)) return batchWaiters.get(code);
  const now = Date.now();
  const own = await getStored(code, 'base');
  // 正確モードで当日の足が無い（その日初めての更新）なら、まとめて取得では始値が取れないので個別に取得
  if (needsFull(own)) return true;
  if (!cfg.approxOpen && !hasTodayBar(own)) return true;
  const list = [code];
  for (const c of cfg.upcoming()) {
    if (list.length >= BATCH_MAX) break;
    if (list.includes(c) || batchWaiters.has(c)) continue;
    const b = await getStored(c, 'base');
    if (!b?.bars?.length || isFresh(b.fetchedAt, cfg.ttlMs, now, mkt(c))) continue;
    if (needsFull(b)) continue; // 10年分の取り直しが必要な銘柄は、表示するときに個別に取得する
    if (!cfg.approxOpen && !hasTodayBar(b)) continue; // その銘柄を表示するときに個別に取得する
    list.push(c);
  }
  const p = runBatch(list, prio);
  for (const c of list) batchWaiters.set(c, p.then((left) => left.has(c)));
  try { await p; } finally { for (const c of list) batchWaiters.delete(c); }
  return (await p).has(code);
}

// 失敗が続く銘柄（上場廃止・コード違いなど）は、間隔を空けてから再挑戦する
const failures = new Map(); // code -> { n, until }
export function failureOf(code) { return failures.get(code) || null; }

export async function loadSet(code, tfs, { force = false, onEntry = null, prio = PRIO.show, maxAgeMs = null } = {}) {
  const entries = await cachedSet(code, tfs);
  let fetched = false, error = null, changed = false;
  const kinds = [...new Set(tfs.map(kindOf))];
  const market = mkt(code);
  const f = failures.get(code);
  // 表示中の銘柄は最短1分、裏の取得は 2,4,8…最大30分 空ける
  if (f && !force && Date.now() < (prio === PRIO.show ? Math.min(f.until, f.at + 60e3) : f.until)) {
    return { entries, fetched, error: f.error, skipped: true };
  }
  for (const kind of kinds) {
    const cur = await getStored(code, kind);
    const fresh = maxAgeMs != null && dataLive(Date.now(), market)
      ? cur && Date.now() - cur.fetchedAt < maxAgeMs
      : cur && isFresh(cur.fetchedAt, kind === '5m' ? Math.max(cfg.ttlMs, 5 * 60e3) : cfg.ttlMs, Date.now(), market);
    if (!force && fresh) continue;
    try {
      let v;
      if (kind === 'base' && cur?.bars?.length && !force && !cfg.demo && Date.now() - (cur.fullAt || 0) < 30 * 86400e3) {
        // まとめて取得で更新。できなかった場合（当日の始値が無い・過去の足が抜けている）だけ個別に取得
        let left = true;
        try { left = await refreshViaBatch(code, prio); } catch (e) { if (e.budget) throw e; }
        v = left ? await refreshBase(code, prio) : mem.get(keyOf(code, 'base'));
      } else {
        v = kind === 'base' ? await refreshBase(code, prio) : await refreshIntraday(code, prio);
      }
      for (const tf of tfs) if (kindOf(tf) === kind) entries[tf] = deriveEntry(code, v, tf === '5m' ? '1d' : tf);
      if (kind === 'base') entries.quote = quoteOfBase(v);
      if (!v.unchanged) changed = true;
      fetched = true;
      if (onEntry) onEntry({ ...entries });
    } catch (e) {
      error = e;
    }
  }
  if (error && !error.budget) {
    const n = (failures.get(code)?.n || 0) + 1;
    failures.set(code, { n, at: Date.now(), until: Date.now() + Math.min(30, 2 ** n) * 60e3, error });
  } else if (fetched) {
    failures.delete(code);
  }
  return { entries, fetched, changed, error };
}

// 現在値（新規登録時の確認用）
export function quoteFrom(entry) {
  if (!entry?.bars?.length) return null;
  const last = entry.bars[entry.bars.length - 1];
  return { price: entry.meta?.price ?? last[4], name: entry.meta?.name || '' };
}

// 現在値・前日比：取得済みの日足から計算する（追加の通信はしない）
//  現在値 = Yahoo の最新値（無ければ最後の日足の終値）
//  前日終値 = 最新値と同じ日の足があればその1本前、無ければ最後の足の終値
function quoteOfBase(base) {
  const b = base?.bars;
  if (!b?.length) return null;
  const last = b[b.length - 1];
  const price = base.meta?.price ?? last[4];
  // 最新値の時刻が最後の日足の開始から24時間以内なら「同じ日の足」（米国株は日本と日付がずれるため時刻差で判定）
  const t = base.meta?.time || last[0];
  const sameSession = t >= last[0] && t - last[0] < 86400;
  const prev = sameSession ? b[b.length - 2]?.[4] : last[4];
  if (price == null || prev == null) return { price, chg: null, pct: null };
  return { price, chg: price - prev, pct: prev ? ((price - prev) / prev) * 100 : null };
}

const searchCache = new LRU(50); // 検索語 -> { at, json }
export async function searchRemote(q) {
  if (cfg.demo) return [];
  const key = q.trim().toLowerCase();
  const hit = searchCache.get(key);
  const json = hit && Date.now() - hit.at < 10 * 60e3 ? hit.json : await schedule(PRIO.show, async () => {
    const order = routeOrder();
    let last;
    for (const r of order) {
      if (!useBudget(PRIO.show)) throw overError();
      const t0 = Date.now();
      const ev = { t: t0, code: '', what: `銘柄検索「${q}」`, route: r.label, ok: false, ms: 0, note: '' };
      try {
        const res = await fetch(r.build(`${YH[1]}/v1/finance/search?q=${enc(q)}&quotesCount=15&newsCount=0&lang=ja-JP&region=JP`), { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const t = await res.text();
        const i = t.indexOf('{');
        const j = r.id === 'allorigins-get' ? JSON.parse(JSON.parse(t).contents) : JSON.parse(t.slice(i, t.lastIndexOf('}') + 1));
        ev.ok = true; ev.ms = Date.now() - t0; record(ev);
        return j;
      } catch (e) { last = e; ev.ms = Date.now() - t0; ev.note = e.message; record(ev); }
    }
    throw last || new Error('検索失敗');
  });
  if (!hit || hit.json !== json) searchCache.set(key, { at: Date.now(), json });
  return (json.quotes || [])
    .filter((x) => typeof x.symbol === 'string' && /^(EQUITY|ETF)$/.test(x.quoteType || '')
      && (x.symbol.endsWith('.T') || /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/.test(x.symbol)))
    .map((x) => {
      const jp = x.symbol.endsWith('.T');
      return { code: jp ? x.symbol.slice(0, -2) : x.symbol, name: x.shortname || x.longname || '', market: jp ? '東証' : '米国' };
    });
}

// 動作確認用（通常の画面からは使わない）
export const _debug = { mem, keyOf };

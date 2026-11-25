import * as M from './market.js?v=20261125164254';
import * as D from './data.js?v=20261125164254';
import { Stage, themeColors } from './chart.js?v=20261125164254';
import { parsePrice, fmtNum, crossed, unlockAudio, playAlarm, stopAlarm, alarmPlaying, showAlertCard, initAlertCards } from './alerts.js?v=20261125164254';
import { lookupName, searchLocal, loadDict, dictReady, cleanQuery, isUS, isIndex, marketOfCode, JP_RE, US_RE } from './names.js?v=20261125164254';

const MAX_SYMBOLS = 999;
const KEY = { list: 'tm.list.v1', settings: 'tm.settings.v1', state: 'tm.state.v1' };
const TOUCH_HOLD_MS = 10000;   // 画面操作後、自動巡回を止めておく時間
const NAV_FETCH_DELAY = 350;   // 前/次の連打対策：表示が落ち着いてから通信する

const DEFAULTS = {
  interval: 30, offHours: 'continue',
  leftTf: '1d', rightTf: '1mo', leftBars: 126, rightBars: 120,
  ind: { ma: true, bb: false, vol: true },
  theme: 'dark', colorMode: 'jp', font: 'm', wakeLock: true,
  alertPopup: true, alertSound: true, alertSec: 10,
};
// 画面に出さない固定値
const CACHE_MIN = 2;      // 場中のキャッシュ有効時間（分）の基本。銘柄数・切り替え間隔に応じて自動で延ばす（dataPlan）
const PREFETCH_SEC = 30;  // 次の銘柄を何秒前に取得するか
const DEMO = new URLSearchParams(location.search).has('demo'); // 動作確認用（URL に ?demo を付けたときだけ）
const DEFAULT_LIST = [
  ['7203', 'トヨタ自動車', true], ['9984', 'ソフトバンクグループ', true], ['6758', 'ソニーグループ', true],
  ['8306', '三菱UFJフィナンシャル・グループ', true], ['6861', 'キーエンス', true], ['8035', '東京エレクトロン', true],
  ['9983', 'ファーストリテイリング', false], ['7974', '任天堂', false],
].map(([code, name, enabled]) => ({ code, name, enabled }));

const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const frames = (n = 2) => Promise.race([
  new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
  new Promise((r) => setTimeout(r, 250)),
]);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 保存データの検査 ----------------
   保存データが壊れていたり、貼り付けで読み込んだデータに想定外の値が入っていても、
   決められた項目・形式だけを取り出して使う（不具合や不正な値の混入を防ぐ）。 */
const TF_KEYS = ['5m', '1d', '1wk', '1mo'];
function cleanSettings(raw) {
  const s = { ...DEFAULTS, ind: { ...DEFAULTS.ind } };
  if (!raw || typeof raw !== 'object') return s;
  const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  s.interval = int(raw.interval, 5, 300, DEFAULTS.interval);
  s.offHours = raw.offHours === 'stop' ? 'stop' : 'continue';
  s.leftTf = TF_KEYS.includes(raw.leftTf) ? raw.leftTf : DEFAULTS.leftTf;
  s.rightTf = TF_KEYS.includes(raw.rightTf) ? raw.rightTf : DEFAULTS.rightTf;
  s.leftBars = int(raw.leftBars, 0, 5000, DEFAULTS.leftBars);
  s.rightBars = int(raw.rightBars, 0, 5000, DEFAULTS.rightBars);
  const ind = raw.ind && typeof raw.ind === 'object' ? raw.ind : {};
  s.ind = { ma: ind.ma !== undefined ? !!ind.ma : DEFAULTS.ind.ma, bb: !!ind.bb, vol: ind.vol !== undefined ? !!ind.vol : DEFAULTS.ind.vol };
  s.theme = raw.theme === 'light' ? 'light' : 'dark';
  s.colorMode = raw.colorMode === 'us' ? 'us' : 'jp';
  s.font = ['s', 'm', 'l'].includes(raw.font) ? raw.font : 'm';
  s.wakeLock = raw.wakeLock !== undefined ? !!raw.wakeLock : DEFAULTS.wakeLock;
  s.alertPopup = raw.alertPopup !== undefined ? !!raw.alertPopup : DEFAULTS.alertPopup;
  s.alertSound = raw.alertSound !== undefined ? !!raw.alertSound : DEFAULTS.alertSound;
  s.alertSec = int(raw.alertSec, 3, 120, DEFAULTS.alertSec);
  return s;
}
function cleanList(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || typeof x.code !== 'string') continue;
    const code = x.code.trim().toUpperCase().slice(0, 10);
    if (!(JP_RE.test(code) || US_RE.test(code) || isIndex(code)) || seen.has(code)) continue;
    seen.add(code);
    const item = { code, name: typeof x.name === 'string' ? x.name.slice(0, 120) : '', enabled: x.enabled !== false };
    // アラート：ON/OFF と設定株価（設定株価が無い銘柄は項目ごと持たない）
    const ap = Number(x.alertPrice);
    if (Number.isFinite(ap) && ap > 0) item.alertPrice = ap;
    if (x.alertOn && item.alertPrice) item.alertOn = true;
    out.push(item);
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

/* ---------------- 状態 ---------------- */
const settings = cleanSettings(load(KEY.settings, {}));
let list = cleanList(load(KEY.list, null)) || DEFAULT_LIST;
if (JSON.stringify(list) !== JSON.stringify(load(KEY.list, null))) save(KEY.list, list); // 検査済みの形で保存し直す
// 使わなくなった旧版の保存項目を消す
['tm.quotes.v1', 'tm.hint.home.v1', 'tm.hint.home.v2'].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
const saved = load(KEY.state, {});
const st = {
  code: saved.code || null, paused: !!saved.paused, remaining: settings.interval,
  touchUntil: 0, settingsOpen: false, lastError: null, seq: 0, prefetching: null,
};
const stages = [new Stage($('stageA')), new Stage($('stageB'))];
let front = 0;

const persistState = () => save(KEY.state, { code: st.code, paused: st.paused });
const saveList = () => { save(KEY.list, list); if (st.settingsOpen) setTimeout(updateDirty, 0); };
const neededTfs = () => [...new Set([settings.leftTf, settings.rightTf])];

/* ---------------- 設定の反映 ---------------- */
function applyLook() {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.dataset.font = settings.font;
  r.dataset.color = settings.colorMode;
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'dark' ? '#0d1117' : '#f4f6f9';
  $('demoBadge').hidden = !DEMO;
}
// 表示対象がこの数を超えたら、当日の始値を近似にして通信回数を抑える（1日300回の上限に収めるため）
const EXACT_OPEN_MAX = 50; // 1銘柄ずつ始値を取ると、それだけで1日の通信が銘柄数ぶん増えるため

/* ---------------- データ取得の計画（通信量を1日約3.5MB以内に収める） ----------------
   表示対象の銘柄数と切り替え間隔から、取引時間中の更新間隔・始値の取り方・定期の取り直し間隔を決める。
   200銘柄までは今までどおり（2分ごと・始値は1分の値）。それを超えると段階的に粗くする。
   切り替えが速い（10秒など）ときも、通信量が増えすぎないよう更新間隔を延ばす（切り替えと通信は切り離す）。
   通信量の見積もり（実測値。応答＋要求の見出し込み）：
     まとめて更新 1銘柄あたり1.23KB ＋ 1回あたり1.4KB ／ 1銘柄ずつの始値 2.4KB
     始値のまとめて取得 1銘柄あたり 1分足6.6KB・5分足2.4KB・15分足1.7KB ／ 10年分 158KB */
const DATA_TARGET_KB = 3500; // 始値の取り方を選ぶときの目標（200銘柄までは4,000KB）
const DATA_LIMIT_KB = 4000;  // これを超えるときだけ、取引時間中の更新間隔を延ばす
const LIVE_MIN = 330; // 東証のデータが動く時間（9:20〜11:50・12:50〜15:50）
const TIERS = [ // [銘柄数まで, 更新間隔（分）, 始値の取り方の候補（良い順）, 定期の取り直し（日）]
  [50, 2, ['exact'], 150],
  [200, 2, ['1m', '5m', '15m', 'prev'], 150],
  [400, 3, ['5m', '15m', 'prev'], 300],
  [700, 4, ['15m', 'prev'], 300],
  [Infinity, 5, ['15m', 'prev'], 300],
];
const OPEN_KB = { exact: 2.4, '1m': 6.6, '5m': 2.4, '15m': 1.7, prev: 0 };
function dataPlan(n = enabledCount(), interval = settings.interval) {
  const [, tierMin, modes, fullDays] = TIERS.find(([max]) => n <= max);
  const displays = (LIVE_MIN * 60) / interval;        // 取引時間中に表示する回数
  const shown = Math.min(n, displays);                // 取引時間中に1回以上表示する銘柄の数
  const fixed = (mode) => (mode === 'exact' ? n * OPEN_KB.exact : shown * OPEN_KB[mode] + (shown / 20) * 1.4)
    + n * 1.3 + (n / fullDays) * 158;                // 始値＋引け後の更新＋定期の取り直し
  const liveKB = (ttl) => { const r = Math.min(displays, (n * LIVE_MIN) / ttl); return r * 1.23 + Math.max(LIVE_MIN / ttl, r / 20) * 1.4; };
  // 始値はなるべく良い取り方で。目標に収まらなければ粗くし、上限も超えるときだけ更新間隔を延ばす
  const target = n <= 200 ? DATA_LIMIT_KB : DATA_TARGET_KB;
  // 切り替えが20秒より速いときは、同じ銘柄を表示するたびには更新しない（k回の表示に1回。5秒なら4回に1回）。
  // 銘柄が少なくても、切り替えを速くしただけで通信が増えないようにする
  const skip = interval < 20 ? Math.ceil(20 / interval) : 1;
  const baseTtl = Math.max(tierMin, skip > 1 ? ((skip - 0.5) * n * interval) / 60 : 0);
  let mode = modes[modes.length - 1];
  for (const m of modes) if (fixed(m) + liveKB(baseTtl) <= target) { mode = m; break; }
  let ttl = baseTtl;
  while (fixed(mode) + liveKB(ttl) > DATA_LIMIT_KB && ttl < LIVE_MIN) ttl = Math.ceil(ttl * 1.25);
  return { ttlMin: ttl, skip, openMode: mode, fullDays, estKB: Math.round(fixed(mode) + liveKB(ttl)) };
}
let planCache = null;
function currentPlan() {
  const key = `${enabledCount()}|${settings.interval}`;
  if (!planCache || planCache.key !== key) planCache = { key, plan: dataPlan() };
  return planCache.plan;
}
const approxMode = () => currentPlan().openMode !== 'exact';
const OPEN_LABEL = { exact: '正確（1銘柄ずつ）', '1m': '最初の1分の値', '5m': '最初の5分の値', '15m': '最初の15分の値', prev: '前日の終値で代用' };
function applyData() {
  const plan = currentPlan();
  renderPlan(plan);
  D.configure({
    demo: DEMO, ttlMs: plan.ttlMin * 60e3,
    approxOpen: plan.openMode !== 'exact',
    openMode: plan.openMode,
    fullDays: plan.fullDays,
    // 取引時間中にまとめて取得する範囲：2分（データの有効時間）以内に表示する銘柄の数＋1
    liveAhead: Math.min(20, Math.ceil((plan.ttlMin * 60) / settings.interval) + 1),
    // まとめて取得の対象：この先表示される20銘柄（表示中の銘柄を含む）
    upcoming: () => [st.code, ...upcomingFrom(20)].filter(Boolean),
  });
}
// 通信状況画面の「決まり」に、今の計画を表示する
function renderPlan(plan) {
  const n = enabledCount();
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  const t = plan.ttlMin < 10 ? Math.round(plan.ttlMin * 10) / 10 : Math.round(plan.ttlMin);
  set('specLive', `取引時間中、同じ銘柄は${t}分ごとに最新化（表示対象${n}銘柄・切り替え${settings.interval}秒に合わせて自動で調整${plan.skip > 1 ? `。切り替えが速いので、毎回の表示では更新しない` : ''}）`);
  set('specOpen', OPEN_LABEL[plan.openMode]);
  set('specEst', `約${(plan.estKB / 1000).toFixed(1)}MB（東証・取引日に1日中表示した場合の目安。目標3.5MB・上限4MB）`);
}
function rebuildCharts() {
  const c = themeColors();
  stages.forEach((s) => s.build(settings.ind, c));
}

/* ---------------- 巡回 ---------------- */
function neighbor(delta, from = st.code) {
  const n = list.length;
  if (!n) return null;
  let i = list.findIndex((x) => x.code === from);
  if (i < 0) i = delta > 0 ? -1 : 0;
  for (let k = 1; k <= n; k++) {
    const j = (((i + delta * k) % n) + n) % n;
    if (list[j].enabled) return list[j].code;
  }
  return null;
}
// 次に表示する銘柄から n 件
function upcomingFrom(n) {
  const out = [];
  let code = st.code;
  for (let i = 0; i < n; i++) {
    code = neighbor(1, code);
    if (!code || code === st.code || out.includes(code)) break;
    out.push(code);
  }
  return out;
}
const userIsTouching = () => Date.now() < st.touchUntil;
function enabledCount() { return list.filter((x) => x.enabled).length; }
const marketOf = marketOfCode;
// 価格を小数2桁で扱うもの（米国株・指数・為替）
const dec2 = (code) => isUS(code) || isIndex(code);
function marketsInList() { return [...new Set(list.filter((x) => x.enabled).map((x) => marketOf(x.code)))]; }
function posText(code) {
  const en = list.filter((x) => x.enabled);
  const i = en.findIndex((x) => x.code === code);
  return i >= 0 ? `${i + 1} / ${en.length}` : '切替対象外';
}

function showEmpty(empty) {
  $('emptyMsg').hidden = !empty;
  $('monitor').classList.toggle('is-empty', empty);
}

// 銘柄を表示。キャッシュがあれば非表示レイヤーに描画→即切替、その後必要なら最新データ取得。
async function show(code, { nav = false, force = false, retry = false, auto = false } = {}) {
  const item = list.find((x) => x.code === code);
  if (!item) { showEmpty(true); return; }
  showEmpty(false);
  if (!retry) st.retry = null;
  const seq = ++st.seq;
  st.code = code;
  persistState();
  const tfs = neededTfs();
  const cur = stages[front];
  const isSame = cur.code === code;

  const cached = await D.cachedSet(code, tfs);
  if (seq !== st.seq) return;
  const hasCache = tfs.some((tf) => cached[tf]);
  // 自動切替で、まだデータが無く今日の取り込み枠も使い切った銘柄は飛ばす（「データ未取得」の画面を出さない）
  // 自動切替で、まだデータの無い銘柄は飛ばす（10年分の取り込みは裏で15秒に1件ずつ行う）。
  // 表示のたびに取り込むと、切り替えが速いとき（5秒など）に通信が集中するため。
  // 全銘柄にデータが無いとき（初めて開いたとき）だけは表示し、裏と同じゆっくりした順番で取り込む
  if (auto && !hasCache && (st.skips = (st.skips || 0) + 1) < Math.min(enabledCount(), 50)) { go(1, false, true); return; }
  st.skips = 0;
  if (!isSame) await present(item, cached, seq, !hasCache); // 未取得なら銘柄名と「読込中」を先に表示

  if (nav) { await new Promise((r) => setTimeout(r, NAV_FETCH_DELAY)); if (seq !== st.seq) return; }

  setLoading(true);
  const res = await D.loadSet(code, tfs, {
    force,
    prio: auto && !hasCache ? D.PRIO.warm : D.PRIO.show,
    // 片方のチャートが届いた時点で先に表示する
    onEntry: (partial) => {
      if (seq === st.seq && stages[front].code === code) render(stages[front], item, partial, userIsTouching(), true);
    },
  });
  setLoading(false);
  if (seq !== st.seq) return;
  st.lastError = res.error;
  if ((res.fetched && res.changed) || !hasCache) {
    const onFront = stages[front].code === code;
    if (onFront) render(stages[front], item, res.entries, userIsTouching());
    else await present(item, res.entries, seq, false);
  }
  updateStatus();
  // 一部のチャートが取れなかったときは、巡回を待たずに少し後で再挑戦
  if (res.error && !res.error.quiet && !(st.retry?.code === code && st.retry.n >= 3)) {
    const n = st.retry?.code === code ? st.retry.n + 1 : 1;
    st.retry = { code, n };
    setTimeout(() => { if (st.code === code && seq === st.seq) show(code, { retry: true }); }, 6000 * n);
  } else if (!res.error) {
    st.retry = null;
  }
}

function render(stage, item, entries, keepRange, loading = false) {
  stage.render(item, entries, settings, { pos: posText(item.code), keepRange, loading });
}

async function present(item, entries, seq, loading = false) {
  const back = stages[1 - front];
  render(back, item, entries, false, loading);
  await frames(2); // 非表示レイヤーで描画完了を待ってから切替
  if (seq !== st.seq) return;
  back.root.classList.add('active');
  stages[front].root.classList.remove('active');
  back.fitTitle();
  front = 1 - front;
  updateStatus();
}

function go(delta, nav = true, auto = false) {
  const code = neighbor(delta);
  st.remaining = settings.interval;
  if (!code) { showEmpty(true); renderCountdown(); return; }
  show(code, { nav, auto });
  renderCountdown();
}

async function prefetch(code) {
  if (!code || st.prefetching === code) return;
  st.prefetching = code;
  try {
    // まだデータの無い銘柄の10年分は、裏の取り込みと同じゆっくりした順番で（通信を集中させない）
    const tfs = neededTfs();
    const has = Object.values(await D.cachedSet(code, tfs)).some((e) => e?.bars?.length);
    const r = await D.loadSet(code, tfs, { prio: has ? D.PRIO.prefetch : D.PRIO.warm });
    if (r.error && !r.error.quiet) st.lastError = r.error;
  } finally {
    st.prefetching = null;
  }
}

function pauseReason(now) {
  if (st.settingsOpen) return '設定中';
  if (st.paused) return '一時停止中';
  if (now < st.touchUntil) return '操作中（一時停止）';
  if (settings.offHours === 'stop' && !marketsInList().some((m) => M.marketPhase(now, m).open)) return '時間外のため停止中';
  if (document.hidden) return '待機中';
  return null;
}

function tick() {
  const now = Date.now();
  updateStatus(now);
  warmTick(now);
  if (!pauseReason(now) && enabledCount() > 0) {
    st.remaining--;
    const lead = Math.min(PREFETCH_SEC, settings.interval - 2);
    if (st.remaining === lead) prefetch(neighbor(1));
    if (st.remaining <= 0) go(1, false, true);
  }
  renderCountdown(now);
}

/* ---------------- 裏での先回り取得 ----------------
   表示を待たずに、まだデータの無い銘柄だけを8秒に1件ずつ取得しておく。
   すでにデータのある銘柄の最新化は、表示の30秒前の事前取得（まとめて取得）に任せる。 */
const WARM_EVERY_MS = 15000; // 裏での取り込みは15秒に1件（一度にたくさん通信しない）
const WARM_MAX_AGE = 10 * 60e3;
let warmAt = 0, warmBusy = false;
const haveData = new Set(); // データ取得済みと確認できた銘柄（毎回の確認を省くため）
async function warmTick(now) {
  if (warmBusy || st.settingsOpen || document.hidden || now - warmAt < WARM_EVERY_MS || !D.isIdle()) return;
  if (!D.initAvailable()) return; // 今日の取り込み枠を使い切ったら、裏での取り込みは翌日に
  if (D.cooling() || !D.isLeader()) return; // 通信を控えている間・別のタブが通信役のときは取りに行かない
  warmAt = now;
  const tfs = neededTfs();
  const ok = (code) => { const f = D.failureOf(code); return (!f || now > f.until) && !D.noDataToday(code); };
  const en = list.filter((x) => x.enabled && ok(x.code));
  if (!en.length) return;
  warmBusy = true;
  try {
    // 未取得の銘柄を先に（1回に最大20件だけ確認）
    let target = null, checked = 0;
    for (const x of en) {
      if (haveData.has(x.code)) continue;
      if (++checked > 20) break;
      const c = await D.cachedSet(x.code, tfs);
      if (tfs.every((tf) => c[tf]?.bars?.length)) haveData.add(x.code);
      else { target = x.code; break; }
    }
    // 最新化は「切替30秒前の事前取得」が行うので、裏では未取得の銘柄だけを取りに行く
    if (!target) return;
    const r = await D.loadSet(target, tfs, { prio: D.PRIO.warm, maxAgeMs: WARM_MAX_AGE });
    if (r.fetched && !r.error) haveData.add(target);
    if (r.fetched && !r.error && st.lastError && target === st.code) st.lastError = null;
  } catch { /* 次回再試行 */ } finally {
    warmBusy = false;
  }
}

/* ---------------- ステータス表示 ---------------- */
let loading = false;
function setLoading(v) { loading = v; updateStatus(); }

function updateStatus(now = Date.now()) {
  const m = st.code ? marketOf(st.code) : 'JP';
  const ph = M.marketPhase(now, m);
  const dot = $('statusDot');
  const err = st.lastError;
  dot.className = `dot ${err ? 'err' : ph.open ? 'ok' : 'closed'}${loading ? ' busy' : ''}`;
  $('statusText').textContent = `${m === 'US' ? '米国' : m === 'X' ? '海外・為替' : '東証'}・${ph.open ? `接続中（${ph.label}）` : ph.label}`;
  const e = stages[front].entries?.[settings.leftTf] || stages[front].entries?.[settings.rightTf];
  const ns = D.netStats();
  const b = D.budgetStatus();
  const mb = $('modeBadge');
  const cool = D.cooling();
  const follower = !D.isLeader();
  mb.hidden = !(b.over || cool || follower || approxMode());
  mb.textContent = b.over ? '本日の通信上限' : cool ? '通信を控えています' : follower ? '別のタブで通信中' : '始値は近似';
  mb.title = b.over ? `今日の通信が${b.cap}回に達したため、保存済みのデータで表示しています（明日0時に再開）`
    : cool ? '回数制限や通信の失敗が続いたため、しばらく通信を控えています（相手の負担を減らし、ban を防ぐため）'
    : follower ? 'このアプリを別のタブでも開いているため、通信はそちらに任せ、保存済みのデータで表示しています' : `表示対象が${EXACT_OPEN_MAX}銘柄を超えているため、当日の始値は「${OPEN_LABEL[currentPlan().openMode]}」で近似しています`;
  mb.classList.toggle('warn', b.over);
  const errEl = $('errText');
  errEl.hidden = !err || !!err.budget || !!err.quiet;
  if (err) {
    errEl.textContent = (e ? '通信エラー：前回データを表示中' : '通信エラー：データ未取得') + '（タップで詳細）';
    errEl.title = String(err.message || err);
  }
}

function renderCountdown(now = Date.now()) {
  const r = pauseReason(now);
  const el = $('countdown');
  el.classList.toggle('paused', !!r);
  el.textContent = r || `残り ${Math.max(0, st.remaining)}秒`;
  $('pauseUse').setAttribute('href', st.paused ? '#i-play' : '#i-pause');
  $('btnPause').classList.toggle('on', st.paused);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- 画面スリープ防止 ---------------- */
let wake = null;
async function keepAwake() {
  if (!settings.wakeLock || !('wakeLock' in navigator) || document.hidden || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { /* 未対応・ユーザー操作待ち */ }
}

/* ---------------- 設定画面 ---------------- */
function openSettings() {
  setAlertMode(false);
  setOverview(false);
  st.settingsOpen = true;
  document.body.classList.add('in-settings');
  $('settings').hidden = false;
  fillSettings();
  renderList();
  takeSnapshot();
  renderCountdown();
}

// apply = true：「設定を保存して戻る」。右側の設定を反映する
// apply = false：× や「戻る」。右側の変更は捨てる（銘柄の登録・並び替えなどは、その場で保存済みなので反映される）
function closeSettings(apply = false) {
  const prev = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, t: settings.theme, c: settings.colorMode, f: settings.font });
  if (apply) readSettings();
  save(KEY.settings, settings);
  saveList();
  applyLook();
  applyData();
  updateStatus();
  const next = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, t: settings.theme, c: settings.colorMode, f: settings.font });
  st.settingsOpen = false;
  document.body.classList.remove('in-settings');
  $('settings').hidden = true;
  st.remaining = settings.interval;
  if (prev !== next) rebuildCharts();
  const cur = list.find((x) => x.code === st.code);
  const code = cur ? cur.code : neighbor(1);
  if (code) { stages[front].code = prev !== next ? null : stages[front].code; show(code); } else showEmpty(true);
  if (settings.wakeLock) keepAwake(); else if (wake) { wake.release(); wake = null; }
  renderCountdown();
}

function seg(id, value, onPick) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === String(value));
    b.onclick = () => {
      el.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset.v);
    };
  });
}

function tfButtons(id) {
  $(id).innerHTML = Object.entries(D.TF).map(([k, v]) => `<button data-v="${k}">${v.label}</button>`).join('');
}
function periodOptions(selId, tf, value) {
  const t = D.TF[tf];
  const sel = $(selId);
  sel.innerHTML = t.periods.map(([n, l]) => `<option value="${n}">${l}</option>`).join('');
  sel.value = t.periods.some(([n]) => n === Number(value)) ? String(value) : String(t.def);
}

function fillSettings() {
  const s = settings;
  const isPreset = [20, 30, 60, 90].includes(s.interval);
  seg('segInterval', isPreset ? s.interval : 'custom', (v) => {
    if (v === 'custom') { $('inpInterval').focus(); return; }
    $('inpInterval').value = v;
  });
  $('inpInterval').value = s.interval;
  $('inpInterval').oninput = () => {
    const v = $('inpInterval').value;
    $('segInterval').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (['20', '30', '60', '90'].includes(v) ? v : 'custom')));
  };
  $('selOffHours').value = s.offHours;
  tfButtons('segLeftTf'); tfButtons('segRightTf');
  seg('segLeftTf', s.leftTf, (v) => { $('segLeftTf').dataset.v = v; periodOptions('selLeftBars', v, D.TF[v].def); });
  seg('segRightTf', s.rightTf, (v) => { $('segRightTf').dataset.v = v; periodOptions('selRightBars', v, D.TF[v].def); });
  $('segLeftTf').dataset.v = s.leftTf; $('segRightTf').dataset.v = s.rightTf;
  periodOptions('selLeftBars', s.leftTf, s.leftBars);
  periodOptions('selRightBars', s.rightTf, s.rightBars);
  $('chkMa').checked = s.ind.ma; $('chkBb').checked = s.ind.bb; $('chkVol').checked = s.ind.vol;
  $('chkWake').checked = s.wakeLock;
  $('chkDark').checked = s.theme === 'dark';
  $('chkDark').onchange = () => { document.documentElement.dataset.theme = $('chkDark').checked ? 'dark' : 'light'; };
  seg('segColor', s.colorMode, (v) => { $('segColor').dataset.v = v; document.documentElement.dataset.color = v; });
  $('segColor').dataset.v = s.colorMode;
  seg('segFont', s.font, (v) => { $('segFont').dataset.v = v; document.documentElement.dataset.font = v; });
  $('segFont').dataset.v = s.font;
}

// 設定画面の入力内容（保存前）
function formValues() {
  const s = {};
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  s.interval = clamp($('inpInterval').value, 5, 300, 30);
  s.offHours = $('selOffHours').value;
  s.leftTf = $('segLeftTf').dataset.v; s.rightTf = $('segRightTf').dataset.v;
  s.leftBars = Number($('selLeftBars').value); s.rightBars = Number($('selRightBars').value);
  s.ind = { ma: $('chkMa').checked, bb: $('chkBb').checked, vol: $('chkVol').checked };
  s.wakeLock = $('chkWake').checked;
  s.theme = $('chkDark').checked ? 'dark' : 'light';
  s.colorMode = $('segColor').dataset.v; s.font = $('segFont').dataset.v;
  return s;
}
function readSettings() { Object.assign(settings, formValues()); }

// 右側の設定を変更したときだけ「設定を保存して戻る」ボタンを出す
// （銘柄の登録・削除・並び替え・表示対象・名前・アラートは、その場で保存しているので対象外）
let snapForm = '';
function takeSnapshot() { snapForm = JSON.stringify(formValues()); updateDirty(); }
function updateDirty() {
  if (!st.settingsOpen) return;
  const dirty = JSON.stringify(formValues()) !== snapForm;
  $('btnSave').hidden = !dirty;
}
['input', 'change', 'click'].forEach((ev) => $('settings').addEventListener(ev, () => setTimeout(updateDirty, 0)));

/* ---------------- 銘柄一覧 ---------------- */
function renderList() {
  $('listCount').textContent = `(${list.length}/${MAX_SYMBOLS})`;
  $('listBody').innerHTML = list.map((x, i) => `
    <tr data-code="${esc(x.code)}">
      <td class="c-no"><span class="grip" title="ドラッグで並び替え"><svg class="ico"><use href="#i-grip"/></svg></span><span class="no">${String(i + 1).padStart(3, '0')}</span></td>
      <td class="c-code num">${esc(x.code)}${isIndex(x.code) ? '<span class="tag idx">指数</span>' : isUS(x.code) ? '<span class="tag">米</span>' : ''}${D.noDataToday(x.code) ? '<span class="tag nd" title="Yahoo にこの銘柄のデータがありません（上場廃止・コード違いの可能性）。今日は取りに行きません">データなし</span>' : ''}</td>
      <td class="c-name"><button class="link rename">${esc(x.name || '（名称未設定）')}</button></td>
      <td class="c-price r"></td>
      <td class="c-target"><div class="tgt-box"><input class="tgt" type="text" autocomplete="off" enterkeyhint="done" placeholder="株価を入力" aria-label="${esc(x.code)} の設定株価"><span class="tgt-dir"></span></div></td>
      <td class="c-alert"><label class="switch"><input type="checkbox" class="alert-tg" aria-label="${esc(x.code)} のアラート"><i></i></label></td>
      <td class="c-sw"><label class="switch"><input type="checkbox" class="toggle" ${x.enabled ? 'checked' : ''}><i></i></label></td>
      <td class="c-del"><button class="icon-btn danger del" aria-label="削除"><svg class="ico"><use href="#i-trash"/></svg></button><button class="icon-btn clr" aria-label="${esc(x.code)} の設定株価を消す" title="設定株価を消す"><svg class="ico"><use href="#i-eraser"/></svg></button></td>
    </tr>`).join('');
  $('btnAdd').disabled = list.length >= MAX_SYMBOLS;
  const rows = $('listBody').children;
  list.forEach((x, i) => updateAlertRow(x.code, rows[i], x));
  if (alertMode) fillQuotes();
}

function renumber() {
  $('listBody').querySelectorAll('tr').forEach((tr, i) => { tr.querySelector('.no').textContent = String(i + 1).padStart(3, '0'); });
}

$('listBody').addEventListener('change', (e) => {
  if (!e.target.classList.contains('toggle')) return;
  const code = e.target.closest('tr').dataset.code;
  const item = list.find((x) => x.code === code);
  item.enabled = e.target.checked;
  saveList();
});

$('listBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const code = tr.dataset.code;
  const item = list.find((x) => x.code === code);
  if (e.target.closest('.clr')) {
    // アラート設定の消しゴム：設定株価を消してアラートを OFF にする（銘柄は消さない）
    delete item.alertPrice;
    delete item.alertOn;
    saveList();
    updateAlertRow(code);
    return;
  }
  if (e.target.closest('.del')) {
    ask(`${code} ${item.name} を一覧から削除しますか？`, { ok: '削除する', danger: true }).then((yes) => {
      if (!yes) return;
      list = list.filter((x) => x.code !== code);
      saveList();
      renderList();
    });
  } else if (e.target.closest('.rename')) {
    ask(`${code} の表示名`, { input: item.name || '' }).then((name) => {
      if (name == null) return;
      item.name = name.trim();
      saveList();
      renderList();
    });
  }
});

/* ---------------- アラート ----------------
   ・判定に使う株価は、いつもの表示・先読み・まとめて取得で届いたものだけ（アラートのための通信はしない）
   ・前回の現在値 → 今回の現在値 の間に設定株価をまたいだら通知し、その銘柄のアラートを自動で OFF にする
   ・設定株価は全角・半角どちらでも入力でき、表示は半角（桁区切り付き）にそろえる */
// 銘柄ごとの最新の現在値・前日比・データの時刻（アラート判定・現在値の列・全銘柄一覧で使う小さな控え）
//  日足のデータ（1銘柄あたり数十KB）を毎回読まずに済むよう、届いた値だけを覚えておく
const QUOTE_KEY = DEMO ? 'tm.quotecache.demo.v1' : 'tm.quotecache.v1';
const quotes = load(QUOTE_KEY, null) || {};
{
  // 旧版の控え（現在値だけ）を引き継ぐ
  const old = load(DEMO ? 'tm.prices.demo.v1' : 'tm.prices.v1', null);
  if (old) {
    for (const [k, v] of Object.entries(old)) if (!quotes[k] && Number.isFinite(v)) quotes[k] = { price: v };
    try { localStorage.removeItem(DEMO ? 'tm.prices.demo.v1' : 'tm.prices.v1'); } catch { /* ignore */ }
  }
}
const priceOf = (code) => quotes[code]?.price ?? null;
let saveQuotesTimer = null;
function saveQuotes() {
  clearTimeout(saveQuotesTimer);
  saveQuotesTimer = setTimeout(() => {
    const keep = new Set(list.map((x) => x.code));
    for (const k of Object.keys(quotes)) if (!keep.has(k)) delete quotes[k];
    save(QUOTE_KEY, quotes);
  }, 1500);
}
const slimQuote = (q) => ({ price: q.price, chg: q.chg ?? null, pct: q.pct ?? null, time: q.time ?? null });
// 控えに無い（または前日比の無い旧版の控えしかない）銘柄だけ、保存済みのデータから1件ずつ読む（通信しない）
async function ensureQuote(code) {
  const q = quotes[code];
  if (q && q.pct !== undefined) return;
  const v = await D.peekQuote(code);
  if (v?.price != null && quotes[code] === q) { quotes[code] = slimQuote(v); saveQuotes(); updateAlertRow(code); if (overviewMode) scheduleOverview(); }
}
let fillingQuotes = false;
async function fillQuotes() {
  if (fillingQuotes) return;
  fillingQuotes = true;
  try { for (const x of [...list]) await ensureQuote(x.code); } finally { fillingQuotes = false; }
}

let alertMode = false;
function setAlertMode(on) {
  alertMode = on;
  $('settings').classList.toggle('alert-mode', on);
  $('btnAlertMode').setAttribute('aria-pressed', String(on));
  if (!on) return;
  $('chkAlertPopup').checked = settings.alertPopup;
  $('chkAlertSound').checked = settings.alertSound;
  $('selAlertSec').value = [5, 10, 15, 20, 30, 60].includes(settings.alertSec) ? String(settings.alertSec) : '10';
  fillQuotes();
}
$('btnAlertMode').addEventListener('click', () => setAlertMode(!alertMode));
$('btnAlertBack').addEventListener('click', () => setAlertMode(false));
$('btnAlertDone').addEventListener('click', () => closeSettings(false));
$('chkAlertPopup').addEventListener('change', (e) => { settings.alertPopup = e.target.checked; save(KEY.settings, settings); });
$('chkAlertSound').addEventListener('change', (e) => { settings.alertSound = e.target.checked; save(KEY.settings, settings); if (!e.target.checked) stopAlarm(); });
$('selAlertSec').addEventListener('change', (e) => { settings.alertSec = Number(e.target.value) || DEFAULTS.alertSec; save(KEY.settings, settings); });

const rowOf = (code) => $('listBody').querySelector(`tr[data-code="${CSS.escape(code)}"]`);
function updateAlertRow(code, tr = rowOf(code), x = list.find((i) => i.code === code)) {
  if (!tr || !x) return;
  const us = dec2(code);
  const cur = priceOf(code);
  tr.querySelector('.c-price').textContent = cur != null ? fmtNum(cur, us) : '—';
  const on = !!x.alertOn;
  tr.querySelector('.alert-tg').checked = on;
  const inp = tr.querySelector('.tgt');
  inp.disabled = !on; // アラートが OFF の間は入力できない
  if (document.activeElement !== inp) inp.value = x.alertPrice ? fmtNum(x.alertPrice, us) : '';
  tr.querySelector('.tgt-box').classList.toggle('off', !on);
  tr.querySelector('.clr').disabled = !x.alertPrice && !on;
  // ▲：今より上に設定（上抜けで通知） ／ ▼：今より下に設定（下抜けで通知）
  const T = x.alertPrice;
  const d = T && cur != null ? (T > cur ? 'up' : T < cur ? 'down' : '') : '';
  const dir = tr.querySelector('.tgt-dir');
  dir.textContent = d === 'up' ? '▲' : d === 'down' ? '▼' : '';
  dir.className = `tgt-dir ${d}`;
  dir.title = d === 'up' ? '上抜けで通知' : d === 'down' ? '下抜けで通知' : '';
}
function commitTarget(x, inp) {
  const v = parsePrice(inp.value);
  if (Number.isNaN(v)) {
    toast('設定株価は数字で入力してください');
    inp.value = x.alertPrice ? fmtNum(x.alertPrice, dec2(x.code)) : '';
    return;
  }
  if (v == null) delete x.alertPrice; else x.alertPrice = v;
  saveList();
  inp.value = v == null ? '' : fmtNum(v, dec2(x.code));
  updateAlertRow(x.code);
}
$('listBody').addEventListener('change', (e) => {
  const tr = e.target.closest('tr');
  const x = tr && list.find((i) => i.code === tr.dataset.code);
  if (!x) return;
  if (e.target.classList.contains('alert-tg')) {
    if (e.target.checked) x.alertOn = true; else delete x.alertOn;
    saveList();
    updateAlertRow(x.code);
    if (x.alertOn) {
      ensureQuote(x.code);
      if (!x.alertPrice) setTimeout(() => tr.querySelector('.tgt').focus(), 0);
    }
  } else if (e.target.classList.contains('tgt')) {
    commitTarget(x, e.target);
  }
});
$('listBody').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('tgt')) { e.preventDefault(); e.target.blur(); }
});

function fireAlert(x, dir, price) {
  const target = x.alertPrice;
  delete x.alertOn; // 1回通知したら OFF（設定株価の付近で上下しても何度も鳴らないように）
  saveList();
  if (settings.alertPopup) showAlertCard({ code: x.code, name: x.name, target, price, dir, at: Date.now(), us: isUS(x.code), idx: isIndex(x.code) });
  if (settings.alertSound) playAlarm(settings.alertSec); // 設定した秒数だけ鳴らす（通知を消すと止まる）
}
D.onPrice((code, price, q) => {
  const prev = priceOf(code);
  quotes[code] = slimQuote(q);
  saveQuotes();
  const x = list.find((i) => i.code === code);
  if (x?.alertOn && x.alertPrice) {
    const dir = crossed(prev, price, x.alertPrice);
    if (dir) fireAlert(x, dir, price);
  }
  if (st.settingsOpen) updateAlertRow(code);
  if (overviewMode) updateTile(code);
});
initAlertCards($('alertStack'));
(async () => { for (const x of list) if (x.alertOn) await ensureQuote(x.code); })();

/* ---------------- 全銘柄一覧（タイル表示） ----------------
   保存済みのデータから現在値・前日比を並べる（この画面のための通信はしない）。
   表示中に新しい株価が届いたタイルは、その場で書き換える。 */
let overviewMode = false;
let ovSort = 'list';
let ovTimer = null;
// 描き直しはまとめて1回に（株価がいくつも続けて届いたときに、何度も描き直さないように）
function scheduleOverview() { clearTimeout(ovTimer); ovTimer = setTimeout(() => { if (overviewMode) renderOverview(); }, 300); }
function setOverview(on) {
  overviewMode = on;
  $('settings').classList.toggle('overview-mode', on);
  if (!on) return;
  seg('segOvSort', ovSort, (v) => { ovSort = v; renderOverview(); });
  renderOverview();
  fillQuotes(); // 控えに無い銘柄だけ読み、そろった分から表示する
}
$('btnOverview').addEventListener('click', () => setOverview(true));
$('btnOvBack').addEventListener('click', () => setOverview(false));
const ovMoney = (v, us, idx) => (v == null ? '—' : us ? `US$${fmtNum(v, true)}` : idx ? fmtNum(v, true) : fmtNum(v));
function tileHtml(x) {
  const q = quotes[x.code];
  const us = isUS(x.code);
  const idx = isIndex(x.code);
  const pct = q?.pct;
  const dir = pct == null ? '' : pct > 0 ? 'up' : pct < 0 ? 'down' : '';
  // 色の濃さ：前日比 0〜5% を 8〜38% の濃さに（5%以上は同じ）
  const heat = dir ? 8 + (Math.min(Math.abs(pct), 5) / 5) * 30 : 0;
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');
  const chg = q?.chg == null ? '' : `${sign(q.chg)}${us || idx ? fmtNum(Math.abs(q.chg), true) : fmtNum(Math.abs(q.chg))}`;
  const pctTxt = pct == null ? '' : `${sign(pct)}${Math.abs(pct).toFixed(2)}%`;
  const flags = `${x.alertOn ? '<svg class="ico" aria-label="アラート中"><use href="#i-bell"/></svg>' : ''}${idx ? '<span class="ov-badge">指数</span>' : us ? '<span class="ov-badge">米</span>' : ''}${x.enabled ? '' : '<span class="ov-badge">表示OFF</span>'}`;
  return `<button type="button" class="ov-tile ${dir ? `t-${dir}` : ''}${x.enabled ? '' : ' off'}" data-code="${esc(x.code)}" style="--heat:${heat.toFixed(0)}%">
    <div class="ov-top"><span>${esc(x.code)}</span><span class="ov-flags">${flags}</span></div>
    <div class="ov-name">${esc(x.name || '（名称未設定）')}</div>
    <div class="ov-price">${q ? ovMoney(q.price, us, idx) : '<span class="ov-empty">データ未取得</span>'}${q && !us && !idx ? '<small>円</small>' : ''}</div>
    <div class="ov-chg"><span class="v">${chg}${pctTxt ? ` (${pctTxt})` : ''}</span><span class="ov-time">${q?.time ? M.fmtStamp(q.time * 1000) : ''}</span></div>
  </button>`;
}
function renderOverview() {
  const rows = [...list];
  const key = (x) => quotes[x.code]?.pct;
  if (ovSort !== 'list') {
    rows.sort((a, b) => {
      const pa = key(a), pb = key(b);
      if (pa == null) return pb == null ? 0 : 1; // データの無い銘柄は最後
      if (pb == null) return -1;
      return ovSort === 'up' ? pb - pa : pa - pb;
    });
  }
  $('ovGrid').innerHTML = rows.map(tileHtml).join('') || '<p class="ov-empty">登録銘柄がありません</p>';
  let up = 0, down = 0, flat = 0;
  for (const x of list) { const v = key(x); if (v == null) continue; if (v > 0) up++; else if (v < 0) down++; else flat++; }
  $('ovCount').textContent = `(${list.length}銘柄)`;
  $('ovSum').innerHTML = `<span>値上がり <b class="up">${up}</b></span><span>値下がり <b class="down">${down}</b></span><span>変わらず <b>${flat}</b></span>`;
}
function updateTile(code) {
  const x = list.find((i) => i.code === code);
  if (!x || !overviewMode) return;
  if (ovSort !== 'list') { scheduleOverview(); return; } // 並び順が変わるので全体を描き直す
  const el = $('ovGrid').querySelector(`[data-code="${CSS.escape(code)}"]`);
  if (el) el.outerHTML = tileHtml(x);
}
// タイルを押したら、その銘柄のチャートへ
$('ovGrid').addEventListener('click', (e) => {
  const t = e.target.closest('.ov-tile');
  if (!t) return;
  st.code = t.dataset.code;
  persistState();
  closeSettings(false);
});

/* ---------------- アプリ内の確認画面 ----------------
   ブラウザ標準の確認画面（confirm / prompt / alert）は Android で全画面表示を解除してしまうため使わない。
   ask(文言) → OK なら true / キャンセルなら false
   ask(文言, { input: 初期値 }) → 入力した文字 / キャンセルなら null
   ask(文言, { alert: true }) → OK ボタンだけ */
function ask(msg, { input = null, ok = 'OK', danger = false, alert: only = false, rows = 1 } = {}) {
  const d = $('askDialog');
  $('askMsg').textContent = msg;
  const inp = $('askInput');
  inp.hidden = input == null;
  inp.value = input ?? '';
  inp.rows = rows;
  $('askOk').textContent = ok;
  $('askOk').classList.toggle('danger-fill', danger);
  $('askCancel').hidden = only;
  d.showModal();
  if (input != null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $('askForm').onsubmit = null; $('askCancel').onclick = null; d.oncancel = null; resolve(v); };
    $('askForm').onsubmit = (e) => { e.preventDefault(); done(input != null ? inp.value : true); };
    $('askCancel').onclick = () => done(input != null ? null : false);
    d.oncancel = (e) => { e.preventDefault(); done(input != null ? null : false); };
  });
}

// ドラッグ＆ドロップ並び替え（スマホのリスト操作と同じ動き）
//  つまむと行が浮き上がり指に付いてくる。他の行は滑らかによけ、離すと元の場所へ収まる。
(function setupDrag() {
  const body = $('listBody');
  const wrap = $('tableWrap');
  let d = null;

  const rowsTop = () => new Map([...body.children].map((r) => [r, r.getBoundingClientRect().top]));
  function animateShift(before) {
    for (const row of body.children) {
      if (row === d.ph) continue;
      const old = before.get(row);
      const dy = old - row.getBoundingClientRect().top;
      if (!dy) continue;
      row.style.transition = 'none';
      row.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => {
        row.style.transition = 'transform .18s ease';
        row.style.transform = '';
      });
    }
  }

  body.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.grip');
    if (!g || d) return;
    e.preventDefault();
    const tr = g.closest('tr');
    const rect = tr.getBoundingClientRect();
    // 浮かせる行（コピー）を作る。列幅は元の行に合わせる
    const ghost = document.createElement('table');
    ghost.className = 'list drag-ghost';
    const clone = tr.cloneNode(true);
    [...clone.children].forEach((td, i) => {
      if (getComputedStyle(tr.children[i]).display === 'none') td.style.display = 'none'; // 今の画面で隠している列
      else td.style.width = `${tr.children[i].getBoundingClientRect().width}px`;
    });
    ghost.appendChild(document.createElement('tbody')).appendChild(clone);
    Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
    document.body.appendChild(ghost);
    requestAnimationFrame(() => ghost.classList.add('lifted'));
    tr.classList.add('drag-placeholder');
    d = { ph: tr, ghost, id: e.pointerId, y0: e.clientY, top0: rect.top, y: e.clientY, h: rect.height };
    g.setPointerCapture(e.pointerId);
    d.timer = setInterval(autoScroll, 30);
  });

  function autoScroll() {
    if (!d) return;
    const r = wrap.getBoundingClientRect();
    let v = 0;
    if (d.y < r.top + 60) v = -Math.ceil((r.top + 60 - d.y) / 5);
    else if (d.y > r.bottom - 60) v = Math.ceil((d.y - (r.bottom - 60)) / 5);
    if (v) { wrap.scrollTop += v; reorder(); }
  }

  function reorder() {
    const y = d.y;
    const before = rowsTop();
    for (const row of body.children) {
      if (row === d.ph) continue;
      const r = row.getBoundingClientRect();
      if (y > r.top && y < r.bottom) {
        const after = y > r.top + r.height / 2;
        const target = after ? row.nextSibling : row;
        if (target !== d.ph && target !== d.ph.nextSibling) {
          body.insertBefore(d.ph, target);
          animateShift(before);
          renumber();
          d.ghost.querySelector('.no').textContent = d.ph.querySelector('.no').textContent;
        }
        break;
      }
    }
  }

  body.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return;
    d.y = e.clientY;
    d.ghost.style.top = `${d.top0 + (e.clientY - d.y0)}px`;
    reorder();
  });

  const end = (e) => {
    if (!d || e.pointerId !== d.id) return;
    const { ph, ghost, timer } = d;
    clearInterval(timer);
    d = null;
    // 収まる位置へ戻すアニメーション
    const to = ph.getBoundingClientRect();
    ghost.classList.add('dropping');
    ghost.classList.remove('lifted');
    ghost.style.top = `${to.top}px`;
    ghost.style.left = `${to.left}px`;
    setTimeout(() => {
      ghost.remove();
      ph.classList.remove('drag-placeholder');
    }, 180);
    const order = [...body.children].map((r) => r.dataset.code);
    const pos = new Map(order.map((c, i) => [c, i]));
    list.sort((a, b) => pos.get(a.code) - pos.get(b.code));
    saveList();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
})();

/* ---------------- 新規登録ダイアログ ----------------
   新規登録は1日100銘柄まで（日本時間0時区切り）。登録した銘柄は10年分のデータを1回取り込むので、
   一度に大量に登録して通信が集中しないようにする。 */
const ADD_PER_DAY = 100;
const ADD_KEY = 'tm.addcount.v1';
function addsToday() {
  const d = M.dayKey(Date.now());
  const a = load(ADD_KEY, null);
  return a && a.d === d ? a : { d, n: 0 };
}
const dlg = $('addDialog');
const normCode = (v) => {
  const raw = String(v || '').trim().normalize('NFKC').toUpperCase();
  if (isIndex(raw)) return raw; // 指数・為替（^N225、USDJPY=X など）はそのまま
  return raw.replace(/\.T$/, '').replace(/\./g, '-');
};
const validCode = (c) => JP_RE.test(c) || US_RE.test(c) || isIndex(c);
function setMarketLabel(code) {
  $('addMarketLabel').value = !code ? '' : isIndex(code) ? '指数・為替など' : isUS(code) ? '米国株' : JP_RE.test(code) ? '日本株（東証）' : '';
}

$('btnAdd').addEventListener('click', () => {
  $('addQuery').value = ''; $('addCode').value = ''; $('addName').value = '';
  setMarketLabel('');
  $('addResults').innerHTML = '';
  const left = ADD_PER_DAY - addsToday().n;
  $('addMsg').textContent = left < 20 ? `今日あと${Math.max(0, left)}銘柄登録できます（1日${ADD_PER_DAY}銘柄まで）` : '';
  loadDict();
  dlg.showModal();
  setTimeout(() => $('addQuery').focus(), 50);
});
$('btnAddCancel').addEventListener('click', () => dlg.close());
$('addCode').addEventListener('input', () => {
  const c = normCode($('addCode').value);
  setMarketLabel(c);
  const n = lookupName(c);
  if (n) $('addName').value = n;
});

function pickResult(r) {
  $('addCode').value = r.code;
  setMarketLabel(r.code);
  $('addName').value = lookupName(r.code) || r.name;
  $('addResults').innerHTML = '';
  $('addMsg').textContent = '';
}

// 候補の表示：手元の辞書で即座に出し、英字（米国株など）の場合だけ少し待って Yahoo 検索の結果を追加する
let searchSeq = 0, remoteTimer = null;
function showResults(results, note) {
  const ul = $('addResults');
  $('addMsg').textContent = note;
  ul.innerHTML = results.map((x, i) => `<li><button type="button" data-i="${i}"><span class="num code">${esc(x.code)}</span><span class="nm">${esc(x.name || '（名称不明）')}</span><small class="muted">${esc(x.market || '')}</small></button></li>`).join('');
  ul.querySelectorAll('button').forEach((b) => { b.onclick = () => pickResult(results[Number(b.dataset.i)]); });
}
function doSearch() {
  const raw = $('addQuery').value;
  const q = cleanQuery(raw);
  const seq = ++searchSeq;
  clearTimeout(remoteTimer);
  if (!q) { showResults([], ''); return; }
  if (!dictReady()) { $('addMsg').textContent = '銘柄辞書を読み込み中…'; loadDict().then(() => { if (seq === searchSeq) doSearch(); }); return; }
  let results = searchLocal(q);
  const asCode = normCode(q);
  // 入力がそのままコード／ティッカーとして使える形なら、候補の最後に追加（辞書に無い新しい銘柄用）
  if (!results.some((x) => x.code === asCode) && validCode(asCode)) results.push({ code: asCode, name: lookupName(asCode) || '（コードとして登録）', market: isIndex(asCode) ? '指数' : isUS(asCode) ? '米国' : '東証' });
  const ascii = /^[\x20-\x7E]+$/.test(q);
  showResults(results, results.length ? '候補をタップしてください' : (ascii ? '検索中…' : '見つかりませんでした'));
  // Yahoo 検索は通信が必要なので、英字の入力が止まってから1回だけ
  if (ascii && q.length >= 2 && results.length < 8) {
    remoteTimer = setTimeout(async () => {
      try {
        const remote = await D.searchRemote(q);
        if (seq !== searchSeq) return;
        for (const x of remote) if (!results.some((y) => y.code === x.code)) results.push({ ...x, name: lookupName(x.code) || x.name });
        showResults(results.slice(0, 30), results.length ? '候補をタップしてください' : '見つかりませんでした。銘柄コード（例: 7203）またはティッカー（例: AAPL）で入力してください。');
      } catch {
        if (seq === searchSeq && !results.length) $('addMsg').textContent = '見つかりませんでした';
      }
    }, 700);
  }
}
$('btnSearch').addEventListener('click', doSearch);
// 1文字入力するごとに即検索（日本語入力の変換中も反映）
$('addQuery').addEventListener('input', doSearch);
$('addQuery').addEventListener('compositionupdate', () => setTimeout(doSearch, 0));
$('addQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = normCode($('addCode').value);
  const msg = $('addMsg');
  if (!validCode(code)) { msg.textContent = '日本株は4桁のコード（例: 7203, 130A）、米国株はティッカー（例: AAPL）を入力してください'; return; }
  if (list.some((x) => x.code === code)) { msg.textContent = 'すでに登録されています'; return; }
  if (list.length >= MAX_SYMBOLS) { msg.textContent = `登録できるのは最大${MAX_SYMBOLS}銘柄です`; return; }
  const added = addsToday();
  if (added.n >= ADD_PER_DAY) { msg.textContent = `新規登録は1日${ADD_PER_DAY}銘柄までです（通信の負担を抑えるため）。明日また登録できます`; return; }
  added.n++;
  save(ADD_KEY, added);
  D.clearNoData(code);
  list.push({ code, name: $('addName').value.trim() || lookupName(code) || '', enabled: true });
  saveList();
  renderList();
  dlg.close();
  $('tableWrap').scrollTop = $('tableWrap').scrollHeight;
  toast(`${code} を登録しました`);
  applyData();
  // 登録した銘柄はすぐにデータを取りに行く（裏の順番待ちをしない）。
  // 以前登録していてデータが残っている銘柄は、足りない直近分だけを取得する。
  D.loadSet(code, neededTfs(), { prio: D.PRIO.prefetch }).then((r) => { if (r.fetched && !r.error) haveData.add(code); });
});

/* ---------------- イベント ---------------- */
/* ---------------- 通信状況ダイアログ ---------------- */
const netDlg = $('netDialog');
function renderNet() {
  if (!netDlg.open) return;
  const now = Date.now();
  const ns = D.netStats();
  $('netSummary').innerHTML = `
    <div><span class="k">直近1分</span><b>${ns.lastMin}</b><span class="u">/ ${ns.perMin}回</span></div>
    <div><span class="k">今日</span><b>${D.budgetStatus().used}</b><span class="u">/ ${D.budgetStatus().cap}回（初回取り込み ${D.budgetStatus().init}/${D.INIT_CAP}）</span></div>
    <div><span class="k">最終通信</span><b>${ns.lastAt ? M.fmtStamp(ns.lastAt, now) : '—'}</b></div>
    <div><span class="k">保存データ</span><b>${storageText}</b></div>
    <div><span class="k">状態</span><b>${ns.active ? '通信中' : ns.pausedUntil ? '一時停止中' : '待機中'}</b>${ns.queued ? `<span class="u">待ち${ns.queued}件</span>` : ''}</div>`;
  const log = D.netLog();
  $('netLogBody').innerHTML = log.length ? log.slice(0, 40).map((x) => `
    <tr class="${x.ok ? '' : 'ng'}">
      <td class="num">${M.fmtClock(x.t)}</td>
      <td>${esc(x.code)}</td>
      <td>${esc(x.what)}<div class="muted small">${esc(x.route)}</div></td>
      <td>${x.ok ? `成功 <span class="muted">${(x.ms / 1000).toFixed(1)}秒</span>` : `<span class="err">失敗</span>`}${x.note ? `<div class="muted small">${esc(x.note)}</div>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="muted">この画面を開いてからの通信はまだありません（保存済みのデータで表示中）</td></tr>';
}
let storageText = '—';
async function refreshStorageText() {
  const i = await D.storageInfo().catch(() => null);
  if (i) storageText = `${(i.usage / 1048576).toFixed(1)}MB・${i.entries}件`;
}
function openNet() { refreshStorageText().then(renderNet); netDlg.showModal(); renderNet(); }
$('status').addEventListener('click', openNet);
$('btnNetClose').addEventListener('click', () => netDlg.close());
netDlg.addEventListener('click', (e) => { if (e.target === netDlg) netDlg.close(); });
D.onNetLog(() => { renderNet(); updateStatus(); });
setInterval(renderNet, 1000);
$('btnMenu').addEventListener('click', openSettings);
$('btnClose').addEventListener('click', () => closeSettings(false));
$('btnSave').addEventListener('click', () => closeSettings(true));
$('btnPause').addEventListener('click', () => { st.paused = !st.paused; persistState(); renderCountdown(); });
$('btnPrev').addEventListener('click', () => go(-1));
$('btnNext').addEventListener('click', () => go(1));

// チャート操作中は自動巡回を一時停止
const holdTouch = () => { st.touchUntil = Date.now() + TOUCH_HOLD_MS; renderCountdown(); };
['pointerdown', 'pointermove', 'wheel'].forEach((ev) => $('monitor').addEventListener(ev, (e) => {
  if (ev === 'pointermove' && e.buttons === 0 && e.pointerType === 'mouse') return;
  holdTouch();
}, { passive: true }));

document.addEventListener('keydown', (e) => {
  if (st.settingsOpen || e.target.closest('input,select,textarea,dialog')) return;
  if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); }
});
document.addEventListener('pointerdown', (e) => {
  keepAwake();
  unlockAudio();
  // ポップアップを出さない設定で音だけ鳴っているときは、画面に触れたら止める
  if (alarmPlaying() && !document.querySelector('.alert-card')) stopAlarm();
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  keepAwake();
  if (!st.settingsOpen && st.code) show(st.code); // 復帰時にキャッシュ期限切れなら更新
});

/* ---------------- 起動 ---------------- */
loadDict().then(() => {
  let changed = false;
  for (const x of list) if (!x.name) { const n = lookupName(x.code); if (n) { x.name = n; changed = true; } }
  if (changed) saveList();
});
applyLook();
applyData();
rebuildCharts();
stages[0].root.classList.add('active');
{
  const first = list.find((x) => x.code === st.code && x.enabled) ? st.code : neighbor(1);
  if (first) show(first); else showEmpty(true);
}
updateStatus();
renderCountdown();
setInterval(tick, 1000);
keepAwake();
// 画面の向き・大きさが変わったら銘柄名の文字サイズを調整し直す
window.addEventListener('resize', () => stages.forEach((s) => s.fitTitle()));

/* ---------------- 長時間運用のための見守り ----------------
   ・表示中のはずの銘柄が画面に出ていない状態が続いたら、描き直す
   ・チャートが空のまま（データはあるのに）なら、チャートを作り直す
   ・起動から12時間以上たち、市場が閉まっていて操作もしていないときは、ページを読み込み直してメモリを整理する */
const BOOT_AT = Date.now();
let stuckSince = 0;
setInterval(async () => {
  if (document.hidden || st.settingsOpen || !st.code) return;
  const now = Date.now();
  const cur = stages[front];
  const ok = cur.code === st.code && cur.root.classList.contains('active');
  if (!ok) {
    stuckSince = stuckSince || now;
    if (now - stuckSince > 15e3) { stuckSince = 0; cur.code = null; show(st.code, { retry: true }); }
  } else {
    stuckSince = 0;
    // データがあるのにチャートが描けていない（キャンバスが失われた等）場合は作り直す
    const empty = cur.panes.some((p) => !p.box.querySelector('canvas'));
    if (empty) { rebuildCharts(); show(st.code, { retry: true }); }
  }
  const allClosed = !marketsInList().some((m) => M.marketPhase(now, m).open);
  // アラート音を使っている間は読み込み直さない（読み込み直すと、画面に触れるまで音が鳴らせなくなるため）
  const soundAlerts = settings.alertSound && list.some((x) => x.alertOn);
  if (now - BOOT_AT > 12 * 3600e3 && allClosed && !soundAlerts && !userIsTouching() && !netDlg.open && !dlg.open) location.reload();
}, 5000);

/* ---------------- 全画面表示・ホーム画面アプリ ----------------
   ・ホーム画面に追加して起動した場合は、最初からバーが無いのでボタンも案内も出さない
   ・Safari で開いている場合は、全画面ボタン（対応端末のみ）と、ホーム画面追加の案内を出す */
const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
const root = document.documentElement;
const fsSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function syncFullBtn() {
  $('fullUse').setAttribute('href', fsElement() ? '#i-shrink' : '#i-expand');
  $('btnFull').title = fsElement() ? '全画面を終了' : '全画面表示';
}
if (!standalone && fsSupported) {
  $('btnFull').hidden = false;
  $('btnFull').addEventListener('click', () => {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (root.requestFullscreen || root.webkitRequestFullscreen).call(root);
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => {
    syncFullBtn();
    setTimeout(() => stages.forEach((s) => s.fitTitle()), 300);
  }));
}
const isTouchDevice = navigator.maxTouchPoints > 0;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && isTouchDevice);
// iPad/iPhone でホーム画面に追加した場合だけ保存場所が分かれるので、引き継ぎ機能を出す
if (isIOS) $('transferSection').hidden = false;

// 以前の版で登録したサービスワーカーがあれば解除する（今は使わない）
navigator.serviceWorker?.getRegistrations?.().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});

// 全画面で使っていた場合は、次に開いたとき最初に画面に触れた時点で全画面に戻す
// （ブラウザの決まりで、画面に触れる前に自動で全画面にはできない）
const FS_KEY = 'tm.fullscreen.v1';
if (!standalone && fsSupported) {
  ['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => save(FS_KEY, !!fsElement())));
  if (load(FS_KEY, false)) {
    const resume = () => {
      if (!fsElement()) (root.requestFullscreen || root.webkitRequestFullscreen).call(root)?.catch?.(() => {});
    };
    document.addEventListener('pointerup', resume, { once: true });
  }
}

// 銘柄リストと設定の引き継ぎ（クリップボード経由）
$('btnExport').addEventListener('click', async () => {
  const text = JSON.stringify({ app: 'trade-monitor', v: 1, list, settings });
  try { await navigator.clipboard.writeText(text); toast(`${list.length}銘柄と設定をコピーしました`); }
  catch { await ask('次の文字をすべてコピーしてください', { input: text, alert: true, rows: 4 }); }
});
$('btnImport').addEventListener('click', async () => {
  const text = await ask('「銘柄と設定をコピー」でコピーした文字を貼り付けてください', { input: '', rows: 4 });
  if (!text) return;
  try {
    const d = JSON.parse(text);
    if (d.app !== 'trade-monitor' || !Array.isArray(d.list)) throw new Error();
    if (!(await ask(`${d.list.length}銘柄と設定を読み込みます。今の銘柄リストは置き換わります。よろしいですか？`))) return;
    list = cleanList(d.list) || [];
    Object.assign(settings, cleanSettings(d.settings));
    save(KEY.settings, settings);
    saveList();
    fillSettings();
    renderList();
    takeSnapshot();
    toast('読み込みました');
  } catch { ask('読み込めませんでした。コピーした文字をそのまま貼り付けてください。', { alert: true }); }
});

/* ---------------- 新しい版の自動読み込み ----------------
   開きっぱなしの端末でも、アプリを更新したら自動で新しい版に切り替える。
   15分に1回、小さなファイル（version.json、GitHub 上）を確認するだけで、株価の取得先には通信しない。 */
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '0';
async function checkUpdate() {
  if (document.hidden || st.settingsOpen || userIsTouching() || netDlg.open || dlg.open || $('askDialog').open) return;
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = await r.json();
    if (!version || APP_VERSION === '0' || version === APP_VERSION) return;
    const tried = load('tm.reloadFor.v1', {});
    if (tried.v === version && Date.now() - tried.at < 30 * 60e3) return; // 30分以内に同じ版で読み込み直し済み
    save('tm.reloadFor.v1', { v: version, at: Date.now() });
    location.reload();
  } catch { /* オフライン等は無視 */ }
}
setInterval(checkUpdate, 15 * 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });

/* ---------------- 保存領域の掃除 ---------------- */
D.setRegistered(() => list.map((x) => x.code));
const MAINT_KEY = 'tm.maint.v1';
async function runMaintenance() {
  try {
    const r = await D.maintain();
    save(MAINT_KEY, { at: Date.now(), ...r });
  } catch { /* 次回に再試行 */ }
}
setTimeout(() => { if (Date.now() - (load(MAINT_KEY, {}).at || 0) > 20 * 3600e3) runMaintenance(); }, 5000);
setInterval(() => { if (Date.now() - (load(MAINT_KEY, {}).at || 0) > 20 * 3600e3) runMaintenance(); }, 3600e3);

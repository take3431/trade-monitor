import * as M from './market.js?v=20261128175300';
import * as D from './data.js?v=20261128175300';
import { Stage, themeColors, miniChart, TA_DEFAULT } from './chart.js?v=20261128175300';
import { parsePrice, fmtNum, crossed, unlockAudio, playAlarm, stopAlarm, alarmPlaying, alarmKind, showAlertCard, initAlertCards } from './alerts.js?v=20261128175300';
import { lookupName, searchLocal, loadDict, dictReady, cleanQuery, isUS, isIndex, marketOfCode, JP_RE, US_RE, categoryOf, CATEGORY_ORDER, readingOf } from './names.js?v=20261128175300';

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
  chimeJP: true, chimeUS: true, chimeSec: 5,
  viewMode: 'all', favs: Array.from({ length: 12 }, () => []),
  order: 'manual', shuffleSeed: 1,
  ovBars: { '1d': 490, '1wk': 260, '1mo': 0 }, // チャート一覧の表示期間（日足2年・週足5年・月足10年）
  ta: JSON.parse(JSON.stringify(TA_DEFAULT)),
  closeJP: true, closeUS: true, closeSec: 5,
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
// 指数の種類の印（一覧の「指数」「先物」「商品」など）
const KIND_TAG = { idx: '指数', fut: '先物', cmd: '商品', fx: '為替', crypto: '暗号資産' };
const kindTag = (code) => KIND_TAG[categoryOf(code)] || '指数';
const ORDER_KEYS = ['manual', 'type', 'name', 'code', 'shuffle', 'up', 'down', 'alert'];
function cleanSettings(raw) {
  const s = { ...DEFAULTS, ind: { ...DEFAULTS.ind }, ta: cleanTa(null) };
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
  s.chimeJP = raw.chimeJP !== undefined ? !!raw.chimeJP : DEFAULTS.chimeJP;
  s.chimeUS = raw.chimeUS !== undefined ? !!raw.chimeUS : DEFAULTS.chimeUS;
  s.chimeSec = int(raw.chimeSec, 3, 30, DEFAULTS.chimeSec);
  s.closeJP = raw.closeJP !== undefined ? !!raw.closeJP : DEFAULTS.closeJP;
  s.closeUS = raw.closeUS !== undefined ? !!raw.closeUS : DEFAULTS.closeUS;
  s.closeSec = int(raw.closeSec, 3, 30, DEFAULTS.closeSec);
  // 銘柄表示設定（全銘柄・ランダム・日本株・米国株・指数・お気に入り1〜12）とお気に入りの中身
  s.viewMode = /^(all|random|jp|us|idx|fav([1-9]|1[0-2]))$/.test(raw.viewMode || '') ? raw.viewMode : 'all';
  s.favs = Array.from({ length: 12 }, (_, i) => (Array.isArray(raw.favs?.[i]) ? raw.favs[i].filter((c) => typeof c === 'string').slice(0, 999) : []));
  s.order = ORDER_KEYS.includes(raw.order) ? raw.order : 'manual';
  s.shuffleSeed = int(raw.shuffleSeed, 1, 2 ** 31 - 1, 1);
  s.ta = cleanTa(raw.ta);
  s.ovBars = Object.fromEntries(['1d', '1wk', '1mo'].map((tf) => {
    const v = Number(raw.ovBars?.[tf]);
    return [tf, D.TF[tf].periods.some(([n]) => n === v) ? v : DEFAULTS.ovBars[tf]];
  }));
  return s;
}
// テクニカルの設定：移動平均の期間（足種ごとに短期・長期）、ボリンジャーの期間とσ
function cleanTa(raw) {
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const ma = {};
  for (const tf of TF_KEYS) {
    const d = TA_DEFAULT.ma[tf];
    const r = Array.isArray(raw?.ma?.[tf]) ? raw.ma[tf] : d; // 旧版（短期・長期の2本）は、その2本を短期・中期として引き継ぐ
    ma[tf] = [0, 1, 2].map((i) => Math.round(num(r[i], 2, 300, d[i])));
    if (r.length === 2 && ma[tf][2] <= ma[tf][1]) ma[tf][2] = Math.min(300, ma[tf][1] * 2); // 長期は中期より長く
  }
  const maOn = [0, 1, 2].map((i) => (typeof raw?.maOn?.[i] === 'boolean' ? raw.maOn[i] : TA_DEFAULT.maOn[i]));
  const bb = { n: Math.round(num(raw?.bb?.n, 2, 200, TA_DEFAULT.bb.n)), k: Math.round(num(raw?.bb?.k, 0.5, 5, TA_DEFAULT.bb.k) * 10) / 10 };
  return { ma, maOn, bb };
}
function cleanList(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || typeof x.code !== 'string') continue;
    const code = x.code.trim().toUpperCase().slice(0, 16);
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
  randomSeed: 1 + Math.floor(Math.random() * 2 ** 30), openSig: '',
  // 順番ランダム：次の一巡の並び（先に決めておき、一巡の終わりに先読みできるようにする）・前の一巡の最後の銘柄（続けて同じ銘柄にしない）
  randomNext: 1 + Math.floor(Math.random() * 2 ** 30), randomAvoid: null,
};
const stages = [new Stage($('stageA')), new Stage($('stageB'))];
let front = 0;

const persistState = () => save(KEY.state, { code: st.code, paused: st.paused });
let listVer = 0; // 登録銘柄・表示設定が変わるたびに増やす（表示する銘柄の一覧を作り直す目印）
const saveList = () => { listVer++; save(KEY.list, list); if (st.settingsOpen) setTimeout(updateDirty, 0); };
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
const TIERS = [ // [銘柄数まで, 更新間隔（分）, 始値の取り方の候補（良い順）]
  [50, 2, ['exact']],
  [200, 2, ['1m', '5m', '15m', 'prev']],
  [400, 3, ['5m', '15m', 'prev']],
  [700, 4, ['15m', 'prev']],
  [Infinity, 5, ['15m', 'prev']],
];
const OPEN_KB = { exact: 2.4, '1m': 6.6, '5m': 2.4, '15m': 1.7, prev: 0 };
const FULL_DAYS = 730;   // 10年分の定期の取り直し（約2年ごと。始値の補正は約1か月ごとに別に行う）
const INTRADAY_KB = 20.3; // 5分足（5日分）1回
const REQ_LIMIT = 260;    // 1日300回の上限に、検索・再試行の分の余裕を残す
const uses5m = () => settings.leftTf === '5m' || settings.rightTf === '5m';
/* 銘柄の種類ごとの「データが動く時間」（1日あたりの分）
   core：東証（330分）・米国（390分）。両方あれば 720分（時間帯は重ならない）
   all ：そのうえで夜間も動くもの（暗号資産は1440分、為替・先物・商品は約1380分、各国の指数は1つ約300分）を足した時間
   nOff：東証・米国以外の銘柄の数（東証・米国の取引時間外に更新が要る銘柄） */
const LIVE_US = 390;
const mixOf = (codes) => {
  const ms = new Set(codes.map((c) => marketOf(c)));
  const core = (ms.has('JP') ? LIVE_MIN : 0) + (ms.has('US') ? LIVE_US : 0);
  let all = core;
  if (ms.has('C')) all = 1440;
  else if ([...ms].some((m) => m === 'FX' || m === 'FUT' || M.SESSIONS[m]?.windows)) all = 1380;
  const others = [...ms].filter((m) => M.SESSIONS[m] && !M.SESSIONS[m].windows).length;
  all = Math.min(1440, Math.max(all, core + others * 300));
  const nOff = codes.filter((c) => { const m = marketOf(c); return m !== 'JP' && m !== 'US'; }).length;
  return { core, all, nOff, key: `${core}|${all}|${nOff}` };
};
const JP_ONLY = { core: LIVE_MIN, all: LIVE_MIN, nOff: 0 };
/* 通信の計画。東証・米国の取引時間（core）は ttl ごと、それ以外の時間（夜間・早朝。暗号資産・為替・先物などだけが動く）は ttlOff ごとに更新する。
   1日の通信回数（REQ_LIMIT）と通信量（DATA_LIMIT_KB）に、両方の時間帯を合わせて収まるようにする。 */
function dataPlan(n = enabledCount(), interval = settings.interval, use5m = uses5m(), mix = mixOf(activeCodes())) {
  const LIVE = mix.core || mix.all;                   // 「取引時間中」として計画する時間
  const off = mix.core ? mix.all - mix.core : 0;      // それ以外に動く時間
  const [, tierMin, modes] = TIERS.find(([max]) => n <= max);
  const displays = (LIVE * 60) / interval;        // 取引時間中に表示する回数
  const shown = Math.min(n, displays);                // 取引時間中に1回以上表示する銘柄の数
  const upkeep = n * 1.3 + (n / FULL_DAYS) * 158 + (n / 27) * 3.8; // 引け後の更新＋定期の取り直し＋始値の補正
  const openKB = (mode) => (mode === 'exact' ? n * OPEN_KB.exact : shown * OPEN_KB[mode] + (shown / 20) * 1.4);
  const openReq = (mode) => (mode === 'exact' ? n : mode === 'prev' ? 0 : shown / 20);
  const liveR = (ttl) => Math.min(displays, (n * LIVE) / ttl);
  const liveReq = (ttl) => Math.max(LIVE / ttl, liveR(ttl) / 20);
  const liveKB = (ttl) => liveR(ttl) * 1.23 + liveReq(ttl) * 1.4;
  const kb = (mode, ttl) => openKB(mode) + upkeep + liveKB(ttl);
  // 始値はなるべく良い取り方で。目標に収まらなければ粗くし、上限も超えるときだけ更新間隔を延ばす
  const target = n <= 200 ? DATA_LIMIT_KB : DATA_TARGET_KB;
  // 切り替えが20秒より速いときは、同じ銘柄を表示するたびには更新しない（k回の表示に1回。5秒なら4回に1回）。
  // 銘柄が少なくても、切り替えを速くしただけで通信が増えないようにする
  const skip = interval < 20 ? Math.ceil(20 / interval) : 1;
  const baseTtl = Math.max(tierMin, skip > 1 ? ((skip - 0.5) * n * interval) / 60 : 0);
  let mode = modes[modes.length - 1];
  for (const m of modes) if (kb(m, baseTtl) <= target) { mode = m; break; }
  let ttl = baseTtl;
  while (kb(mode, ttl) > DATA_LIMIT_KB && ttl < LIVE) ttl = Math.ceil(ttl * 1.25);
  // 1日の通信回数にも収める（夜間に動く銘柄があれば、その分を少し残す）
  const reqAt = (t) => openReq(mode) + liveReq(t) + n / 20;
  const reserve = off > 0 ? Math.min(60, off / 20) : 0;
  while (reqAt(ttl) > REQ_LIMIT - reserve && ttl < LIVE) ttl = Math.ceil(ttl * 1.25);
  // 東証・米国の取引時間外（夜間など）：残りの回数・通信量に収まる間隔で、暗号資産・為替・先物などだけを更新する
  const dispOff = (off * 60) / interval;
  const shareOff = n ? mix.nOff / n : 0;
  const rOff = (t) => (off ? Math.min(dispOff * shareOff, (mix.nOff * off) / t) : 0);
  const reqOff = (t) => (off ? Math.max(Math.min(dispOff * shareOff, off / t), rOff(t) / 20) : 0);
  const kbOff = (t) => rOff(t) * 1.23 + reqOff(t) * 1.4;
  let ttlOff = ttl;
  while (off && (reqAt(ttl) + reqOff(ttlOff) > REQ_LIMIT || kb(mode, ttl) + kbOff(ttlOff) > DATA_LIMIT_KB) && ttlOff < 240) ttlOff = Math.ceil(ttlOff * 1.25);
  // 5分足はまとめて取れない（1銘柄ずつ約20KB）。使うときは、通信量の上限と1日の回数の上限に収まるまで更新間隔を延ばす
  let ttl5 = Math.max(5, ttl);
  const r5 = (t) => (use5m ? Math.min(displays, (n * LIVE) / t) : 0);
  const reqs = reqAt(ttl) + reqOff(ttlOff);
  while (use5m && (kb(mode, ttl) + r5(ttl5) * INTRADAY_KB > DATA_LIMIT_KB || reqs + r5(ttl5) > REQ_LIMIT) && ttl5 < LIVE) ttl5 = Math.ceil(ttl5 * 1.25);
  // それでも収まらない（銘柄が多い）ときは、5分足を取る回数に1日の上限を設ける（超えたら保存済みの5分足で表示）
  const cap5 = use5m ? Math.max(0, Math.floor(Math.min((DATA_LIMIT_KB - kb(mode, ttl) - kbOff(ttlOff)) / INTRADAY_KB, REQ_LIMIT - reqs))) : 0;
  const n5 = Math.min(r5(ttl5), cap5);
  return { ttlMin: ttl, ttlOffMin: ttlOff, off, ttl5Min: ttl5, cap5, use5m, skip, openMode: mode, fullDays: FULL_DAYS, estKB: Math.round(kb(mode, ttl) + kbOff(ttlOff) + n5 * INTRADAY_KB) };
}
let planCache = null;
function currentPlan() {
  const key = `${enabledCount()}|${settings.interval}|${uses5m()}|${mixOf(activeCodes()).key}`;
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
    ttlOffMs: plan.ttlOffMin * 60e3,
    // 東証・米国の取引時間（データが動いている時間）か。そうでなければ、夜間も動く銘柄は ttlOff ごとに更新する
    coreLive: (now) => { const ms = marketsInList(); return (ms.includes('JP') && M.dataLive(now, 'JP')) || (ms.includes('US') && M.dataLive(now, 'US')); },
    approxOpen: plan.openMode !== 'exact',
    openMode: plan.openMode,
    fullDays: plan.fullDays,
    ttl5Ms: plan.ttl5Min * 60e3,
    cap5: plan.cap5,
    // 取引時間中にまとめて取得する範囲：2分（データの有効時間）以内に表示する銘柄の数＋1
    liveAhead: Math.min(20, Math.ceil((plan.ttlMin * 60) / settings.interval) + 1),
    // まとめて取得の対象：この先表示される20銘柄（表示中の銘柄を含む）
    upcoming: () => [st.code, ...upcomingFrom(20)].filter(Boolean),
  });
}
// 通信状況画面の「決まり」に、今の計画を表示する
function renderPlan(plan) {
  const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
  const t = plan.ttlMin < 10 ? Math.round(plan.ttlMin * 10) / 10 : Math.round(plan.ttlMin);
  set('specLive', `取引時間中、同じ銘柄は約${t}分ごとに最新化${plan.off ? `（夜間など、日本・米国の取引時間外は約${Math.round(plan.ttlOffMin)}分ごと）` : ''}`);
}
function rebuildCharts() {
  const c = themeColors();
  stages.forEach((s) => s.build(settings.ind, c));
}

/* ---------------- 巡回 ----------------
   自動切替で表示する銘柄（activeCodes）は「銘柄表示設定」で決まる：
   全銘柄表示・順番ランダム・日本株のみ・米国株のみ・指数のみ（どれも表示対象ONの銘柄から）、
   お気に入り1〜12（お気に入りに登録した銘柄。表示対象のON/OFFに関係なく表示）。
   並ぶ順番は「順番設定」で決まる（orderCodes）。
   通信の計画・裏での取り込みも、この銘柄だけを対象にする（表示しない銘柄のために通信しない）。 */
const VIEW_LABEL = { all: '全銘柄表示', random: '順番ランダム', jp: '日本株のみ', us: '米国株のみ', idx: '指数のみ' };
const viewLabel = (m) => VIEW_LABEL[m] || `お気に入り${m.slice(3)}`;
const favCodes = (n) => { const set = new Set(settings.favs[n - 1] || []); return list.filter((x) => set.has(x.code)).map((x) => x.code); };
let activeCache = { ver: -1, codes: [], pos: new Map() };
function activeCodes() {
  if (activeCache.ver === listVer) return activeCache.codes;
  const mode = settings.viewMode;
  let codes;
  if (mode.startsWith('fav')) codes = favCodes(Number(mode.slice(3)));
  else {
    let en = list.filter((x) => x.enabled);
    if (mode === 'jp') en = en.filter((x) => !isUS(x.code) && !isIndex(x.code));
    else if (mode === 'us') en = en.filter((x) => isUS(x.code));
    else if (mode === 'idx') en = en.filter((x) => isIndex(x.code));
    codes = en.map((x) => x.code);
  }
  const base = codes;
  // 順番ランダム：一巡の間は同じ並び（設定画面を閉じるたびに混ぜ直さない）。一巡したら混ぜ直す（go）
  codes = mode === 'random' ? randomOrder(codes, st.randomSeed, st.randomAvoid) : orderCodes(codes);
  activeCache = { ver: listVer, codes, base, pos: new Map(codes.map((c, i) => [c, i])) };
  return codes;
}
/* ---------------- 順番設定（自動切替の順番） ----------------
   登録順・種類別・名前順・コード順・全銘柄シャッフル・値上がり率順・値下がり率順・アラート優先。
   登録銘柄一覧の並びそのものは変えない。 */
// ボタンの下に出す短い名前（ボタンの幅を広げない）
const ORDER_SHORT = { shuffle: 'シャッフル', up: '値上がり順', down: '値下がり順' };
const ORDER_LABEL = { manual: '登録順', type: '種類別', name: '名前順', code: 'コード順', shuffle: '全銘柄シャッフル', up: '値上がり率順', down: '値下がり率順', alert: 'アラート優先' };
function seedHash(s, seed) { let h = (2166136261 ^ seed) >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function shuffled(codes, seed) {
  const key = new Map(codes.map((c) => [c, seedHash(c, seed)]));
  return [...codes].sort((a, b) => key.get(a) - key.get(b));
}
// 順番ランダムの一巡の並び（先頭が前の一巡の最後と同じ銘柄なら、2番目と入れ替える）
function randomOrder(codes, seed, avoid) {
  const o = shuffled(codes, seed);
  if (avoid && o.length > 1 && o[0] === avoid) [o[0], o[1]] = [o[1], o[0]];
  return o;
}
// 順番ランダムで、今の一巡の最後の銘柄を表示しているか
function randomAtEnd() {
  if (settings.viewMode !== 'random') return false;
  const codes = activeCodes();
  return codes.length > 1 && activeCache.pos.get(st.code) === codes.length - 1;
}
// 次の一巡に進む（待ち時間なし：並びは前もって決めてあり、先読みも済んでいる）
function nextRandomCycle() {
  const last = activeCodes().at(-1);
  st.randomSeed = st.randomNext;
  st.randomNext = 1 + Math.floor(Math.random() * 2 ** 30);
  st.randomAvoid = last;
  listVer++;
}
const jaCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
function orderCodes(codes) {
  const o = settings.order;
  if (o === 'manual' || codes.length < 2) return codes;
  if (o === 'shuffle') return shuffled(codes, settings.shuffleSeed);
  const idx = new Map(codes.map((c, i) => [c, i]));
  const item = new Map(list.map((x) => [x.code, x]));
  const byIdx = (a, b) => idx.get(a) - idx.get(b);
  const out = [...codes];
  if (o === 'type') {
    const rank = new Map(CATEGORY_ORDER.map((k, i) => [k, i]));
    out.sort((a, b) => rank.get(categoryOf(a)) - rank.get(categoryOf(b)) || byIdx(a, b));
  } else if (o === 'name') {
    const rd = new Map(codes.map((c) => [c, readingOf(c, item.get(c)?.name)]));
    out.sort((a, b) => jaCollator.compare(rd.get(a), rd.get(b)) || byIdx(a, b));
  } else if (o === 'code') {
    // 日本株（数字のコード）→ 米国株・指数（英字）の順
    out.sort((a, b) => jaCollator.compare(a, b));
  } else if (o === 'up' || o === 'down') {
    const pct = (c) => quotes[c]?.pct;
    out.sort((a, b) => {
      const pa = pct(a), pb = pct(b);
      if (pa == null) return pb == null ? byIdx(a, b) : 1; // データの無い銘柄は最後
      if (pb == null) return -1;
      return (o === 'up' ? pb - pa : pa - pb) || byIdx(a, b);
    });
  } else if (o === 'alert') {
    out.sort((a, b) => (item.get(b)?.alertOn ? 1 : 0) - (item.get(a)?.alertOn ? 1 : 0) || byIdx(a, b));
  }
  return out;
}
function neighbor(delta, from = st.code) {
  const codes = activeCodes();
  const n = codes.length;
  if (!n) return null;
  let i = activeCache.pos.get(from);
  if (i == null) i = delta > 0 ? -1 : 0;
  return codes[(((i + delta) % n) + n) % n];
}
// 次に表示する銘柄から n 件
function upcomingFrom(n) {
  if (settings.viewMode === 'random') {
    // 順番ランダム：今の一巡の残り → 次の一巡の並び（前もって決めてある）の順
    const codes = activeCodes();
    const i = activeCache.pos.get(st.code) ?? -1;
    const out = codes.slice(i + 1, i + 1 + n);
    if (out.length < n && codes.length > 1) {
      for (const c of randomOrder(activeCache.base, st.randomNext, codes.at(-1))) {
        if (out.length >= n) break;
        if (c !== st.code && !out.includes(c)) out.push(c);
      }
    }
    return out;
  }
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
// 次に表示する銘柄（順番ランダムでは、一巡の終わりの次は次の一巡の先頭）
const nextCode = () => (settings.viewMode === 'random' ? upcomingFrom(1)[0] ?? neighbor(1) : neighbor(1));
// 自動切替で表示する銘柄の数（通信の計画もこの数で立てる）
function enabledCount() { return activeCodes().length; }
const marketOf = marketOfCode;
// 価格を小数2桁で扱うもの（米国株・指数・為替）
const dec2 = (code) => isUS(code) || isIndex(code);
function marketsInList() { return [...new Set(activeCodes().map((c) => marketOf(c)))]; }
function posText(code) {
  const codes = activeCodes();
  const i = activeCache.pos.get(code);
  const head = settings.viewMode === 'all' ? '' : `${viewLabel(settings.viewMode)}　`;
  return i != null ? `${head}${i + 1} / ${codes.length}` : '切替対象外';
}

function showEmpty(empty) {
  const all = settings.viewMode === 'all';
  $('emptyMain').textContent = all ? '表示対象の銘柄がありません。' : `「${viewLabel(settings.viewMode)}」に当てはまる銘柄がありません。`;
  $('emptySub').textContent = all ? '右上のメニュー（≡）から銘柄を登録し、「表示対象」をONにしてください。' : '右上のメニュー（≡）→「銘柄表示設定」で、表示する銘柄を選び直してください。';
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
  stage.render(item, entries, settings, { pos: posText(item.code), keepRange, loading, status: quoteStatus(item.code, entries.quote) });
}

/* ---------------- 前日比の表示の状態 ----------------
   ・pending（「−」）：その銘柄の取引日の取引が始まったのに、まだ今日のデータが届いていない（東証は約20分遅れ）。
     日本株・米国株・指数が対象。為替・先物・暗号資産（ほぼ24時間動くもの）は対象外（取引時間の種類で決まる）。
   ・special（「特」）：日本株で、9:30を過ぎてから取得したのに今日の取引がまだ無く、ほかの日本株には今日の取引がある
     （特別買い気配・特別売り気配、または売買停止の可能性）。今日の株価が届いたら、ふつうの前日比に戻る。
   ・limit（「高」「安」）：日本株で、現在値が値幅制限の上限・下限（ストップ高・ストップ安）。 */
let tradedCache = { at: 0, set: new Set() };
function jpTradedToday(now) {
  if (now - tradedCache.at < 5000) return tradedCache.set;
  const set = new Set();
  for (const [code, q] of Object.entries(quotes)) {
    if (q?.time && marketOf(code) === 'JP' && !isIndex(code) && !M.awaitingToday('JP', q.time, now) && M.dayKey(q.time * 1000) === M.dayKey(now)) set.add(code);
  }
  tradedCache = { at: now, set };
  return set;
}
function quoteStatus(code, q, now = Date.now()) {
  if (!q || q.price == null) return null;
  const m = marketOf(code);
  const jpStock = m === 'JP' && !isIndex(code);
  if (M.awaitingToday(m, q.time, now)) {
    if (jpStock) {
      const ready = M.jpOpenToday(now) + 30 * 60e3; // 9:30（データは約20分遅れなので、9:10ごろまでの取引が届いているはず）
      const traded = jpTradedToday(now);
      const others = traded.size - (traded.has(code) ? 1 : 0);
      if (now >= ready && (q.fetchedAt || 0) >= ready && others > 0) return { state: 'special' };
    }
    return { state: 'pending' };
  }
  let limit = null;
  if (jpStock && q.chg != null) {
    const prev = q.price - q.chg;
    if (prev > 0) {
      const w = M.jpLimitWidth(prev);
      if (q.price >= prev + w - 1e-6) limit = 'high';
      else if (q.price <= prev - w + 1e-6) limit = 'low';
    }
  }
  return { state: 'ok', limit };
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
  // 順番ランダム：全部表示したら、混ぜ直して次の一巡の先頭へ
  const wrapRandom = delta > 0 && randomAtEnd();
  if (wrapRandom) nextRandomCycle();
  let code = wrapRandom ? activeCodes()[0] : neighbor(delta);
  if (delta > 0 && (settings.order === 'up' || settings.order === 'down') && code && activeCache.pos.get(code) === 0 && settings.viewMode !== 'random') {
    listVer++; // 一巡したので、最新の前日比で並べ直して先頭から
    code = activeCodes()[0];
  }
  st.remaining = settings.interval;
  // 先読みのタイミングに0〜3秒のばらつきを入れる（毎回同じリズムの機械的な通信にしない）
  const baseLead = Math.min(PREFETCH_SEC, settings.interval - 2);
  st.lead = Math.max(1, baseLead - Math.floor(Math.random() * Math.min(4, baseLead)));
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

/* 1日の通信上限に達した日でも、後場の始まりと引け後の2回だけ株価を更新する（20銘柄で1回の別枠）。
   1分ごとに時間帯を確認し、その日その時間帯で1回だけ行う。途中で止まっても続きから再開する。 */
const EMERG_KEY = 'tm.emerg.v1';
let emergBusy = false, emergCheckedAt = 0;
function emergencyTick(now) {
  if (emergBusy || now - emergCheckedAt < 60e3 || DEMO) return;
  emergCheckedAt = now;
  if (!D.budgetStatus().over || !D.amLeader() || D.isOffline()) return;
  const done = load(EMERG_KEY, []) || [];
  const slot = M.emergencySlots(now).find((s) => !done.includes(s.id));
  if (!slot) return;
  const codes = activeCodes().filter((c) => (slot.market === 'US' ? marketOf(c) === 'US' : marketOf(c) !== 'US'));
  emergBusy = true;
  D.emergencyRefresh(codes, slot.since).then((ok) => {
    if (ok) save(EMERG_KEY, [...done, slot.id].slice(-20));
    if (ok && st.code && !st.settingsOpen) show(st.code); // 表示中の銘柄に新しい値を出す
  }).catch(() => {}).finally(() => { emergBusy = false; });
}

/* 市場が開いた・閉じたときに音で知らせる（日本：前場・後場、米国：取引開始・終了。音色は日本と米国、開始と終了でそれぞれ別）。
   通信は一切しない（端末の時計と休場日の表だけで判断）。同じできごとでは1回だけ。通信役のタブだけが鳴らす。
   株価アラートが鳴っているときは、そちらを優先して鳴らさない。 */
const CHIME_KEY = 'tm.chime.v1';
const BELL_ON = { jp: 'chimeJP', us: 'chimeUS', jpClose: 'closeJP', usClose: 'closeUS' };
function chimeTick(now) {
  const evs = [...M.marketOpenEvents(now), ...M.marketCloseEvents(now)];
  if (!evs.length || !D.amLeader()) return;
  const done = load(CHIME_KEY, []) || [];
  const ev = evs.find((e) => !done.includes(e.id));
  if (!ev) return;
  save(CHIME_KEY, [...done, ev.id].slice(-20));
  if (!settings[BELL_ON[ev.kind]]) return;
  if (alarmPlaying() && alarmKind() === 'alert') return;
  playAlarm(ev.kind.endsWith('Close') ? settings.closeSec : settings.chimeSec, ev.kind);
  toast(ev.label);
}

function tick() {
  const now = Date.now();
  emergencyTick(now);
  chimeTick(now);
  updateStatus(now);
  warmTick(now);
  if (!pauseReason(now) && enabledCount() > 0) {
    st.remaining--;
    const lead = st.lead ?? Math.min(PREFETCH_SEC, settings.interval - 2);
    if (st.remaining === lead) prefetch(nextCode());
    if (st.remaining <= 0) go(1, false, true);
  }
  renderCountdown(now);
}

/* ---------------- 裏での先回り取得 ----------------
   表示を待たずに、まだデータの無い銘柄だけを8秒に1件ずつ取得しておく。
   すでにデータのある銘柄の最新化は、表示の30秒前の事前取得（まとめて取得）に任せる。 */
const WARM_EVERY_MS = 15000; // 裏での取り込みは15秒に1件（一度にたくさん通信しない）
const WARM_MAX_AGE = 10 * 60e3;
let warmAt = 0, warmBusy = false, warmJitter = 0;
const haveData = new Set(); // データ取得済みと確認できた銘柄（毎回の確認を省くため）
async function warmTick(now) {
  if (warmBusy || st.settingsOpen || document.hidden || now - warmAt < WARM_EVERY_MS + warmJitter || !D.isIdle()) return;
  warmJitter = Math.floor(Math.random() * 3000); // 裏の取り込みの間隔にも0〜3秒のばらつき
  if (!D.initAvailable()) return; // 今日の取り込み枠を使い切ったら、裏での取り込みは翌日に
  if (D.cooling() || !D.isLeader()) return; // 通信を控えている間・別のタブが通信役のときは取りに行かない
  warmAt = now;
  const tfs = neededTfs();
  const ok = (code) => { const f = D.failureOf(code); return (!f || now > f.until) && !D.noDataToday(code) && !D.gaveUpToday(code); };
  const en = activeCodes().filter(ok).map((code) => ({ code }));
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

// 毎秒呼ばれる表示の更新は、値が変わったときだけ書き換える（画面の再計算を減らす）
const setIf = (el, prop, v) => { if (el[prop] !== v) el[prop] = v; };
function updateStatus(now = Date.now()) {
  const m = st.code ? marketOf(st.code) : 'JP';
  const ph = M.marketPhase(now, m);
  const dot = $('statusDot');
  const err = st.lastError;
  setIf(dot, 'className', `dot ${err ? 'err' : ph.open ? 'ok' : 'closed'}${loading ? ' busy' : ''}`);
  setIf($('statusText'), 'textContent', `${M.MARKET_LABEL[m] || '東証'}・${ph.open ? `接続中（${ph.label}）` : ph.label}`);
  const e = stages[front].entries?.[settings.leftTf] || stages[front].entries?.[settings.rightTf];
  const ns = D.netStats();
  const b = D.budgetStatus();
  const mb = $('modeBadge');
  const cool = D.cooling();
  const follower = !D.amLeader();
  const offline = D.isOffline();
  const skew = D.clockSkew();
  setIf(mb, 'hidden', !(b.over || offline || skew || cool || follower || approxMode()));
  if (mb.hidden) return updateErr(err, e);
  setIf(mb, 'textContent', b.over ? '本日の通信上限' : offline ? '通信が切れています' : skew ? '端末の時計が遅れています' : cool ? '通信を控えています' : follower ? '別のタブで通信中' : '始値は近似');
  setIf(mb, 'title', b.over ? `今日の通信が${b.cap}回に達したため、保存済みのデータで表示しています（明日0時に再開）。それでも、後場の始まり（12:55ごろ）と引け後（16:00ごろ）の2回だけは株価を更新します（米国株は取引開始30分後と引け後）`
    : offline ? 'ネットにつながっていないため、保存済みのデータで表示しています（つながったら自動で再開。この間は1日の通信回数に数えません）'
    : skew ? `端末の時計が約${Math.round(skew / 60e3)}分遅れています。取引時間の判定がずれて余計な通信をすることがあるので、端末の設定で時刻を「自動」にしてください`
    : cool ? '回数制限や通信の失敗が続いたため、しばらく通信を控えています（相手の負担を減らし、ban を防ぐため）'
    : follower ? 'このアプリを別のタブでも開いているため、通信はそちらに任せ、保存済みのデータで表示しています' : `表示対象が${EXACT_OPEN_MAX}銘柄を超えているため、当日の始値は「${OPEN_LABEL[currentPlan().openMode]}」で近似しています`);
  mb.classList.toggle('warn', b.over || !!skew);
  updateErr(err, e);
}
function updateErr(err, e) {
  const errEl = $('errText');
  setIf(errEl, 'hidden', !err || !!err.budget || !!err.quiet);
  if (err) {
    setIf(errEl, 'textContent', (e ? '通信エラー：前回データを表示中' : '通信エラー：データ未取得') + '（タップで詳細）');
    setIf(errEl, 'title', String(err.message || err));
  }
}

function renderCountdown(now = Date.now()) {
  const r = pauseReason(now);
  const el = $('countdown');
  el.classList.toggle('paused', !!r);
  setIf(el, 'textContent', r || `残り ${Math.max(0, st.remaining)}秒`);
  const icon = st.paused ? '#i-play' : '#i-pause';
  if ($('pauseUse').getAttribute('href') !== icon) $('pauseUse').setAttribute('href', icon);
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
  st.openSig = viewSig();
  document.body.classList.add('in-settings');
  $('settings').classList.remove('is-closed');
  fillSettings();
  // 登録銘柄一覧は、前に開いたときから変わっていなければ作り直さない（現在値だけ、画面が出た後に書き換える）
  if (listSig() !== listRendered.sig) renderList();
  else requestAnimationFrame(() => setTimeout(() => {
    if (!st.settingsOpen) return;
    const rows = $('listBody').children;
    list.forEach((x, i) => { if (rows[i]?.dataset.code === x.code) updateAlertRow(x.code, rows[i], x); });
  }, 0));
  takeSnapshot();
  renderCountdown();
}

// apply = true：「設定を保存して戻る」。右側の設定を反映する
// apply = false：× や「戻る」。右側の変更は捨てる（銘柄の登録・並び替えなどは、その場で保存済みなので反映される）
// 自動切替の対象・順番に関わる設定（これが変わったら、閉じたときに表示中の銘柄の「何銘柄目」も描き直す）
function viewSig() { return JSON.stringify([settings.viewMode, settings.order, settings.shuffleSeed, settings.favs, list.map((x) => (x.enabled ? x.code : `-${x.code}`))]); }
function closeSettings(apply = false) {
  const prev = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, ta: settings.ta, t: settings.theme, c: settings.colorMode, f: settings.font });
  if (apply) readSettings();
  save(KEY.settings, settings);
  saveList();
  applyLook();
  applyData();
  updateStatus();
  const next = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, ta: settings.ta, t: settings.theme, c: settings.colorMode, f: settings.font });
  const viewChanged = viewSig() !== st.openSig;
  st.settingsOpen = false;
  if (overviewMode) setOverview(false); // 隠れた全銘柄一覧を更新し続けない（チャート一覧のチャートも消す）
  document.body.classList.remove('in-settings');
  $('settings').classList.add('is-closed');
  st.remaining = settings.interval;
  if (prev !== next) rebuildCharts();
  const cur = activeCodes().includes(st.code) ? list.find((x) => x.code === st.code) : null;
  const code = cur ? cur.code : neighbor(1);
  // 表示設定・順番・お気に入りを変えたときは、同じ銘柄でも描き直す（「お気に入り1 3/5」などの表示をすぐ新しい設定に）
  if (code) {
    if (prev !== next) stages[front].code = null;
    else if (viewChanged && stages[front].code === code && stages[front].entries) render(stages[front], list.find((x) => x.code === code), stages[front].entries, true);
    show(code);
  } else showEmpty(true);
  if (viewChanged) { setTimeout(() => prefetch(nextCode()), 1500); }
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
  fillTa(s.ta);
  $('chkWake').checked = s.wakeLock;
  $('chkChimeJP').checked = s.chimeJP;
  $('chkChimeUS').checked = s.chimeUS;
  $('selChimeSec').value = [3, 5, 10, 15, 30].includes(s.chimeSec) ? String(s.chimeSec) : '5';
  $('chkCloseJP').checked = s.closeJP;
  $('chkCloseUS').checked = s.closeUS;
  $('selCloseSec').value = [3, 5, 10, 15, 30].includes(s.closeSec) ? String(s.closeSec) : '5';
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
  s.ta = cleanTa({
    ma: Object.fromEntries(TF_KEYS.map((tf) => [tf, [0, 1, 2].map((i) => $(`taMa${tf}${i}`).value)])),
    maOn: [0, 1, 2].map((i) => $(`taOn${i}`).checked),
    bb: { n: $('taBbN').value, k: $('taBbK').value },
  });
  s.wakeLock = $('chkWake').checked;
  s.chimeJP = $('chkChimeJP').checked;
  s.chimeUS = $('chkChimeUS').checked;
  s.chimeSec = Number($('selChimeSec').value) || 5;
  s.closeJP = $('chkCloseJP').checked;
  s.closeUS = $('chkCloseUS').checked;
  s.closeSec = Number($('selCloseSec').value) || 5;
  s.theme = $('chkDark').checked ? 'dark' : 'light';
  s.colorMode = $('segColor').dataset.v; s.font = $('segFont').dataset.v;
  return s;
}
function readSettings() { Object.assign(settings, formValues()); }
function fillTa(ta) {
  for (const tf of TF_KEYS) for (let i = 0; i < 3; i++) $(`taMa${tf}${i}`).value = ta.ma[tf][i];
  for (let i = 0; i < 3; i++) $(`taOn${i}`).checked = ta.maOn[i];
  $('taBbN').value = ta.bb.n; $('taBbK').value = ta.bb.k;
}
$('taReset').addEventListener('click', () => { fillTa(cleanTa(null)); setTimeout(updateDirty, 0); });

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
/* 登録銘柄一覧の表。銘柄が多いと作るのに時間がかかるので、
   最初の LIST_FIRST 行だけすぐに作り、残りは画面を止めないよう少しずつ足す。 */
const LIST_FIRST = 60, LIST_CHUNK = 150;
const nextPaint = (fn) => requestAnimationFrame(() => setTimeout(fn, 0)); // 次の描画が終わった後に
const listRendered = { sig: '', gen: 0, done: true };
const listSig = () => JSON.stringify([list, [...D.noDataSet()], [...D.gaveUpSet()]]);
function renderList() {
  $('listCount').textContent = `(${list.length}/${MAX_SYMBOLS})`;
  const noData = D.noDataSet();
  const gaveUp = D.gaveUpSet();
  listRendered.sig = listSig();
  const gen = ++listRendered.gen;
  const html = list.map((x, i) => `
    <tr data-code="${esc(x.code)}">
      <td class="c-no"><span class="grip" title="ドラッグで並び替え"><svg class="ico"><use href="#i-grip"/></svg></span><span class="no">${String(i + 1).padStart(3, '0')}</span></td>
      <td class="c-code num">${esc(x.code)}${isIndex(x.code) ? `<span class="tag idx">${kindTag(x.code)}</span>` : isUS(x.code) ? '<span class="tag">米</span>' : ''}${noData.has(x.code) ? '<span class="tag nd" title="Yahoo にこの銘柄のデータがありません（上場廃止・コード違いの可能性）。今日は取りに行きません">データなし</span>' : gaveUp.has(x.code) ? '<span class="tag nd" title="取得の失敗が5回続いたため、今日はこの銘柄を取りに行きません（明日また試します）">取得失敗</span>' : ''}</td>
      <td class="c-name"><button class="link rename">${esc(x.name || '（名称未設定）')}</button></td>
      <td class="c-price r"></td>
      <td class="c-target"><div class="tgt-box"><input class="tgt" type="text" autocomplete="off" enterkeyhint="done" placeholder="株価を入力" aria-label="${esc(x.code)} の設定株価"><span class="tgt-dir"></span></div></td>
      <td class="c-alert"><label class="switch"><input type="checkbox" class="alert-tg" aria-label="${esc(x.code)} のアラート"><i></i></label></td>
      <td class="c-sw"><label class="switch"><input type="checkbox" class="toggle" ${x.enabled ? 'checked' : ''}><i></i></label></td>
      <td class="c-del"><button class="icon-btn danger del" aria-label="削除"><svg class="ico"><use href="#i-trash"/></svg></button><button class="icon-btn clr" aria-label="${esc(x.code)} の設定株価を消す" title="設定株価を消す"><svg class="ico"><use href="#i-eraser"/></svg></button></td>
    </tr>`);
  $('btnAdd').disabled = list.length >= MAX_SYMBOLS;
  const body = $('listBody');
  const rows = body.children;
  const items = list.slice();
  body.innerHTML = html.slice(0, LIST_FIRST).join('');
  for (let i = 0; i < rows.length; i++) updateAlertRow(items[i].code, rows[i], items[i]);
  listRendered.done = html.length <= LIST_FIRST;
  let at = LIST_FIRST;
  const more = () => {
    if (gen !== listRendered.gen || at >= html.length) return;
    body.insertAdjacentHTML('beforeend', html.slice(at, at + LIST_CHUNK).join(''));
    for (let i = at; i < Math.min(at + LIST_CHUNK, items.length); i++) updateAlertRow(items[i].code, rows[i], items[i]);
    at += LIST_CHUNK;
    if (at >= html.length) listRendered.done = true; else nextPaint(more);
  };
  if (!listRendered.done) nextPaint(more); // 先に画面を出してから続きを足す
  if (alertMode) fillQuotes();
}

/* 起動後の空き時間に、設定画面（登録銘柄一覧の表を含む）を見えないまま1回だけ組み立てて配置を計算しておく。
   最初に ≡ を押したときも、すぐに設定画面が出る。 */
function prewarmSettings() {
  if (st.settingsOpen || document.hidden) return;
  if (listSig() !== listRendered.sig) renderList();
  const el = $('settings');
  const wait = () => {
    if (st.settingsOpen) return;
    if (!listRendered.done) { setTimeout(wait, 100); return; }
    fillSettings();
    el.classList.add('prewarm');
    void el.offsetHeight; // 配置を計算させる
    nextPaint(() => el.classList.remove('prewarm'));
  };
  nextPaint(wait);
}
(window.requestIdleCallback || ((f) => setTimeout(f, 1500)))(() => setTimeout(prewarmSettings, 2500), { timeout: 8000 });

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
window.addEventListener('storage', (e) => {
  if (e.key !== QUOTE_KEY || !e.newValue || D.amLeader()) return;
  try { Object.assign(quotes, JSON.parse(e.newValue)); } catch { return; }
  if (overviewMode) scheduleOverview();
  if (st.settingsOpen && alertMode) list.forEach((x) => updateAlertRow(x.code));
});
let saveQuotesTimer = null;
function saveQuotes() {
  clearTimeout(saveQuotesTimer);
  saveQuotesTimer = setTimeout(() => {
    const keep = new Set(list.map((x) => x.code));
    for (const k of Object.keys(quotes)) if (!keep.has(k)) delete quotes[k];
    save(QUOTE_KEY, quotes);
  }, 1500);
}
const slimQuote = (q) => ({ price: q.price, chg: q.chg ?? null, pct: q.pct ?? null, time: q.time ?? null, fetchedAt: q.fetchedAt ?? null });
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
document.querySelectorAll('.chime-test').forEach((b) => b.addEventListener('click', () => {
  if (alarmPlaying() && alarmKind() === b.dataset.kind) { stopAlarm(); return; }
  // 試聴は、その欄で選んでいる鳴らす時間（回数）のとおりに鳴らす
  const sel = b.dataset.kind.endsWith('Close') ? $('selCloseSec') : $('selChimeSec');
  playAlarm(Number(sel.value) || 5, b.dataset.kind);
}));
$('selAlertSec').addEventListener('change', (e) => { settings.alertSec = Number(e.target.value) || DEFAULTS.alertSec; save(KEY.settings, settings); });

const rowOf = (code) => $('listBody').querySelector(`tr[data-code="${CSS.escape(code)}"]`);
function updateAlertRow(code, tr = rowOf(code), x = list.find((i) => i.code === code)) {
  if (!tr || !x) return;
  const us = dec2(code);
  const cur = priceOf(code);
  // 変わった所だけ書き換える（999銘柄を開くたびに全部書き換えると、画面の再計算で設定画面が重くなる）
  const key = `${cur}|${x.alertOn ? 1 : 0}|${x.alertPrice ?? ''}`;
  if (tr._k === key && document.activeElement?.closest?.('tr') !== tr) return;
  tr._k = key;
  setIf(tr.querySelector('.c-price'), 'textContent', cur != null ? fmtNum(cur, us) : '—');
  const on = !!x.alertOn;
  setIf(tr.querySelector('.alert-tg'), 'checked', on);
  const inp = tr.querySelector('.tgt');
  setIf(inp, 'disabled', !on); // アラートが OFF の間は入力できない
  if (document.activeElement !== inp) setIf(inp, 'value', x.alertPrice ? fmtNum(x.alertPrice, us) : '');
  const box = tr.querySelector('.tgt-box');
  if (box.classList.contains('off') !== !on) box.classList.toggle('off', !on);
  setIf(tr.querySelector('.clr'), 'disabled', !x.alertPrice && !on);
  // ▲：今より上に設定（上抜けで通知） ／ ▼：今より下に設定（下抜けで通知）
  const T = x.alertPrice;
  const d = T && cur != null ? (T > cur ? 'up' : T < cur ? 'down' : '') : '';
  const dir = tr.querySelector('.tgt-dir');
  setIf(dir, 'textContent', d === 'up' ? '▲' : d === 'down' ? '▼' : '');
  setIf(dir, 'className', `tgt-dir ${d}`);
  setIf(dir, 'title', d === 'up' ? '上抜けで通知' : d === 'down' ? '下抜けで通知' : '');
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
function scheduleOverview() {
  clearTimeout(ovTimer);
  ovTimer = setTimeout(() => {
    if (!overviewMode) return;
    // チャート一覧では、チャートは描き直さず前日比の文字と集計だけ書き換える（重くしない）
    if (ovCharts) { list.forEach((x) => updateTile(x.code)); renderOvSum(); } else renderOverview();
  }, 300);
}
function setOverview(on) {
  overviewMode = on;
  $('settings').classList.toggle('overview-mode', on);
  if (!on) { ocClear(); return; }
  seg('segOvSort', ovSort, (v) => { ovSort = v; renderOverview(); });
  seg('segOvTf', ovTf, (v) => { ovTf = v; ovPeriodOptions(); renderOverview(); });
  ovPeriodOptions();
  renderOverview();
  fillQuotes(); // 控えに無い銘柄だけ読み、そろった分から表示する
}
$('btnOvChart').addEventListener('click', () => {
  ovCharts = !ovCharts;
  renderOverview();
});

/* チャート一覧（2列）：保存済みのデータだけで描く（この画面のための通信はしない）。
   重くならないように
   ・画面に近づいたカードだけ描き、離れたら消す（同時に描くのは最大 OC_LIVE 枚）
   ・スクロール中は描き始めを少し待ち、1回に1枚ずつ描く */
let ovCharts = false;
let ovTf = '1d';
const OC_LIVE = 16;
// 表示期間の選択肢は、設定画面のチャートの「初期表示期間」と同じ（その場で保存）
function ovPeriodOptions() {
  const sel = $('selOvBars');
  sel.innerHTML = D.TF[ovTf].periods.map(([n, l]) => `<option value="${n}">${l}</option>`).join('');
  sel.value = String(settings.ovBars[ovTf]);
}
$('selOvBars').addEventListener('change', () => {
  settings.ovBars[ovTf] = Number($('selOvBars').value);
  save(KEY.settings, settings);
  renderOverview();
});
// チャートの縦横比：株価画面のチャートの高さの約0.7倍（横長すぎ・縦長すぎにはしない）。
// さらに、カード1枚（見出し＋チャート）が一覧の画面の高さに収まるようにする
const OC_HEIGHT = 0.7;
function ocAspect() {
  const box = stages[front].root.querySelector('.chart-box');
  const w = box?.clientWidth, h = box?.clientHeight;
  let ar = w && h ? Math.min(1.6, Math.max(0.75, w / h)) / OC_HEIGHT : 1.4;
  const wrap = $('ovCharts');
  const cs = getComputedStyle(wrap);
  const cols = cs.gridTemplateColumns.split(' ').length || 1;
  const gap = parseFloat(cs.columnGap) || 0;
  const colW = (wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - gap * (cols - 1)) / cols;
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - fs * 2.2; // 見出しの分を引く
  if (colW > 0 && availH > 80) ar = Math.max(ar, colW / availH);
  wrap.style.setProperty('--oc-ar', ar.toFixed(3));
}
const ocLive = new Map(); // code -> { chart, el }
let ocObs = null;
let ocQueue = [];
let ocBusy = false;
let ocGen = 0;
function ocClear() {
  ocGen++;
  ocObs?.disconnect();
  ocObs = null;
  ocQueue = [];
  for (const v of ocLive.values()) v.chart?.destroy();
  ocLive.clear();
  $('ovCharts').innerHTML = '';
}
// チャート一覧のカードの見出しの、現在値・前日比
function ocQuoteHtml(x) {
  const q = quotes[x.code];
  const us = isUS(x.code);
  const idx = isIndex(x.code);
  const qs = quoteStatus(x.code, q);
  const waiting = qs?.state === 'pending' || qs?.state === 'special';
  const pct = waiting || q?.pct == null ? null : q.pct;
  const d = pct == null ? '' : pct > 0 ? 'up' : pct < 0 ? 'down' : '';
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');
  const price = q?.price == null ? '' : `${ovMoney(q.price, us, idx)}${!us && !idx ? '<small>円</small>' : ''}`;
  const chg = qs?.state === 'pending' ? '−' : qs?.state === 'special' ? '特'
    : q?.chg == null ? '' : `${sign(q.chg)}${fmtNum(Math.abs(q.chg), us || idx, q.price)}${pct == null ? '' : ` (${sign(pct)}${Math.abs(pct).toFixed(2)}%)`}`;
  return `<span class="oc-quote"><span class="oc-price">${price}</span><span class="oc-pct ${d}">${chg}</span></span>`;
}
// カードを押しても株価画面には移らない（スクロールの途中で触れても画面が変わらないように）
function ocCardHtml(x) {
  return `<div class="oc-card" data-code="${esc(x.code)}">
    <div class="oc-head"><span class="oc-code">${esc(x.code)}</span><span class="oc-name">${esc(x.name || '（名称未設定）')}</span>${ocQuoteHtml(x)}</div>
    <div class="oc-box"><div class="oc-msg">　</div></div>
  </div>`;
}
async function renderCharts(rows) {
  ocClear();
  ocAspect();
  const gen = ocGen;
  const box = $('ovCharts');
  // 保存済みのチャートデータが無い銘柄は並べない（この画面では通信しないため描けない）
  const have = await D.storedCodes().catch(() => null);
  if (gen !== ocGen) return;
  const shown = have ? rows.filter((x) => have.has(x.code)) : rows;
  box.innerHTML = shown.map(ocCardHtml).join('') || `<p class="ov-empty">${rows.length ? 'チャートを描ける保存済みのデータがありません' : '登録銘柄がありません'}</p>`;
  ocObs = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const code = en.target.dataset.code;
      if (en.isIntersecting) { if (!ocLive.has(code) && !ocQueue.includes(code)) ocQueue.push(code); }
      else {
        ocQueue = ocQueue.filter((c) => c !== code);
        const v = ocLive.get(code);
        if (v) { v.chart?.destroy(); ocLive.delete(code); en.target.querySelector('.oc-box').innerHTML = '<div class="oc-msg">　</div>'; }
      }
    }
    ocPump(gen);
  }, { root: box, rootMargin: '200px 0px' });
  box.querySelectorAll('.oc-card').forEach((el) => ocObs.observe(el));
}
async function ocPump(gen) {
  if (ocBusy) return;
  ocBusy = true;
  try {
    while (ocQueue.length && gen === ocGen && overviewMode && ovCharts) {
      const code = ocQueue.shift();
      const el = $('ovCharts').querySelector(`.oc-card[data-code="${CSS.escape(code)}"]`);
      if (!el || ocLive.has(code)) continue;
      // 同時に描くのは OC_LIVE 枚まで（多いときは古いものから消す）
      while (ocLive.size >= OC_LIVE) {
        const [old, v] = ocLive.entries().next().value;
        v.chart?.destroy();
        ocLive.delete(old);
        const oe = $('ovCharts').querySelector(`.oc-card[data-code="${CSS.escape(old)}"] .oc-box`);
        if (oe) oe.innerHTML = '<div class="oc-msg">　</div>';
      }
      const tf = ovTf;
      const all = await D.peekBars(code, tf); // 保存済みのデータだけ（通信しない）
      if (gen !== ocGen || tf !== ovTf) return;
      const boxEl = el.querySelector('.oc-box');
      if (!all?.length) { // 保存データが消えていた銘柄は、カードごと外す
        ocObs?.unobserve(el);
        el.remove();
        continue;
      }
      boxEl.innerHTML = '';
      const host = document.createElement('div');
      host.className = 'lc';
      boxEl.append(host);
      const n = settings.ovBars[tf];
      const bars = n > 0 ? all.slice(-n) : all;
      ocLive.set(code, { chart: miniChart(host, bars, tf, themeColors(), settings.ind, settings.ta) });
      await frames(1); // 1枚描くごとに画面を更新（スクロールを止めない）
    }
  } finally {
    ocBusy = false;
  }
}
$('btnOverview').addEventListener('click', () => setOverview(true));
$('btnOvBack').addEventListener('click', () => setOverview(false));
const ovMoney = (v, us, idx) => (v == null ? '—' : us ? `US$${fmtNum(v, true)}` : idx ? fmtNum(v, true) : fmtNum(v));
function tileHtml(x) {
  const q = quotes[x.code];
  const us = isUS(x.code);
  const idx = isIndex(x.code);
  const qs = quoteStatus(x.code, q);
  const waiting = qs?.state === 'pending' || qs?.state === 'special';
  const pct = waiting ? null : q?.pct;
  const dir = pct == null ? '' : pct > 0 ? 'up' : pct < 0 ? 'down' : '';
  // 色の濃さ：前日比 0〜5% を 8〜38% の濃さに（5%以上は同じ）
  const heat = dir ? 8 + (Math.min(Math.abs(pct), 5) / 5) * 30 : 0;
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');
  const chg = qs?.state === 'pending' ? '−' : qs?.state === 'special' ? '<b class="ov-sp">特</b>'
    : q?.chg == null ? '' : `${sign(q.chg)}${us || idx ? fmtNum(Math.abs(q.chg), true, q.price) : fmtNum(Math.abs(q.chg), false, q.price)}`;
  const lim = qs?.limit ? `<b class="ov-lim ${qs.limit === 'high' ? 'lim-high' : 'lim-low'}">${qs.limit === 'high' ? '高' : '安'}</b>` : '';
  const pctTxt = pct == null ? '' : `${sign(pct)}${Math.abs(pct).toFixed(2)}%`;
  const flags = `${x.alertOn ? '<svg class="ico" aria-label="アラート中"><use href="#i-bell"/></svg>' : ''}${idx ? `<span class="ov-badge">${kindTag(x.code)}</span>` : us ? '<span class="ov-badge">米</span>' : ''}${x.enabled ? '' : '<span class="ov-badge">表示OFF</span>'}`;
  return `<button type="button" class="ov-tile ${dir ? `t-${dir}` : ''}${x.enabled ? '' : ' off'}" data-code="${esc(x.code)}" style="--heat:${heat.toFixed(0)}%">
    <div class="ov-top"><span>${esc(x.code)}</span><span class="ov-flags">${flags}</span></div>
    <div class="ov-name">${esc(x.name || '（名称未設定）')}</div>
    <div class="ov-price">${q ? ovMoney(q.price, us, idx) : '<span class="ov-empty">データ未取得</span>'}${q && !us && !idx ? '<small>円</small>' : ''}</div>
    <div class="ov-chg"><span class="v">${chg}${lim}</span><span class="v pct-r">${pctTxt ? `(${pctTxt})` : ''}</span></div>
    <div class="ov-chg ov-pct"><span class="ov-time">${q?.time ? M.fmtStamp(q.time * 1000) : ''}</span></div>
  </button>`;
}
// 前日比（値と％）の行がタイルの幅に入りきらないときだけ、その行の文字を小さくする（大きな値の銘柄・狭い画面）
function fitChg(root) {
  if (!root) return;
  const rows = [...root.querySelectorAll('.ov-chg:not(.ov-pct)')];
  const over = rows.map((r) => [r, r.scrollWidth, r.clientWidth]).filter(([, sw, cw]) => cw > 0 && sw > cw + 1) // まとめて測ってから
    .map(([r, sw, cw]) => [r, parseFloat(getComputedStyle(r).fontSize) * Math.max(0.6, (cw - 2) / sw)]);
  for (const [r, px] of over) r.style.fontSize = `${px.toFixed(1)}px`; // まとめて書き換える
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
  $('btnOvChart').classList.toggle('on', ovCharts);
  $('btnOvChart').setAttribute('aria-pressed', String(ovCharts));
  $('ovChartTools').hidden = !ovCharts;
  $('ovGrid').hidden = ovCharts;
  $('ovCharts').hidden = !ovCharts;
  if (ovCharts) { $('ovGrid').innerHTML = ''; renderCharts(rows); } else { ocClear(); $('ovGrid').innerHTML = rows.map(tileHtml).join('') || '<p class="ov-empty">登録銘柄がありません</p>'; fitChg($('ovGrid')); }
  renderOvSum();
}
function renderOvSum() {
  const key = (x) => quotes[x.code]?.pct;
  let up = 0, down = 0, flat = 0;
  for (const x of list) { const v = key(x); if (v == null) continue; if (v > 0) up++; else if (v < 0) down++; else flat++; }
  $('ovCount').textContent = `(${list.length}銘柄)`;
  $('ovSum').innerHTML = `<span>値上がり <b class="up">${up}</b></span><span>値下がり <b class="down">${down}</b></span><span>変わらず <b>${flat}</b></span>`;
}
function updateTile(code) {
  const x = list.find((i) => i.code === code);
  if (!x || !overviewMode) return;
  if (ovCharts) { // チャート一覧：前日比の文字だけ書き換える（チャートは描き直さない）
    const h = $('ovCharts').querySelector(`.oc-card[data-code="${CSS.escape(code)}"] .oc-quote`);
    if (h) { const html = ocQuoteHtml(x); if (html !== h.outerHTML) h.outerHTML = html; }
    return;
  }
  if (ovSort !== 'list') { scheduleOverview(); return; } // 並び順が変わるので全体を描き直す
  const el = $('ovGrid').querySelector(`[data-code="${CSS.escape(code)}"]`);
  if (el) { el.outerHTML = tileHtml(x); fitChg($('ovGrid').querySelector(`[data-code="${CSS.escape(code)}"]`)); }
}
// タイルを押したら、その銘柄のチャートへ（チャート一覧のカードは押しても移らない）
$('ovGrid').addEventListener('click', (e) => {
  const t = e.target.closest('.ov-tile');
  if (!t) return;
  st.code = t.dataset.code;
  persistState();
  closeSettings(false);
});

/* ---------------- 銘柄表示設定・お気に入り ----------------
   表示設定とお気に入りはその場で保存する（銘柄の登録・並び替えと同じ扱い。× で戻るだけで反映）。 */
const viewDlg = $('viewDialog');
const favDlg = $('favDialog');
function renderViewButton() {
  $('vmCurrent').textContent = settings.viewMode === 'all' ? '' : `（${viewLabel(settings.viewMode)}）`;
}
function renderViewDialog() {
  $('vmModes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.viewMode));
  $('vmFavs').innerHTML = Array.from({ length: 12 }, (_, i) => {
    const n = i + 1;
    const cnt = favCodes(n).length;
    const on = settings.viewMode === `fav${n}`;
    return `<button type="button" class="vm-fav${cnt ? ' reg' : ''}${on ? ' on' : ''}" data-fav="${n}">お気に入り${n}<small>${cnt ? `${cnt}銘柄` : '未登録'}</small></button>`;
  }).join('');
}
function setViewMode(mode) {
  if (mode === 'random') { st.randomSeed = 1 + Math.floor(Math.random() * 2 ** 30); st.randomAvoid = null; } // 選び直したら混ぜ直す
  settings.viewMode = mode;
  save(KEY.settings, settings);
  listVer++;
  applyData();
  renderViewButton();
  renderViewDialog();
  toast(`「${viewLabel(mode)}」で表示します${st.settingsOpen ? '（設定画面を閉じると切り替わります）' : ''}`);
}
$('btnViewMode').addEventListener('click', () => { renderViewDialog(); viewDlg.showModal(); });
$('btnViewClose').addEventListener('click', () => viewDlg.close());
viewDlg.addEventListener('click', (e) => { if (e.target === viewDlg) viewDlg.close(); });
$('vmModes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  setViewMode(b.dataset.mode);
  viewDlg.close();
});
$('vmFavs').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-fav]');
  if (!b) return;
  const n = Number(b.dataset.fav);
  const cnt = favCodes(n).length;
  if (!cnt) { openFavEditor(n); return; }
  const r = await ask(`お気に入り${n}を表示しますか？（${cnt}銘柄）`, { ok: 'はい', alt: '銘柄設定' });
  if (r === true) { setViewMode(`fav${n}`); viewDlg.close(); } else if (r === 'alt') openFavEditor(n);
});

let favEditing = 0;
function favUpdateCount() {
  const n = $('favList').querySelectorAll('input:checked').length;
  $('favCount').textContent = `${n} / ${list.length}銘柄を選択中`;
}
function openFavEditor(n) {
  favEditing = n;
  const sel = new Set(settings.favs[n - 1] || []);
  $('favTitle').textContent = `お気に入り${n}の銘柄`;
  $('favList').innerHTML = list.map((x) => `<label class="fav-row"><input type="checkbox" value="${esc(x.code)}"${sel.has(x.code) ? ' checked' : ''}>
    <span class="num code">${esc(x.code)}</span><span class="nm">${esc(x.name || '（名称未設定）')}</span>${isIndex(x.code) ? `<span class="tag idx">${kindTag(x.code)}</span>` : isUS(x.code) ? '<span class="tag">米</span>' : ''}</label>`).join('')
    || '<p class="muted">登録銘柄がありません。先に「新規登録」で銘柄を登録してください。</p>';
  $('favClear').hidden = !sel.size;
  favUpdateCount();
  favDlg.showModal();
}
$('favList').addEventListener('change', favUpdateCount);
$('favAll').addEventListener('click', () => { $('favList').querySelectorAll('input').forEach((i) => { i.checked = true; }); favUpdateCount(); });
$('favNone').addEventListener('click', () => { $('favList').querySelectorAll('input').forEach((i) => { i.checked = false; }); favUpdateCount(); });
$('favCancel').addEventListener('click', () => favDlg.close());
$('btnFavClose').addEventListener('click', () => favDlg.close());
function saveFav(n, codes) {
  settings.favs[n - 1] = codes;
  if (!codes.length && settings.viewMode === `fav${n}`) settings.viewMode = 'all'; // 空にしたら全銘柄表示に戻す
  save(KEY.settings, settings);
  listVer++;
  applyData();
  renderViewButton();
  renderViewDialog();
}
$('favSave').addEventListener('click', async () => {
  const n = favEditing;
  const codes = [...$('favList').querySelectorAll('input:checked')].map((i) => i.value);
  const was = favCodes(n).length;
  saveFav(n, codes);
  favDlg.close();
  if (!codes.length) { toast(`お気に入り${n}の登録を消しました`); return; }
  if (settings.viewMode === `fav${n}`) { toast(`お気に入り${n}を更新しました（${codes.length}銘柄）`); return; }
  const r = await ask(`お気に入り${n}に${codes.length}銘柄を${was ? '登録し直しました' : '登録しました'}。お気に入り${n}を表示しますか？`, { ok: 'はい', cancel: 'あとで' });
  if (r === true) { setViewMode(`fav${n}`); viewDlg.close(); }
});
$('favClear').addEventListener('click', async () => {
  const n = favEditing;
  if (!(await ask(`お気に入り${n}の登録を消しますか？`, { ok: '消す', danger: true }))) return;
  saveFav(n, []);
  favDlg.close();
  toast(`お気に入り${n}の登録を消しました`);
});
renderViewButton();

/* ---------------- 順番設定（その場で保存。× で戻るだけで反映） ---------------- */
const orderDlg = $('orderDialog');
function renderOrderButton() {
  $('odCurrent').textContent = settings.order === 'manual' ? '' : `（${ORDER_SHORT[settings.order] || ORDER_LABEL[settings.order]}）`;
}
function renderOrderDialog() {
  $('odModes').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.order === settings.order));
}
async function setOrder(order) {
  if (order === 'shuffle') settings.shuffleSeed = 1 + Math.floor(Math.random() * 2 ** 30);
  if (order === 'name' && !dictReady()) await loadDict(); // 日本株の読み（あいうえお順に使う）
  if (order === 'up' || order === 'down') await fillQuotes(); // 前日比の控えが無い銘柄は保存済みのデータから読む（通信しない）
  settings.order = order;
  save(KEY.settings, settings);
  listVer++;
  applyData();
  renderOrderButton();
  renderOrderDialog();
  const note = settings.viewMode === 'random' ? '（「順番ランダム」表示の間はランダムの順になります）' : st.settingsOpen ? '（設定画面を閉じると切り替わります）' : '';
  toast(`自動切替を「${ORDER_LABEL[order]}」にしました${note}`);
}
$('btnOrder').addEventListener('click', () => { renderOrderDialog(); orderDlg.showModal(); });
$('btnOrderClose').addEventListener('click', () => orderDlg.close());
orderDlg.addEventListener('click', (e) => { if (e.target === orderDlg) orderDlg.close(); });
$('odModes').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-order]');
  if (!b) return;
  orderDlg.close();
  await setOrder(b.dataset.order);
});
renderOrderButton();

/* ---------------- アプリ内の確認画面 ----------------
   ブラウザ標準の確認画面（confirm / prompt / alert）は Android で全画面表示を解除してしまうため使わない。
   ask(文言) → OK なら true / キャンセルなら false
   ask(文言, { input: 初期値 }) → 入力した文字 / キャンセルなら null
   ask(文言, { alert: true }) → OK ボタンだけ */
// ask(文言, { ok: 'はい', alt: '銘柄設定' }) → 'OK' なら true ／ alt のボタンなら 'alt' ／ キャンセルなら false
function ask(msg, { input = null, ok = 'OK', danger = false, alert: only = false, rows = 1, alt = null, cancel = 'キャンセル' } = {}) {
  const d = $('askDialog');
  $('askMsg').textContent = msg;
  const inp = $('askInput');
  inp.hidden = input == null;
  inp.value = input ?? '';
  inp.rows = rows;
  $('askOk').textContent = ok;
  $('askOk').classList.toggle('danger-fill', danger);
  $('askCancel').hidden = only;
  $('askCancel').textContent = cancel;
  $('askAlt').hidden = !alt;
  $('askAlt').textContent = alt || '';
  d.showModal();
  if (input != null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
  return new Promise((resolve) => {
    const done = (v) => { d.close(); $('askForm').onsubmit = null; $('askCancel').onclick = null; $('askAlt').onclick = null; d.oncancel = null; resolve(v); };
    $('askAlt').onclick = () => done('alt');
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
    // まだ表に足していない行（銘柄が多いときの描画の途中）は、元の順のまま後ろに
    list.forEach((x, i) => { if (!pos.has(x.code)) pos.set(x.code, order.length + i); });
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
  // Yahoo 検索は英字3文字以上・入力が1秒止まってから・手元の辞書で3件未満しか見つからないときだけ（通信を減らす）
  if (ascii && q.length >= 3 && results.length < 3) {
    remoteTimer = setTimeout(async () => {
      try {
        const remote = await D.searchRemote(q);
        if (seq !== searchSeq) return;
        for (const x of remote) if (!results.some((y) => y.code === x.code)) results.push({ ...x, name: lookupName(x.code) || x.name });
        showResults(results.slice(0, 30), results.length ? '候補をタップしてください' : '見つかりませんでした。銘柄コード（例: 7203）またはティッカー（例: AAPL）で入力してください。');
      } catch {
        if (seq === searchSeq && !results.length) $('addMsg').textContent = '見つかりませんでした';
      }
    }, 1000);
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
  D.clearFailure(code);
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
  const bs = D.budgetStatus();
  $('netSummary').innerHTML = `
    <div><span class="k">今日の通信</span><b>${bs.used}</b><span class="u">/ ${bs.cap}回</span></div>
    <div><span class="k">最終通信</span><b>${ns.lastAt ? M.fmtStamp(ns.lastAt, now) : '—'}</b></div>
    <div><span class="k">状態</span><b>${ns.active ? '通信中' : ns.pausedUntil ? '一時停止中' : '待機中'}</b></div>`;
  const log = D.netLog();
  $('netLogBody').innerHTML = log.length ? log.slice(0, 30).map((x) => `
    <tr class="${x.ok ? '' : 'ng'}">
      <td class="num">${M.fmtClock(x.t)}</td>
      <td>${esc(x.code)}</td>
      <td>${x.ok ? '成功' : '<span class="err">失敗</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="3" class="muted">この画面を開いてからの通信はまだありません</td></tr>';
}
function openNet() { netDlg.showModal(); renderNet(); }
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
// 通信が戻ったら、表示中の銘柄をすぐに最新化する
window.addEventListener('online', () => { if (!st.settingsOpen && st.code && !document.hidden) setTimeout(() => show(st.code), 2000); updateStatus(); });
window.addEventListener('offline', () => updateStatus());
document.addEventListener('pointerdown', (e) => {
  keepAwake();
  unlockAudio();
  // ポップアップを出さない設定で音だけ鳴っているときは、画面に触れたら止める
  if (alarmPlaying() && !document.querySelector('.alert-card') && !e.target.closest?.('.chime-test')) stopAlarm();
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  keepAwake();
  if (!st.settingsOpen && st.code) show(st.code); // 復帰時にキャッシュ期限切れなら更新
});

/* ---------------- 起動 ---------------- */
loadDict().then(() => {
  if (settings.order === 'name') listVer++; // 日本株の読みがそろったので、名前順を並べ直す
  if (settings.order === 'up' || settings.order === 'down') fillQuotes().then(() => { listVer++; });
  let changed = false;
  for (const x of list) if (!x.name) { const n = lookupName(x.code); if (n) { x.name = n; changed = true; } }
  if (changed) saveList();
});
applyLook();
applyData();
rebuildCharts();
stages[0].root.classList.add('active');
{
  const first = activeCache.pos.has(st.code) || activeCodes().includes(st.code) ? st.code : neighbor(1);
  if (first) show(first); else showEmpty(true);
}
updateStatus();
renderCountdown();
setInterval(tick, 1000);
keepAwake();
// 画面の向き・大きさが変わったら銘柄名の文字サイズを調整し直す
window.addEventListener('resize', () => { stages.forEach((s) => s.fitTitle()); if (overviewMode && ovCharts) ocAspect(); });

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
   1時間に1回、小さなファイル（version.json、GitHub 上）を確認するだけで、株価の取得先には通信しない。 */
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '0';
let lastUpdateCheck = Date.now();
async function checkUpdate() {
  if (document.hidden || st.settingsOpen || userIsTouching() || netDlg.open || dlg.open || $('askDialog').open) return;
  if (Date.now() - lastUpdateCheck < 55 * 60e3 || D.isOffline()) return; // 確認は1時間に1回（画面に戻ったときも同じ）
  lastUpdateCheck = Date.now();
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
setInterval(checkUpdate, 5 * 60e3); // 5分ごとに見て、前回の確認から1時間たっていれば確認する
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

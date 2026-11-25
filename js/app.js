import * as M from './market.js?v=20261125113748';
import * as D from './data.js?v=20261125113748';
import { Stage, themeColors } from './chart.js?v=20261125113748';
import { lookupName, searchLocal, loadDict, dictReady, cleanQuery, isUS, JP_RE, US_RE } from './names.js?v=20261125113748';

const MAX_SYMBOLS = 999;
const KEY = { list: 'tm.list.v1', settings: 'tm.settings.v1', state: 'tm.state.v1' };
const TOUCH_HOLD_MS = 10000;   // 画面操作後、自動巡回を止めておく時間
const NAV_FETCH_DELAY = 350;   // 前/次の連打対策：表示が落ち着いてから通信する

const DEFAULTS = {
  interval: 30, offHours: 'continue',
  leftTf: '1d', rightTf: '1mo', leftBars: 126, rightBars: 120,
  ind: { ma: true, bb: false, vol: true },
  theme: 'dark', colorMode: 'jp', font: 'm', wakeLock: true,
};
// 画面に出さない固定値
const CACHE_MIN = 2;      // 場中のキャッシュ有効時間（分）
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
  s.interval = int(raw.interval, 10, 300, DEFAULTS.interval);
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
  return s;
}
function cleanList(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object' || typeof x.code !== 'string') continue;
    const code = x.code.trim().toUpperCase().slice(0, 10);
    if (!(JP_RE.test(code) || US_RE.test(code)) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: typeof x.name === 'string' ? x.name.slice(0, 120) : '', enabled: x.enabled !== false });
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
const EXACT_OPEN_MAX = 100;
const approxMode = () => enabledCount() > EXACT_OPEN_MAX;
function applyData() {
  D.configure({
    demo: DEMO, ttlMs: CACHE_MIN * 60e3,
    approxOpen: approxMode(),
    // まとめて取得の対象：この先表示される20銘柄（表示中の銘柄を含む）
    upcoming: () => [st.code, ...upcomingFrom(20)].filter(Boolean),
  });
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
// この先表示する銘柄（次の次から n 件）
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
function upcoming(n) {
  const out = [];
  let code = neighbor(1);
  for (let i = 0; i < n && code; i++) {
    code = neighbor(1, code);
    if (!code || code === st.code || out.includes(code)) break;
    out.push(code);
  }
  return out;
}
const userIsTouching = () => Date.now() < st.touchUntil;
function enabledCount() { return list.filter((x) => x.enabled).length; }
const marketOf = (code) => (isUS(code) ? 'US' : 'JP');
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
async function show(code, { nav = false, force = false, retry = false } = {}) {
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
  if (!isSame) await present(item, cached, seq, !hasCache); // 未取得なら銘柄名と「読込中」を先に表示

  if (nav) { await new Promise((r) => setTimeout(r, NAV_FETCH_DELAY)); if (seq !== st.seq) return; }

  setLoading(true);
  const res = await D.loadSet(code, tfs, {
    force,
    prio: D.PRIO.show,
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
  if (res.error && !(st.retry?.code === code && st.retry.n >= 3)) {
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

function go(delta, nav = true) {
  const code = neighbor(delta);
  st.remaining = settings.interval;
  if (!code) { showEmpty(true); renderCountdown(); return; }
  show(code, { nav });
  renderCountdown();
}

async function prefetch(code) {
  if (!code || st.prefetching === code) return;
  st.prefetching = code;
  try {
    const r = await D.loadSet(code, neededTfs(), { prio: D.PRIO.prefetch });
    if (r.error) st.lastError = r.error;
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
    if (st.remaining <= 0) go(1, false);
  }
  renderCountdown(now);
}

/* ---------------- 裏での先回り取得 ----------------
   表示を待たずに、登録銘柄のチャートデータを1件ずつ順番に取得・更新しておく。
   未取得の銘柄を優先し、場中は15分以上古いものだけを更新する（通信量を抑えるため）。 */
const WARM_EVERY_MS = 8000;
const WARM_MAX_AGE = 10 * 60e3;
let warmAt = 0, warmBusy = false, warmCursor = 0;
const haveData = new Set(); // データ取得済みと確認できた銘柄（毎回の確認を省くため）
async function warmTick(now) {
  if (warmBusy || st.settingsOpen || document.hidden || now - warmAt < WARM_EVERY_MS || !D.isIdle()) return;
  warmAt = now;
  const tfs = neededTfs();
  const ok = (code) => { const f = D.failureOf(code); return !f || now > f.until; };
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
  $('statusText').textContent = `${m === 'US' ? '米国' : '東証'}・${ph.open ? `接続中（${ph.label}）` : ph.label}`;
  const e = stages[front].entries?.[settings.leftTf] || stages[front].entries?.[settings.rightTf];
  const ns = D.netStats();
  const b = D.budgetStatus();
  const mb = $('modeBadge');
  mb.hidden = !(b.over || approxMode());
  mb.textContent = b.over ? '本日の通信上限' : '始値は近似';
  mb.title = b.over ? '今日の通信が300回に達したため、保存済みのデータで表示しています（明日0時に再開）' : `表示対象が${EXACT_OPEN_MAX}銘柄を超えているため、当日の始値は最初の1分の値で近似しています`;
  mb.classList.toggle('warn', b.over);
  const errEl = $('errText');
  errEl.hidden = !err || !!err.budget;
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
  st.settingsOpen = true;
  document.body.classList.add('in-settings');
  $('settings').hidden = false;
  fillSettings();
  renderList();
  takeSnapshot();
  renderCountdown();
}

function closeSettings() {
  const prev = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, t: settings.theme, c: settings.colorMode, f: settings.font });
  readSettings();
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
  s.interval = clamp($('inpInterval').value, 10, 300, 30);
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

// 何か変更したときだけ「設定を保存して戻る」ボタンを出す
let snapForm = '', snapList = '';
// 並び替えはその場で保存しているので、比較するときは並び順を無視する
const listKey = () => JSON.stringify([...list].sort((a, b) => a.code.localeCompare(b.code)));
function takeSnapshot() { snapForm = JSON.stringify(formValues()); snapList = listKey(); updateDirty(); }
function updateDirty() {
  if (!st.settingsOpen) return;
  const dirty = JSON.stringify(formValues()) !== snapForm || listKey() !== snapList;
  $('btnSave').hidden = !dirty;
}
['input', 'change', 'click'].forEach((ev) => $('settings').addEventListener(ev, () => setTimeout(updateDirty, 0)));

/* ---------------- 銘柄一覧 ---------------- */
function renderList() {
  $('listCount').textContent = `(${list.length}/${MAX_SYMBOLS})`;
  $('listBody').innerHTML = list.map((x, i) => `
    <tr data-code="${esc(x.code)}">
      <td class="c-no"><span class="grip" title="ドラッグで並び替え"><svg class="ico"><use href="#i-grip"/></svg></span><span class="no">${String(i + 1).padStart(3, '0')}</span></td>
      <td class="c-code num">${esc(x.code)}${isUS(x.code) ? '<span class="tag">米</span>' : ''}</td>
      <td class="c-name"><button class="link rename">${esc(x.name || '（名称未設定）')}</button></td>
      <td class="c-sw"><label class="switch"><input type="checkbox" class="toggle" ${x.enabled ? 'checked' : ''}><i></i></label></td>
      <td class="c-del"><button class="icon-btn danger del" aria-label="削除"><svg class="ico"><use href="#i-trash"/></svg></button></td>
    </tr>`).join('');
  $('btnAdd').disabled = list.length >= MAX_SYMBOLS;
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
    [...clone.children].forEach((td, i) => { td.style.width = `${tr.children[i].getBoundingClientRect().width}px`; });
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

/* ---------------- 新規登録ダイアログ ---------------- */
const dlg = $('addDialog');
const normCode = (v) => {
  const c = String(v || '').trim().normalize('NFKC').toUpperCase().replace(/\.T$/, '').replace(/\./g, '-');
  return c;
};
const validCode = (c) => JP_RE.test(c) || US_RE.test(c);
function setMarketLabel(code) {
  $('addMarketLabel').value = !code ? '' : isUS(code) ? '米国株' : JP_RE.test(code) ? '日本株（東証）' : '';
}

$('btnAdd').addEventListener('click', () => {
  $('addQuery').value = ''; $('addCode').value = ''; $('addName').value = '';
  setMarketLabel('');
  $('addResults').innerHTML = ''; $('addMsg').textContent = '';
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
  if (!results.some((x) => x.code === asCode) && validCode(asCode)) results.push({ code: asCode, name: lookupName(asCode) || '（コードとして登録）', market: isUS(asCode) ? '米国' : '東証' });
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
const KIND_SHORT = (w) => w;
function renderNet() {
  if (!netDlg.open) return;
  const now = Date.now();
  const ns = D.netStats();
  $('netSummary').innerHTML = `
    <div><span class="k">直近1分</span><b>${ns.lastMin}</b><span class="u">/ ${ns.perMin}回</span></div>
    <div><span class="k">今日</span><b>${D.budgetStatus().used}</b><span class="u">/ ${D.budgetStatus().cap}回（上限）</span></div>
    <div><span class="k">最終通信</span><b>${ns.lastAt ? M.fmtStamp(ns.lastAt, now) : '—'}</b></div>
    <div><span class="k">保存データ</span><b>${storageText}</b></div>
    <div><span class="k">状態</span><b>${ns.active ? '通信中' : ns.pausedUntil ? '一時停止中' : '待機中'}</b>${ns.queued ? `<span class="u">待ち${ns.queued}件</span>` : ''}</div>`;
  // これからの予定
  const lines = [];
  const cur = st.code;
  if (cur) {
    const m = marketOf(cur);
    const ph = M.marketPhase(now, m);
    const e = stages[front].entries?.[settings.leftTf] || stages[front].entries?.[settings.rightTf];
    const age = e?.fetchedAt ? Math.round((now - e.fetchedAt) / 1000) : null;
    if (!ph.open) lines.push(`表示中の ${esc(cur)}：${m === 'US' ? '米国' : '東証'}は${ph.label}です。引け後のデータを取得済みなら通信しません。`);
    else if (age != null) lines.push(`表示中の ${esc(cur)}：${age < 60 ? `${age}秒` : `${Math.floor(age / 60)}分`}前に取得。${age >= CACHE_MIN * 60 ? '次に表示するときに最新化します。' : `あと${Math.max(0, CACHE_MIN * 60 - age)}秒は通信しません。`}`);
    const next = neighbor(1);
    if (next && next !== cur) {
      const lead = Math.min(PREFETCH_SEC, settings.interval - 2);
      const wait = st.remaining - lead;
      lines.push(pauseReason(now) ? `次の ${esc(next)}：自動切替が止まっているため事前取得は待機中` : wait > 0 ? `次の ${esc(next)}：あと${wait}秒で事前取得（必要な場合のみ）` : `次の ${esc(next)}：事前取得済み、または取得不要`);
    }
  }
  const missing = list.filter((x) => x.enabled && !haveData.has(x.code)).length;
  lines.push(missing ? `データ未取得の銘柄：約${missing}件を8秒に1件ずつ取得中` : '全銘柄のデータを取得済み（裏での取得はありません）');
  $('netNow').innerHTML = lines.map((l) => `<div>・${l}</div>`).join('');
  const log = D.netLog();
  $('netLogBody').innerHTML = log.length ? log.slice(0, 40).map((x) => `
    <tr class="${x.ok ? '' : 'ng'}">
      <td class="num">${M.fmtClock(x.t)}</td>
      <td>${esc(x.code)}</td>
      <td>${esc(KIND_SHORT(x.what))}<div class="muted small">${esc(x.route)}</div></td>
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
$('btnClose').addEventListener('click', closeSettings);
$('btnSave').addEventListener('click', closeSettings);
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
document.addEventListener('pointerdown', keepAwake, { passive: true });
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
  if (now - BOOT_AT > 12 * 3600e3 && allClosed && !userIsTouching() && !netDlg.open && !dlg.open) location.reload();
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
    toast('読み込みました。「設定を保存して戻る」で反映されます');
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

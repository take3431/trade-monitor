import * as M from './market.js';
import * as D from './data.js';
import { Stage, themeColors, fmtPrice, fmtSigned, dirClass } from './chart.js';
import { lookupName, searchLocal } from './names.js';

const MAX_SYMBOLS = 120;
const KEY = { list: 'tm.list.v1', settings: 'tm.settings.v1', state: 'tm.state.v1' };
const TOUCH_HOLD_MS = 10000;   // 画面操作後、自動巡回を止めておく時間
const NAV_FETCH_DELAY = 350;   // 前/次の連打対策：表示が落ち着いてから通信する

const DEFAULTS = {
  interval: 30, offHours: 'continue',
  leftTf: '1d', rightTf: '1mo', leftBars: 126, rightBars: 120,
  ind: { ma: true, bb: false, vol: true },
  theme: 'dark', colorMode: 'jp', font: 'm', wakeLock: true,
  cacheMin: 2, prefetchSec: 15,
  proxy: D.BUILTIN_PROXIES[0], fallback: true, demo: false,
};
const DEFAULT_LIST = [
  ['7203', 'トヨタ自動車', true], ['9984', 'ソフトバンクグループ', true], ['6758', 'ソニーグループ', true],
  ['8306', '三菱UFJフィナンシャル・グループ', true], ['6861', 'キーエンス', true], ['8035', '東京エレクトロン', true],
  ['9983', 'ファーストリテイリング', false], ['7974', '任天堂', false],
].map(([code, name, enabled]) => ({ code, name, market: '東証プライム', enabled }));

const $ = (id) => document.getElementById(id);
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const frames = (n = 2) => new Promise((r) => { const f = () => (--n <= 0 ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 状態 ---------------- */
const storedSettings = load(KEY.settings, {});
const settings = { ...DEFAULTS, ...storedSettings, ind: { ...DEFAULTS.ind, ...(storedSettings.ind || {}) } };
let list = load(KEY.list, null) || DEFAULT_LIST;
const saved = load(KEY.state, {});
const st = {
  code: saved.code || null, paused: !!saved.paused, remaining: settings.interval,
  touchUntil: 0, settingsOpen: false, lastError: null, seq: 0, prefetching: null,
};
const stages = [new Stage($('stageA')), new Stage($('stageB'))];
let front = 0;

const persistState = () => save(KEY.state, { code: st.code, paused: st.paused });
const saveList = () => save(KEY.list, list);
const neededTfs = () => [...new Set(['1d', settings.leftTf, settings.rightTf])];
const ttlMs = () => settings.cacheMin * 60e3;

/* ---------------- 設定の反映 ---------------- */
function applyLook() {
  const r = document.documentElement;
  r.dataset.theme = settings.theme;
  r.dataset.font = settings.font;
  r.dataset.color = settings.colorMode;
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'dark' ? '#0d1117' : '#f4f6f9';
  $('demoBadge').hidden = !settings.demo;
}
function applyData() {
  D.configure({ proxy: settings.proxy, fallback: settings.fallback, demo: settings.demo, ttlMs: ttlMs() });
}
function rebuildCharts() {
  const c = themeColors();
  stages.forEach((s) => s.build(settings.ind, c));
}

/* ---------------- 巡回 ---------------- */
function neighbor(delta) {
  const n = list.length;
  if (!n) return null;
  let i = list.findIndex((x) => x.code === st.code);
  if (i < 0) i = delta > 0 ? -1 : 0;
  for (let k = 1; k <= n; k++) {
    const j = (((i + delta * k) % n) + n) % n;
    if (list[j].enabled) return list[j].code;
  }
  return null;
}
function enabledCount() { return list.filter((x) => x.enabled).length; }
function posText(code) {
  const en = list.filter((x) => x.enabled);
  const i = en.findIndex((x) => x.code === code);
  return i >= 0 ? `${i + 1} / ${en.length}` : '巡回対象外';
}

function showEmpty(empty) {
  $('emptyMsg').hidden = !empty;
  $('monitor').classList.toggle('is-empty', empty);
}

// 銘柄を表示。キャッシュがあれば非表示レイヤーに描画→即切替、その後必要なら最新データ取得。
async function show(code, { nav = false, force = false } = {}) {
  const item = list.find((x) => x.code === code);
  if (!item) { showEmpty(true); return; }
  showEmpty(false);
  const seq = ++st.seq;
  st.code = code;
  persistState();
  const tfs = neededTfs();
  const cur = stages[front];
  const isSame = cur.code === code;

  const cached = await D.cachedSet(code, tfs);
  if (seq !== st.seq) return;
  const hasCache = tfs.some((tf) => cached[tf]);
  if (hasCache && !isSame) await present(item, cached, seq, false);

  if (nav) { await new Promise((r) => setTimeout(r, NAV_FETCH_DELAY)); if (seq !== st.seq) return; }

  setLoading(true);
  const res = await D.loadSet(code, tfs, { force });
  setLoading(false);
  if (seq !== st.seq) return;
  st.lastError = res.error;
  if (res.fetched || !hasCache || isSame) {
    const onFront = stages[front].code === code;
    if (onFront) render(stages[front], item, res.entries, true);
    else await present(item, res.entries, seq, false);
  }
  updateStatus();
}

function render(stage, item, entries, keepRange) {
  stage.render(item, entries, D.quoteFrom(entries['1d']) || D.getQuote(item.code), settings, { pos: posText(item.code), keepRange });
}

async function present(item, entries, seq) {
  const back = stages[1 - front];
  render(back, item, entries, false);
  await frames(2); // 非表示レイヤーで描画完了を待ってから切替
  if (seq !== st.seq) return;
  back.root.classList.add('active');
  stages[front].root.classList.remove('active');
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
    const r = await D.loadSet(code, neededTfs());
    if (r.error) st.lastError = r.error;
  } finally {
    st.prefetching = null;
  }
}

function pauseReason(now) {
  if (st.settingsOpen) return '設定中';
  if (st.paused) return '一時停止中';
  if (now < st.touchUntil) return '操作中のため一時停止';
  if (!M.marketPhase(now).open && settings.offHours === 'stop') return '市場時間外のため停止';
  if (document.hidden) return '待機中';
  return null;
}

function tick() {
  const now = Date.now();
  updateStatus(now);
  if (!pauseReason(now) && enabledCount() > 0) {
    st.remaining--;
    const lead = Math.min(settings.prefetchSec, settings.interval - 2);
    if (st.remaining === lead) prefetch(neighbor(1));
    if (st.remaining <= 0) go(1, false);
  }
  renderCountdown(now);
}

/* ---------------- ステータス表示 ---------------- */
let loading = false;
function setLoading(v) { loading = v; updateStatus(); }

function updateStatus(now = Date.now()) {
  const ph = M.marketPhase(now);
  const dot = $('statusDot');
  const err = st.lastError;
  dot.className = `dot ${err ? 'err' : ph.open ? 'ok' : 'closed'}${loading ? ' busy' : ''}`;
  $('statusText').textContent = `東証・${ph.open ? `接続中（${ph.label}）` : ph.label}`;
  const e = stages[front].entries?.['1d'] || stages[front].entries?.[settings.leftTf];
  $('updatedAt').textContent = e?.fetchedAt ? `${M.fmtStamp(e.fetchedAt, now)} 更新` : '';
  const errEl = $('errText');
  errEl.hidden = !err;
  if (err) { errEl.textContent = e ? '通信エラー：前回データを表示中' : '通信エラー：データ未取得（再試行します）'; errEl.title = String(err.message || err); }
}

function renderCountdown(now = Date.now()) {
  const r = pauseReason(now);
  const el = $('countdown');
  el.classList.toggle('paused', !!r);
  el.textContent = r ? `自動更新: ${settings.interval}s（${r}）` : `自動更新: ${settings.interval}s (残り ${Math.max(0, st.remaining)}秒)`;
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
  renderCountdown();
}

function closeSettings() {
  const prev = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, t: settings.theme, c: settings.colorMode, d: settings.demo, f: settings.font });
  readSettings();
  save(KEY.settings, settings);
  saveList();
  listRefresh.cancel = true;
  applyLook();
  applyData();
  const next = JSON.stringify({ tf: [settings.leftTf, settings.rightTf, settings.leftBars, settings.rightBars], ind: settings.ind, t: settings.theme, c: settings.colorMode, d: settings.demo, f: settings.font });
  st.settingsOpen = false;
  document.body.classList.remove('in-settings');
  $('settings').hidden = true;
  st.remaining = settings.interval;
  if (prev !== next) rebuildCharts();
  const cur = list.find((x) => x.code === st.code);
  const code = cur ? cur.code : neighbor(1);
  if (code) { stages[front].code = prev !== next ? null : stages[front].code; show(code); } else showEmpty(true);
  if (settings.wakeLock) keepAwake(); else if (wake) wake.release();
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
  const isPreset = [30, 60, 90].includes(s.interval);
  seg('segInterval', isPreset ? s.interval : 'custom', (v) => {
    if (v === 'custom') { $('inpInterval').focus(); return; }
    $('inpInterval').value = v;
  });
  $('inpInterval').value = s.interval;
  $('inpInterval').oninput = () => {
    const v = $('inpInterval').value;
    $('segInterval').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === (['30', '60', '90'].includes(v) ? v : 'custom')));
  };
  $('selOffHours').value = s.offHours;
  tfButtons('segLeftTf'); tfButtons('segRightTf');
  seg('segLeftTf', s.leftTf, (v) => { $('segLeftTf').dataset.v = v; periodOptions('selLeftBars', v, D.TF[v].def); });
  seg('segRightTf', s.rightTf, (v) => { $('segRightTf').dataset.v = v; periodOptions('selRightBars', v, D.TF[v].def); });
  $('segLeftTf').dataset.v = s.leftTf; $('segRightTf').dataset.v = s.rightTf;
  periodOptions('selLeftBars', s.leftTf, s.leftBars);
  periodOptions('selRightBars', s.rightTf, s.rightBars);
  $('chkMa').checked = s.ind.ma; $('chkBb').checked = s.ind.bb; $('chkVol').checked = s.ind.vol;
  $('chkDark').checked = s.theme === 'dark';
  $('chkDark').onchange = () => { document.documentElement.dataset.theme = $('chkDark').checked ? 'dark' : 'light'; };
  seg('segColor', s.colorMode, (v) => { $('segColor').dataset.v = v; document.documentElement.dataset.color = v; });
  $('segColor').dataset.v = s.colorMode;
  seg('segFont', s.font, (v) => { $('segFont').dataset.v = v; document.documentElement.dataset.font = v; });
  $('segFont').dataset.v = s.font;
  $('chkWake').checked = s.wakeLock;
  seg('segCache', s.cacheMin, (v) => { $('segCache').dataset.v = v; });
  $('segCache').dataset.v = s.cacheMin;
  $('inpPrefetch').value = s.prefetchSec;
  $('inpProxy').value = s.proxy;
  $('chkFallback').checked = s.fallback;
  $('chkDemo').checked = s.demo;
}

function readSettings() {
  const s = settings;
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  s.interval = clamp($('inpInterval').value, 10, 300, 30);
  s.offHours = $('selOffHours').value;
  s.leftTf = $('segLeftTf').dataset.v; s.rightTf = $('segRightTf').dataset.v;
  s.leftBars = Number($('selLeftBars').value); s.rightBars = Number($('selRightBars').value);
  s.ind = { ma: $('chkMa').checked, bb: $('chkBb').checked, vol: $('chkVol').checked };
  s.theme = $('chkDark').checked ? 'dark' : 'light';
  s.colorMode = $('segColor').dataset.v; s.font = $('segFont').dataset.v;
  s.wakeLock = $('chkWake').checked;
  s.cacheMin = clamp($('segCache').dataset.v, 1, 3, 2);
  s.prefetchSec = clamp($('inpPrefetch').value, 5, 60, 15);
  s.proxy = $('inpProxy').value.trim();
  s.fallback = $('chkFallback').checked;
  s.demo = $('chkDemo').checked;
}

/* ---------------- 銘柄一覧 ---------------- */
function quoteCells(code) {
  const q = D.getQuote(code);
  const d = dirClass(q?.chg);
  return `<td class="r num c-price">${fmtPrice(q?.price)}</td>
    <td class="r num ${d}">${q ? fmtSigned(q.chg) : '—'}</td>
    <td class="r num ${d}">${q ? `${fmtSigned(q.pct, 2)}%` : '—'}</td>`;
}

function renderList() {
  $('listCount').textContent = `(${list.length}/${MAX_SYMBOLS})`;
  $('listBody').innerHTML = list.map((x, i) => `
    <tr data-code="${esc(x.code)}">
      <td class="c-no"><span class="grip" title="ドラッグで並び替え"><svg class="ico"><use href="#i-grip"/></svg></span><span class="no">${String(i + 1).padStart(2, '0')}</span></td>
      <td class="c-code num">${esc(x.code)}</td>
      <td class="c-name"><button class="link rename">${esc(x.name || D.getQuote(x.code)?.name || '（名称未設定）')}</button></td>
      ${quoteCells(x.code)}
      <td class="c-sw"><label class="switch"><input type="checkbox" class="toggle" ${x.enabled ? 'checked' : ''}><i></i></label></td>
      <td class="c-del"><button class="icon-btn danger del" aria-label="削除"><svg class="ico"><use href="#i-trash"/></svg></button></td>
    </tr>`).join('');
  $('btnAdd').disabled = list.length >= MAX_SYMBOLS;
}

function updateRowQuote(code) {
  const tr = $('listBody').querySelector(`tr[data-code="${CSS.escape(code)}"]`);
  if (!tr) return;
  const tds = tr.querySelectorAll('td');
  const tmp = document.createElement('tbody');
  tmp.innerHTML = `<tr>${quoteCells(code)}</tr>`;
  const n = tmp.querySelectorAll('td');
  [3, 4, 5].forEach((idx, k) => tds[idx].replaceWith(n[k]));
}

function renumber() {
  $('listBody').querySelectorAll('tr').forEach((tr, i) => { tr.querySelector('.no').textContent = String(i + 1).padStart(2, '0'); });
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
    if (!confirm(`${code} ${item.name} を一覧から削除しますか？`)) return;
    list = list.filter((x) => x.code !== code);
    saveList();
    renderList();
  } else if (e.target.closest('.rename')) {
    const name = prompt(`${code} の表示名`, item.name || '');
    if (name == null) return;
    item.name = name.trim();
    saveList();
    renderList();
  }
});

// ドラッグ＆ドロップ並び替え（タッチ対応のため Pointer Events で実装）
(function setupDrag() {
  const body = $('listBody');
  const wrap = $('tableWrap');
  let drag = null;
  let scrollTimer = null;
  body.addEventListener('pointerdown', (e) => {
    const g = e.target.closest('.grip');
    if (!g) return;
    e.preventDefault();
    const tr = g.closest('tr');
    drag = { tr, id: e.pointerId, y: e.clientY };
    tr.classList.add('dragging');
    g.setPointerCapture(e.pointerId);
    scrollTimer = setInterval(() => {
      if (!drag) return;
      const r = wrap.getBoundingClientRect();
      if (drag.y < r.top + 50) wrap.scrollTop -= 12;
      else if (drag.y > r.bottom - 40) wrap.scrollTop += 12;
      moveTo(drag.y);
    }, 30);
  });
  function moveTo(y) {
    const rows = [...body.querySelectorAll('tr')];
    for (const row of rows) {
      if (row === drag.tr) continue;
      const r = row.getBoundingClientRect();
      if (y > r.top && y < r.bottom) {
        if (y < r.top + r.height / 2) row.before(drag.tr); else row.after(drag.tr);
        renumber();
        break;
      }
    }
  }
  body.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.y = e.clientY;
    moveTo(e.clientY);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.tr.classList.remove('dragging');
    clearInterval(scrollTimer);
    drag = null;
    const order = [...body.querySelectorAll('tr')].map((r) => r.dataset.code);
    list.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    saveList();
  };
  body.addEventListener('pointerup', end);
  body.addEventListener('pointercancel', end);
})();

// 一覧の株価更新（APIに負荷をかけないよう1件ずつ間隔をあけ、キャッシュ有効な銘柄は通信しない）
const listRefresh = { running: false, cancel: false };
$('btnRefreshList').addEventListener('click', async () => {
  if (listRefresh.running) { listRefresh.cancel = true; return; }
  listRefresh.running = true;
  listRefresh.cancel = false;
  const btn = $('btnRefreshList').querySelector('span');
  const codes = list.map((x) => x.code);
  let errors = 0;
  for (let i = 0; i < codes.length && !listRefresh.cancel; i++) {
    btn.textContent = `更新中 ${i + 1}/${codes.length}（停止）`;
    const r = await D.loadSet(codes[i], ['1d']);
    if (r.error) errors++;
    updateRowQuote(codes[i]);
    if (r.fetched) await new Promise((res) => setTimeout(res, 700));
  }
  btn.textContent = '株価更新';
  listRefresh.running = false;
  if (errors) toast(`${errors}件の取得に失敗しました（前回値を表示）`);
});

/* ---------------- 新規登録ダイアログ ---------------- */
const dlg = $('addDialog');
const CODE_RE = /^[0-9][0-9A-Z]{3}$/;

$('btnAdd').addEventListener('click', () => {
  $('addQuery').value = ''; $('addCode').value = ''; $('addName').value = '';
  $('addMarket').value = '東証プライム';
  $('addResults').innerHTML = ''; $('addMsg').textContent = '';
  dlg.showModal();
  setTimeout(() => $('addQuery').focus(), 50);
});
$('btnAddCancel').addEventListener('click', () => dlg.close());

function pickResult(r) {
  $('addCode').value = r.code;
  $('addName').value = lookupName(r.code) || r.name;
  $('addResults').innerHTML = '';
  $('addMsg').textContent = '';
}

async function doSearch() {
  const q = $('addQuery').value.trim().normalize('NFKC').toUpperCase();
  const msg = $('addMsg');
  const ul = $('addResults');
  ul.innerHTML = '';
  if (!q) return;
  if (CODE_RE.test(q)) {
    $('addCode').value = q;
    $('addName').value = lookupName(q);
    msg.textContent = '銘柄情報を確認中…';
    const r = await D.loadSet(q, ['1d']);
    const qt = D.quoteFrom(r.entries['1d']);
    if (qt) {
      if (!$('addName').value) $('addName').value = qt.name;
      msg.textContent = `確認OK：現在値 ${fmtPrice(qt.price)}円`;
    } else {
      msg.textContent = r.error ? `確認できませんでした（${r.error.message}）。このまま登録もできます。` : '該当データがありません';
    }
    return;
  }
  let results = searchLocal($('addQuery').value.trim());
  msg.textContent = '検索中…';
  try {
    const remote = await D.searchRemote($('addQuery').value.trim());
    for (const r of remote) if (!results.some((x) => x.code === r.code)) results.push(r);
  } catch { /* 辞書の結果のみ */ }
  results = results.slice(0, 12);
  msg.textContent = results.length ? '候補をタップしてください' : '見つかりませんでした。銘柄コード（4桁）で入力してください。';
  ul.innerHTML = results.map((r, i) => `<li><button type="button" data-i="${i}"><span class="num">${esc(r.code)}</span> ${esc(lookupName(r.code) || r.name)} <small class="muted">${r.source}</small></button></li>`).join('');
  ul.querySelectorAll('button').forEach((b) => { b.onclick = () => pickResult(results[Number(b.dataset.i)]); });
}
$('btnSearch').addEventListener('click', doSearch);
$('addQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('addCode').value.trim().normalize('NFKC').toUpperCase();
  const msg = $('addMsg');
  if (!CODE_RE.test(code)) { msg.textContent = '銘柄コードは4桁で入力してください（例: 7203, 130A）'; return; }
  if (list.some((x) => x.code === code)) { msg.textContent = 'すでに登録されています'; return; }
  if (list.length >= MAX_SYMBOLS) { msg.textContent = `登録できるのは最大${MAX_SYMBOLS}銘柄です`; return; }
  list.push({ code, name: $('addName').value.trim() || lookupName(code) || D.getQuote(code)?.name || '', market: $('addMarket').value, enabled: true });
  saveList();
  renderList();
  dlg.close();
  $('tableWrap').scrollTop = $('tableWrap').scrollHeight;
  toast(`${code} を登録しました`);
});

/* ---------------- イベント ---------------- */
$('btnMenu').addEventListener('click', openSettings);
$('btnClose').addEventListener('click', closeSettings);
$('btnSave').addEventListener('click', closeSettings);
$('btnPause').addEventListener('click', () => { st.paused = !st.paused; persistState(); renderCountdown(); });
$('btnPrev').addEventListener('click', () => go(-1));
$('btnNext').addEventListener('click', () => go(1));
$('btnClearCache').addEventListener('click', async () => {
  if (!confirm('保存済みの株価・チャートデータを消去しますか？\n（銘柄リストと設定は残ります）')) return;
  await D.clearCache();
  renderList();
  toast('キャッシュを消去しました');
});

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

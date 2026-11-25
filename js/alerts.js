// アラート：通知カードと通知音
//  ・通知カードは × を押すか、横にスライドするまで消えない（ページを読み込み直しても残す）
//  ・カードの × とスライド以外の操作には反応しない（下にある画面にも操作を通さない）
//  ・通知音は Web Audio で作る（音声ファイルの読み込み・通信なし）

const CARDS_KEY = 'tm.alertcards.v1';
const MAX_CARDS = 20;
let stack = null;
let cards = [];
try { cards = JSON.parse(localStorage.getItem(CARDS_KEY)) || []; } catch { cards = []; }
const saveCards = () => { try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); } catch { /* ignore */ } };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');

// 価格の入力を数値にする。全角・半角の混在、桁区切りのカンマ、円・$ などの記号を許す
//  空欄 → null ／ 数字として読めない → NaN
export function parsePrice(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/[\s,、円$¥￥]/g, '').replace(/。/g, '.');
  if (!t) return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const v = Number(t);
  return v > 0 ? v : NaN;
}

// 価格の表示（半角・桁区切り）。米国株は小数2桁、日本株は小数があれば1桁まで
export function fmtNum(v, us = false) {
  if (v == null || !Number.isFinite(v)) return '';
  return us
    ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : v.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

// 前回の現在値 prev から今回 now に変わる間に、設定株価 target をまたいだか
//  'up'：下から上へ（上抜け） ／ 'down'：上から下へ（下抜け） ／ null：またいでいない
export function crossed(prev, now, target) {
  if (prev == null || now == null || target == null) return null;
  if (prev < target && now >= target) return 'up';
  if (prev > target && now <= target) return 'down';
  return null;
}

/* ---------------- 通知音 ---------------- */
let actx = null;
// 画面に触れたときに呼ぶ（ブラウザは、利用者の操作の後でないと音を鳴らせない）
export function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
  } catch { /* 音が使えない端末 */ }
}
// 「ピンポーン」を繰り返し鳴らす。sec 秒たつか、stopAlarm() で止まる
//  音量を上げても割れないよう、最後に音量の山をならす処理（コンプレッサー）を通す
let alarmTimer = null, alarmUntil = 0, alarmOut = null;
function chimeOnce(at) {
  const notes = [[1318.5, 0], [987.8, 0.32]];
  for (const [f, dt] of notes) {
    for (const [type, mul, vol] of [['triangle', 1, 0.9], ['sine', 2, 0.25], ['sine', 3, 0.1]]) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = f * mul;
      const t = at + dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      o.connect(g).connect(alarmOut);
      o.start(t);
      o.stop(t + 1.05);
    }
  }
}
export function playAlarm(sec = 30) {
  unlockAudio();
  if (!actx) return;
  stopAlarm();
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 6;
  const out = actx.createGain();
  out.gain.value = 1.6;
  comp.connect(out).connect(actx.destination);
  alarmOut = comp;
  alarmUntil = Date.now() + sec * 1000;
  const period = 1.6; // 秒
  let next = actx.currentTime + 0.05;
  const pump = () => {
    if (Date.now() >= alarmUntil) { stopAlarm(); return; }
    // 少し先の分まで予約しておく（画面の処理が重くても途切れないように）
    while (next < actx.currentTime + 1) { chimeOnce(next); next += period; }
  };
  pump();
  alarmTimer = setInterval(pump, 250);
}
export function stopAlarm() {
  clearInterval(alarmTimer);
  alarmTimer = null;
  if (alarmOut) {
    const node = alarmOut;
    alarmOut = null;
    try { node.disconnect(); } catch { /* ignore */ }
  }
}
export const alarmPlaying = () => !!alarmTimer;

/* ---------------- 通知カード ---------------- */
// a = { code, name, target, price, dir: 'up'|'down', at, us }
export function showAlertCard(a) {
  const card = { id: `${a.at}-${a.code}-${Math.random().toString(36).slice(2, 6)}`, ...a };
  cards.push(card);
  while (cards.length > MAX_CARDS) {
    const old = cards.shift();
    stack?.querySelector(`[data-id="${old.id}"]`)?.remove();
  }
  saveCards();
  mount(card);
}

function dismiss(id, el, dir = 1) {
  stopAlarm(); // 通知を消したら音も止める
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  el.classList.remove('dragging', 'settling');
  el.classList.add('leaving');
  el.style.transform = `translateX(${dir * 110}%)`;
  setTimeout(() => el.remove(), 220);
}

function mount(c) {
  const d = new Date(c.at + 9 * 3600e3); // 日本時間で表示
  const when = `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const up = c.dir === 'up';
  const el = document.createElement('div');
  el.className = `alert-card ${up ? 'dir-up' : 'dir-down'}`;
  el.dataset.id = c.id;
  el.setAttribute('role', 'alert');
  const money = (v) => (c.us ? `${fmtNum(v, true)}ドル` : `${fmtNum(v)}円`);
  el.innerHTML = `
    <svg class="ico a-ico"><use href="#i-bell"/></svg>
    <div class="a-body">
      <div class="a-title">${esc(c.code)} ${esc(c.name || '')}${c.test ? '<span class="a-test">テスト</span>' : ''}</div>
      <div class="a-msg"><b class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} 設定株価 ${money(c.target)} を${up ? '上回りました' : '下回りました'}</b></div>
      <div class="a-time">現在値 ${money(c.price)}　${when}</div>
    </div>
    <button type="button" class="a-close" aria-label="この通知を消す"><svg class="ico"><use href="#i-close"/></svg></button>`;
  el.querySelector('.a-close').addEventListener('click', (e) => { e.stopPropagation(); dismiss(c.id, el, 1); });

  // 横スライドで消す。× 以外を押しただけでは何も起きない
  let sx = 0, sy = 0, dx = 0, t0 = 0, pid = null;
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (e.target.closest('.a-close')) return;
    e.preventDefault();
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; t0 = Date.now();
    el.setPointerCapture?.(pid);
    el.classList.add('dragging');
    el.classList.remove('settling');
  });
  el.addEventListener('pointermove', (e) => {
    e.stopPropagation();
    if (pid !== e.pointerId) return;
    dx = e.clientX - sx;
    if (Math.abs(e.clientY - sy) > Math.abs(dx) * 2 && Math.abs(dx) < 10) return;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / (el.offsetWidth * 1.2)));
  });
  const end = (e) => {
    e.stopPropagation();
    if (pid !== e.pointerId) return;
    pid = null;
    const fast = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.6;
    if (Math.abs(dx) > el.offsetWidth * 0.35 || fast) { dismiss(c.id, el, dx < 0 ? -1 : 1); return; }
    el.classList.remove('dragging');
    el.classList.add('settling');
    el.style.transform = '';
    el.style.opacity = '';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // カードの上での操作は、下の画面や他の処理に伝えない
  for (const ev of ['click', 'pointerover', 'touchstart', 'touchmove', 'wheel', 'contextmenu']) {
    el.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'contextmenu') e.preventDefault(); }, { passive: ev === 'contextmenu' ? false : true });
  }
  stack.appendChild(el);
}

export function initAlertCards(container) {
  stack = container;
  for (const c of cards) mount(c);
}

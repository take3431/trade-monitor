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
// 「ピンポン」を2回。澄んだ音（サイン波）に少しだけ倍音を重ねて、ベルのように聞こえるようにする
export function playChime() {
  unlockAudio();
  if (!actx) return;
  const t0 = actx.currentTime + 0.05;
  const master = actx.createGain();
  master.gain.value = 0.5;
  master.connect(actx.destination);
  const notes = [[1046.5, 0], [784, 0.28], [1046.5, 0.9], [784, 1.18]];
  for (const [f, dt] of notes) {
    for (const [mul, vol] of [[1, 0.6], [2.01, 0.12], [3.02, 0.05]]) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = 'sine';
      o.frequency.value = f * mul;
      const t = t0 + dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.95);
    }
  }
}

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
  cards = cards.filter((c) => c.id !== id);
  saveCards();
  el.classList.remove('dragging', 'settling');
  el.classList.add('leaving');
  el.style.transform = `translateX(${dir * 110}%)`;
  setTimeout(() => el.remove(), 220);
}

function mount(c) {
  const d = new Date(c.at);
  const when = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const el = document.createElement('div');
  el.className = `alert-card ${c.dir === 'up' ? 'dir-up' : 'dir-down'}`;
  el.dataset.id = c.id;
  el.setAttribute('role', 'alert');
  const unit = c.us ? '' : '円';
  const money = (v) => (c.us ? 'US$' : '') + fmtNum(v, c.us) + unit;
  el.innerHTML = `
    <svg class="ico a-ico"><use href="#i-bell"/></svg>
    <div class="a-body">
      <div class="a-title">${esc(c.code)} ${esc(c.name || '')}</div>
      <div class="a-msg"><b class="${c.dir === 'up' ? 'up' : 'down'}">${c.dir === 'up' ? '▲' : '▼'} ${money(c.target)}</b> を${c.dir === 'up' ? '上抜け' : '下抜け'}ました<span class="a-now">現在 ${money(c.price)}</span></div>
      <div class="a-time">${when}</div>
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

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
// 1未満の小さい値（暗号資産など）は有効数字4桁ほどまで出す（0.0577、0.000003650 など。2桁に丸めると 0.00 になるため）
export function smallDigits(v) {
  const a = Math.abs(v);
  return a > 0 && a < 1 ? Math.min(10, Math.max(2, Math.ceil(-Math.log10(a)) + 3)) : 2;
}
// ref：桁数を決める基準の値（前日比など「差」を出すときは株価を渡す。0.31 を 0.3100 にしないため）
export function fmtNum(v, us = false, ref = v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (ref !== 0 && Math.abs(ref) < 1) { const d = smallDigits(ref); return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
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
/* 音色（すべてアプリ内で作る。音声ファイルは読み込まない）
   ・alert：株価アラート。「ピンポーン」を1.6秒ごと（はっきり気づける音）
   ・jp：日本市場の開始。木琴（マリンバ）のような柔らかい「ポロロン」と上がる3音（ソ・レ・ソ）。2.4秒ごと
   ・us：米国市場の開始。ホテルのロビーのチャイムのような、余韻のある「キン・コン・カン」と下がる3音（ミ・ド#・ラ）。3.2秒ごと
   市場の開始の音は、耳に刺さらないよう音量を控えめにし、角の取れた立ち上がりと自然な減衰にしている。 */
const SOUNDS = {
  alert: { period: 1.6, gain: 1.6, notes: [[1318.5, 0], [987.8, 0.32]], decay: 1.0, attack: 0.01,
    partials: [['triangle', 1, 0.9], ['sine', 2, 0.25], ['sine', 3, 0.1]] },
  // マリンバ風：基音＋4倍音（木の鍵盤らしい響き）を少しだけ。短めの余韻
  jp: { period: 2.4, gain: 0.9, notes: [[392.0, 0], [587.3, 0.16], [784.0, 0.32]], decay: 1.1, attack: 0.006,
    partials: [['sine', 1, 0.75], ['sine', 4, 0.12], ['sine', 2, 0.08]] },
  // チャイム風：三角波＋鐘らしい少しずれた倍音（2.76倍）。長めの余韻
  us: { period: 3.2, gain: 0.8, notes: [[659.3, 0], [554.4, 0.45], [440.0, 0.9]], decay: 1.9, attack: 0.012,
    partials: [['triangle', 1, 0.7], ['sine', 2.76, 0.1], ['sine', 2, 0.12]] },
  // 日本市場の終了：「おつかれさま」のように、ふわっと下がる3音（ソ・ミ・ド）。ゆっくり立ち上がり、長く消えていく
  jpClose: { period: 2.5, gain: 0.7, notes: [[784.0, 0], [659.3, 0.34], [523.3, 0.68]], decay: 1.8, attack: 0.05,
    partials: [['sine', 1, 0.6], ['sine', 1.003, 0.18], ['sine', 2, 0.04]] },
  // 米国市場の終了：シンギングボウル（おりん）のような、低く柔らかな2音（レ・ラ）。わずかにずらした音を重ねて、ゆらぎのある響きに
  usClose: { period: 2.5, gain: 0.75, notes: [[293.7, 0], [440.0, 0.5]], decay: 2.3, attack: 0.12,
    partials: [['sine', 1, 0.55], ['sine', 1.004, 0.25], ['sine', 2.71, 0.06], ['sine', 5.4, 0.015]] },
};
// 市場の開始・終了の音は「鳴らす時間 ÷ 2.5秒」回（切り捨て、最低1回）鳴らす：3秒→1回、5秒→2回、10秒→4回、15秒→6回、30秒→12回
const BELL_SPACING = 2.5;
export const bellCount = (sec) => Math.max(1, Math.floor(sec / BELL_SPACING));
let alarmTimer = null, alarmUntil = 0, alarmOut = null, alarmKindNow = null;
function chimeOnce(at, snd) {
  for (const [f, dt] of snd.notes) {
    for (const [type, mul, vol] of snd.partials) {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = f * mul;
      const t = at + dt;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + snd.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + snd.decay);
      o.connect(g).connect(alarmOut);
      o.start(t);
      o.stop(t + snd.decay + 0.05);
    }
  }
}
// kind：'alert'（株価アラート：sec 秒のあいだ繰り返す） ／ 'jp'・'us'・'jpClose'・'usClose'（市場の開始・終了：bellCount(sec) 回）
// stopAlarm() で止まる。
//  音量を上げても割れないよう、最後に音量の山をならす処理（コンプレッサー）を通す
export function playAlarm(sec = 10, kind = 'alert') {
  unlockAudio();
  if (!actx) return;
  stopAlarm();
  const snd = SOUNDS[kind] || SOUNDS.alert;
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 6;
  const out = actx.createGain();
  out.gain.value = snd.gain;
  comp.connect(out).connect(actx.destination);
  alarmOut = comp;
  alarmKindNow = kind;
  if (kind !== 'alert' && SOUNDS[kind]) {
    // 決まった回数だけ、2.5秒おきに予約して鳴らし、最後の音が自然に消えたら終わる
    const n = bellCount(sec);
    const t0 = actx.currentTime + 0.05;
    for (let i = 0; i < n; i++) chimeOnce(t0 + i * BELL_SPACING, snd);
    const total = ((n - 1) * BELL_SPACING + snd.notes[snd.notes.length - 1][1] + snd.decay + 0.3) * 1000;
    alarmUntil = Date.now() + total;
    alarmTimer = setTimeout(() => finishAlarm(0.2), total);
    return;
  }
  alarmUntil = Date.now() + sec * 1000;
  let next = actx.currentTime + 0.05;
  const pump = () => {
    // 時間になったら新しい音は出さず、鳴っている音は自然に消えるのを待つ（ぶつ切りにしない）
    if (Date.now() >= alarmUntil) { finishAlarm(snd.decay + 1); return; }
    // 少し先の分まで予約しておく（画面の処理が重くても途切れないように）
    while (next < actx.currentTime + 1 && next < actx.currentTime + (alarmUntil - Date.now()) / 1000) { chimeOnce(next, snd); next += snd.period; }
  };
  pump();
  alarmTimer = setInterval(pump, 250);
}
function finishAlarm(tailSec) {
  clearInterval(alarmTimer);
  clearTimeout(alarmTimer);
  alarmTimer = null;
  alarmKindNow = null;
  const node = alarmOut;
  alarmOut = null;
  if (node) setTimeout(() => { try { node.disconnect(); } catch { /* ignore */ } }, tailSec * 1000);
}
export function stopAlarm() {
  clearInterval(alarmTimer);
  clearTimeout(alarmTimer);
  alarmTimer = null;
  alarmKindNow = null;
  if (alarmOut) {
    const node = alarmOut;
    alarmOut = null;
    try { node.disconnect(); } catch { /* ignore */ }
  }
}
export const alarmPlaying = () => !!alarmTimer;
export const alarmKind = () => alarmKindNow;

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
  const money = (v) => (c.idx ? fmtNum(v, true) : c.us ? `${fmtNum(v, true)}ドル` : `${fmtNum(v)}円`);
  el.innerHTML = `
    <svg class="ico a-ico"><use href="#i-bell"/></svg>
    <div class="a-body">
      <div class="a-title">${esc(c.code)} ${esc(c.name || '')}</div>
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

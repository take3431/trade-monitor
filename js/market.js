// 東証の取引時間判定（端末のタイムゾーンに依存せず JST で計算）
const H = 3600e3;
const MIN = 60e3;

// 休場日は js/holidays.js（tools/gen-holidays.py で生成、2040年まで）
import { JP_HOLIDAYS as HOLIDAYS, US_HOLIDAYS, US_EARLY_CLOSE } from './holidays.js?v=20261125113521';

// 前場 9:00-11:30 / 後場 12:30-15:30（分単位）
const AM = [540, 690];
const PM = [750, 930];

// Yahoo Finance の東証データは約20分遅延。引け後この時間が経過したら「確定」とみなす。
export const SETTLE_MS = 25 * MIN;

const pad = (n) => String(n).padStart(2, '0');

export function jst(t = Date.now()) {
  const d = new Date(t + 9 * H);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    dow: d.getUTCDay(), hh: d.getUTCHours(), mi: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    min: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

export function dayKey(t) {
  const p = jst(t);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function isTradingDay(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if ((m === 1 && d <= 3) || (m === 12 && d === 31)) return false;
  return !HOLIDAYS.has(`${y}-${pad(m)}-${pad(d)}`);
}

export function marketPhase(now = Date.now(), market = 'JP') {
  if (market === 'US') return usPhase(now);
  const p = jst(now);
  if (!isTradingDay(p.y, p.m, p.d)) return { open: false, code: 'holiday', label: '休場日' };
  if (p.min < AM[0]) return { open: false, code: 'pre', label: '取引開始前' };
  if (p.min < AM[1]) return { open: true, code: 'am', label: '前場' };
  if (p.min < PM[0]) return { open: false, code: 'lunch', label: '昼休み' };
  if (p.min < PM[1]) return { open: true, code: 'pm', label: '後場' };
  return { open: false, code: 'closed', label: '閉場中' };
}

// now 以前で直近の「場の終了時刻」（11:30 / 15:30）
export function lastSessionEnd(now = Date.now()) {
  const p = jst(now);
  const midnight = Date.UTC(p.y, p.m - 1, p.d) - 9 * H;
  for (let i = 0; i < 20; i++) {
    const base = midnight - i * 24 * H;
    const q = jst(base);
    if (!isTradingDay(q.y, q.m, q.d)) continue;
    for (const end of [PM[1], AM[1]]) {
      const e = base + end * MIN;
      if (e <= now) return e;
    }
  }
  return 0;
}

// キャッシュが有効か判定。
// 取引時間中: 取得から ttlMs 以内なら有効。
// 時間外: 直近の引け（＋遅延分）以降に取得済みなら価格は変わらないので有効（再取得しない）。
// 東証のデータは約20分遅れで届くので、「データが動いている時間」は実際の取引時間より20分後ろにずれる
// （9:20〜11:50、12:50〜15:50）。寄り付き直後の20分や昼休み明けの20分に通信しても値は変わらない。
export const JP_DELAY_MS = 20 * MIN;
export function dataLive(now = Date.now(), market = 'JP') {
  return market === 'US' ? marketPhase(now, 'US').open : marketPhase(now - JP_DELAY_MS, 'JP').open;
}
export function isFresh(fetchedAt, ttlMs, now = Date.now(), market = 'JP') {
  if (!fetchedAt) return false;
  if (!dataLive(now, market)) {
    const end = market === 'US' ? usLastClose(now) : lastSessionEnd(now - JP_DELAY_MS);
    const settle = end + (market === 'US' ? US_SETTLE_MS : SETTLE_MS);
    if (now >= settle) return fetchedAt >= settle;
  }
  return now - fetchedAt < ttlMs;
}

/* ---------------- 米国市場（NYSE / NASDAQ） ----------------
   通常取引 9:30〜16:00（米国東部時間）。夏時間は端末の Intl で自動判定。
   米国の祝日は判定していない（祝日は場中扱いになるが、データは変わらないので表示に影響はない）。 */
const US_SETTLE_MS = 5 * MIN;
const etFmt = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  : null;
function et(t) {
  const o = {};
  for (const x of etFmt.formatToParts(new Date(t))) o[x.type] = x.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  const key = `${o.year}-${pad(Number(o.month))}-${pad(Number(o.day))}`;
  return { dow, key, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}
// 米国の取引日か（土日・休場日を除く）と、その日の引けの時刻（分）
const usTradingDay = (p) => p.dow !== 0 && p.dow !== 6 && !US_HOLIDAYS.has(p.key);
const usCloseMin = (p) => (US_EARLY_CLOSE.has(p.key) ? 780 : 960); // 短縮取引日は 13:00
function usPhase(now) {
  const p = et(now);
  if (!usTradingDay(p)) return { open: false, code: 'holiday', label: '休場日' };
  if (p.min < 570) return { open: false, code: 'pre', label: '取引開始前' };
  if (p.min < usCloseMin(p)) return { open: true, code: 'open', label: US_EARLY_CLOSE.has(p.key) ? '取引中（短縮取引）' : '取引中' };
  return { open: false, code: 'closed', label: '閉場中' };
}
// 直近の引け（16:00 ET、短縮取引日は 13:00）。日単位でさかのぼって探す
function usLastClose(now) {
  for (let i = 0; i < 14; i++) {
    const t = now - i * 24 * H;
    const p = et(t);
    if (!usTradingDay(p)) continue;
    const close = t - (p.min - usCloseMin(p)) * MIN;
    if (close <= now) return Math.floor(close / MIN) * MIN;
  }
  return 0;
}

export function fmtClock(t) {
  const p = jst(t);
  return `${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}`;
}

export function fmtStamp(t, now = Date.now()) {
  if (!t) return '—';
  const p = jst(t);
  if (dayKey(t) === dayKey(now)) return fmtClock(t);
  return `${p.m}/${p.d} ${pad(p.hh)}:${pad(p.mi)}`;
}

// 東証の取引時間判定（端末のタイムゾーンに依存せず JST で計算）
const H = 3600e3;
const MIN = 60e3;

// 休場日は js/holidays.js（tools/gen-holidays.py で生成、2040年まで）
import { JP_HOLIDAYS as HOLIDAYS, US_HOLIDAYS, US_EARLY_CLOSE } from './holidays.js?v=20261128160113';

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

/* ---------------- 銘柄ごとの取引時間の種類 ----------------
   JP：東証（休場日の表つき） ／ US：米国（祝日・短縮取引日の表つき）
   HK・CN・KR・TW・IN・UK・DE・EU：各国の株価指数（下の SESSIONS の現地時間。各国の祝日は判定しない）
   FX：為替（平日24時間。米国東部時間の金曜17:00〜日曜17:00と、FX_HOLIDAYS の日（前日17:00から24時間）は休み）
   FUT：先物（CME など。日曜18:00〜金曜17:00（米国東部時間）。毎日17:00〜18:00は休み。データは約10分遅れ）
   AG・LV・SOFT・CTN：取引時間の短い商品先物（穀物・畜産・ソフト商品・綿花。下の SESSIONS の windows）
   C：暗号資産（24時間・土日も）
   種類を足すときは SESSIONS に書き、names.js で銘柄に割り当てる。 */
export const SESSIONS = {
  HK: { tz: 'Asia/Hong_Kong', open: 570, close: 960, label: '香港' },     // 9:30〜16:00
  CN: { tz: 'Asia/Shanghai', open: 570, close: 900, label: '上海' },      // 9:30〜15:00
  KR: { tz: 'Asia/Seoul', open: 540, close: 930, label: '韓国' },         // 9:00〜15:30
  TW: { tz: 'Asia/Taipei', open: 540, close: 810, label: '台湾' },        // 9:00〜13:30
  IN: { tz: 'Asia/Kolkata', open: 555, close: 930, label: 'インド' },     // 9:15〜15:30
  UK: { tz: 'Europe/London', open: 480, close: 990, label: '英国' },      // 8:00〜16:30
  DE: { tz: 'Europe/Berlin', open: 540, close: 1050, label: 'ドイツ' },   // 9:00〜17:30
  EU: { tz: 'Europe/Berlin', open: 540, close: 1050, label: '欧州' },     // 9:00〜17:30
  /* 商品先物（取引時間が短いもの）。windows：{ days: 始まる曜日（0=日）, s: 開始（分）, e: 終了（分。1440を超えたら翌日） }。
     取引時間外は値が変わらないので取りに行かない。データは約10分遅れ。各取引所の祝日は判定しない。 */
  AG: { tz: 'America/Chicago', label: '穀物', delay: 10 * MIN, windows: [         // CBOT 穀物：夜間 19:00〜翌7:45、日中 8:30〜13:20（米国中部時間）
    { days: [0, 1, 2, 3, 4], s: 1140, e: 1905 }, { days: [1, 2, 3, 4, 5], s: 510, e: 800 }] },
  LV: { tz: 'America/Chicago', label: '畜産', delay: 10 * MIN, windows: [         // CME 畜産：8:30〜13:05（米国中部時間）
    { days: [1, 2, 3, 4, 5], s: 510, e: 785 }] },
  SOFT: { tz: 'America/New_York', label: 'ソフト商品', delay: 10 * MIN, windows: [ // ICE コーヒー・砂糖・ココア・オレンジジュース：3:30〜14:00（米国東部時間）
    { days: [1, 2, 3, 4, 5], s: 210, e: 840 }] },
  CTN: { tz: 'America/New_York', label: '綿花', delay: 10 * MIN, windows: [        // ICE 綿花：21:00〜翌14:20（米国東部時間）
    { days: [0, 1, 2, 3, 4], s: 1260, e: 2300 }] },
};
// 為替の休日（日本時間の月-日。その日の7:00から24時間は休み）。必要に応じて足す
export const FX_HOLIDAYS = ['01-01', '12-25'];
const isFxLike = (m) => m === 'FX' || m === 'FUT' || m === 'X';
const FUT_DELAY_MS = 10 * MIN; // CME などの先物は Yahoo で約10分遅れ
const SESS_DELAY_MS = 15 * MIN; // 各国の指数は Yahoo で約15分遅れ
// 表示用の名前（画面上部の状態）
export const MARKET_LABEL = { JP: '東証', US: '米国', FX: '為替', FUT: '先物', C: '暗号資産', X: '為替' };
for (const [k, v] of Object.entries(SESSIONS)) MARKET_LABEL[k] = v.label;

const localFmts = new Map();
function local(t, tz) {
  let f = localFmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    localFmts.set(tz, f);
  }
  const o = {};
  for (const x of f.formatToParts(new Date(t))) o[x.type] = x.value;
  return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday), key: `${o.year}-${pad(Number(o.month))}-${pad(Number(o.day))}`, min: (Number(o.hour) % 24) * 60 + Number(o.minute) };
}
// 取引時間が windows で書かれた種類（商品先物）
function winOpen(now, s) {
  for (const d of [0, 1]) {
    const p = local(now - d * 24 * H, s.tz);
    const m = local(now, s.tz).min + d * 1440;
    if (s.windows.some((w) => w.days.includes(p.dow) && m >= w.s && m < w.e)) return true;
  }
  return false;
}
function sessPhase(now, s) {
  if (s.windows) return winOpen(now, s) ? { open: true, code: 'open', label: '取引中' } : { open: false, code: 'closed', label: '取引時間外' };
  const p = local(now, s.tz);
  if (p.dow === 0 || p.dow === 6) return { open: false, code: 'holiday', label: '休場日' };
  if (p.min < s.open) return { open: false, code: 'pre', label: '取引開始前' };
  if (p.min < s.close) return { open: true, code: 'open', label: '取引中' };
  return { open: false, code: 'closed', label: '閉場中' };
}
function sessLastClose(now, s) {
  for (let i = 0; i < 10; i++) {
    const t = now - i * 24 * H;
    const p = local(t, s.tz);
    if (p.dow === 0 || p.dow === 6) continue;
    const close = t - (p.min - s.close) * MIN;
    if (close <= now) return Math.floor(close / MIN) * MIN;
  }
  return 0;
}

/* その銘柄の「今日の取引」が始まっているのに、まだ今日のデータが届いていないか（前日比を「−」にする）。
   timeSec：データの最終約定時刻（秒）。FX・FUT・C（ほぼ24時間動くもの）は対象外 */
export function awaitingToday(market, timeSec, now = Date.now()) {
  if (!timeSec) return false;
  const t = timeSec * 1000;
  if (market === 'JP') {
    const p = jst(now);
    return isTradingDay(p.y, p.m, p.d) && p.min >= AM[0] && dayKey(t) !== dayKey(now);
  }
  if (market === 'US') {
    const e = et(now);
    return usTradingDay(e) && e.min >= 570 && et(t).key !== e.key;
  }
  const s = SESSIONS[market];
  if (s && !s.windows) {
    const p = local(now, s.tz);
    return p.dow > 0 && p.dow < 6 && p.min >= s.open && local(t, s.tz).key !== p.key;
  }
  return false;
}
// 東証の今日の取引開始（9:00）の時刻（取引日でなければ 0）
export function jpOpenToday(now = Date.now()) {
  const p = jst(now);
  if (!isTradingDay(p.y, p.m, p.d)) return 0;
  return Date.UTC(p.y, p.m - 1, p.d) - 9 * H + AM[0] * MIN;
}
/* 東証の値幅制限（基準値段＝前日終値ごとの、1日に動ける幅）。ストップ高・ストップ安の判定に使う。
   ※制限値幅の拡大（連続してストップ高・安になったとき等）は考えない */
const JP_LIMITS = [[100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300], [2000, 400], [3000, 500], [5000, 700], [7000, 1000],
  [10000, 1500], [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000], [70000, 10000], [100000, 15000], [150000, 30000], [200000, 40000],
  [300000, 50000], [500000, 70000], [700000, 100000], [1000000, 150000], [1500000, 300000], [2000000, 400000], [3000000, 500000],
  [5000000, 700000], [7000000, 1000000], [10000000, 1500000], [15000000, 3000000], [20000000, 4000000], [30000000, 5000000], [50000000, 7000000]];
export function jpLimitWidth(prev) {
  for (const [lim, w] of JP_LIMITS) if (prev < lim) return w;
  return 10000000;
}

export function marketPhase(now = Date.now(), market = 'JP') {
  if (market === 'US') return usPhase(now);
  if (market === 'C') return { open: true, code: 'open', label: '取引中（24時間）' }; // 暗号資産は土日も動く
  if (market === 'FUT') return futPhase(now);
  if (isFxLike(market)) return xPhase(now);
  if (SESSIONS[market]) return sessPhase(now, SESSIONS[market]);
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
  if (market === 'C') return true;              // 暗号資産は止めない
  if (market === 'FUT') return futPhase(now - FUT_DELAY_MS).open; // 先物（約10分遅れ）
  if (isFxLike(market)) return xPhase(now).open; // 為替は週末・休日だけ止める
  const s = SESSIONS[market];
  if (s) return sessPhase(now - (s.delay ?? SESS_DELAY_MS), s).open; // 各国の指数（約15分遅れ）・商品先物（約10分遅れ）
  return market === 'US' ? marketPhase(now, 'US').open : marketPhase(now - JP_DELAY_MS, 'JP').open;
}
export function isFresh(fetchedAt, ttlMs, now = Date.now(), market = 'JP') {
  if (!fetchedAt) return false;
  if (!dataLive(now, market)) {
    const s = SESSIONS[market];
    let end, settle;
    if (market === 'US') { end = usLastClose(now); settle = end + US_SETTLE_MS; }
    else if (market === 'FUT') { end = closedSince(now - FUT_DELAY_MS, 'FUT'); settle = end + FUT_DELAY_MS + 5 * MIN; }
    else if (isFxLike(market)) { end = closedSince(now, 'FX'); settle = end + 5 * MIN; }
    else if (s?.windows) { end = closedSince(now - s.delay, market); settle = end + s.delay + 5 * MIN; }
    else if (s) { end = sessLastClose(now - SESS_DELAY_MS, s); settle = end + SESS_DELAY_MS + 5 * MIN; }
    else { end = lastSessionEnd(now - JP_DELAY_MS); settle = end + SETTLE_MS; }
    if (now >= settle) return fetchedAt >= settle;
  }
  return now - fetchedAt < ttlMs;
}

/* ---------------- 為替・先物 ----------------
   為替：米国東部時間の金曜17:00に閉まり、日曜17:00に開く（日本時間では土曜6:00〜7:00ごろ〜月曜6:00〜7:00ごろ。夏時間で1時間ずれる）。
         17:00 を1日の区切りとし、FX_HOLIDAYS の日（前日17:00から24時間）も休み。
   先物（CME など）：日曜18:00〜金曜17:00（米国東部時間）。毎日17:00〜18:00は休み。
   休みの間はその前に取得済みなら通信しない。（各取引所の祝日は判定しない。祝日は値が変わらないだけ） */
function xPhase(now) {
  const d = et(now + 7 * H); // 17:00 を次の日の 0:00 とみなした「取引日」
  if (d.dow === 0 || d.dow === 6) return { open: false, code: 'holiday', label: '週末の休み' };
  if (FX_HOLIDAYS.includes(d.key.slice(5))) return { open: false, code: 'holiday', label: '休日' };
  return { open: true, code: 'open', label: '取引中' };
}
function futPhase(now) {
  const x = xPhase(now);
  if (!x.open) return x;
  const e = et(now);
  if (e.min >= 1020 && e.min < 1080) return { open: false, code: 'break', label: '休憩中' }; // 毎日 17:00〜18:00
  return { open: true, code: 'open', label: '取引中' };
}
const kindOpen = (t, m) => (m === 'FUT' ? futPhase(t).open : m === 'FX' ? xPhase(t).open : winOpen(t, SESSIONS[m]));
// 今の休みが始まった時刻（30分刻みでさかのぼってから1分単位で詰める。1分ごとに覚えておく）
const closedMemo = new Map();
function closedSince(now, m) {
  const k = `${m}|${Math.floor(now / MIN)}`;
  if (closedMemo.has(k)) return closedMemo.get(k);
  let t = now;
  for (let i = 0; i < 4 * 48 && !kindOpen(t, m); i++) t -= 30 * MIN;
  let r = 0;
  if (kindOpen(t, m)) {
    while (t + MIN <= now && kindOpen(t + MIN, m)) t += MIN;
    r = Math.floor((t + MIN) / MIN) * MIN;
  }
  if (closedMemo.size > 50) closedMemo.clear();
  closedMemo.set(k, r);
  return r;
}

/* ---------------- 米国市場（NYSE / NASDAQ） ----------------
   通常取引 9:30〜16:00（米国東部時間）。夏時間は端末の Intl で自動判定。
   休場日・短縮取引日（13:00 引け）は js/holidays.js の表で判定する。 */
const US_SETTLE_MS = 15 * MIN; // 引け後の終値の確定（クロージング・オークションの反映）を待つ余裕
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

/* 1日の通信上限に達した日でも、株価を最低限更新する時間帯（その日1回ずつ）
   ・東証：後場の始まり（データが届く 12:55〜13:55）と、引け後（16:00〜）
   ・米国：取引開始30分後（10:00〜11:00 米国東部時間）と、引けの15分後から3時間
   海外の指数・為替・暗号資産は東証と同じ時間帯にまとめる。
   返す値：[{ id（その日・その時間帯で一意）, market: 'JP'|'US', since（時間帯の始まり） }] */
export function emergencySlots(now = Date.now()) {
  const out = [];
  const p = jst(now);
  const key = dayKey(now);
  if (isTradingDay(p.y, p.m, p.d)) {
    if (p.min >= 775 && p.min < 835) out.push({ id: `jp-pm|${key}`, market: 'JP', since: now - (p.min - 775) * MIN });
    if (p.min >= 960) out.push({ id: `jp-close|${key}`, market: 'JP', since: now - (p.min - 960) * MIN });
  }
  const e = et(now);
  if (usTradingDay(e)) {
    if (e.min >= 600 && e.min < 660) out.push({ id: `us-open|${e.key}`, market: 'US', since: now - (e.min - 600) * MIN });
    const c = usCloseMin(e) + 15;
    if (e.min >= c && e.min < c + 180) out.push({ id: `us-close|${e.key}`, market: 'US', since: now - (e.min - c) * MIN });
  }
  return out;
}

/* 市場が開いた瞬間（前場9:00・後場12:30（東証）、9:30（米国東部時間））から2分以内なら、そのできごとを返す。
   休場日・米国の祝日は返さない。id はその日・そのできごとで一意（同じできごとで2回鳴らさないため） */
export function marketOpenEvents(now = Date.now()) {
  const out = [];
  const p = jst(now);
  if (isTradingDay(p.y, p.m, p.d)) {
    if (p.min >= AM[0] && p.min < AM[0] + 2) out.push({ id: `jp-am|${dayKey(now)}`, kind: 'jp', label: '東証の前場が始まりました' });
    if (p.min >= PM[0] && p.min < PM[0] + 2) out.push({ id: `jp-pm|${dayKey(now)}`, kind: 'jp', label: '東証の後場が始まりました' });
  }
  const e = et(now);
  if (usTradingDay(e) && e.min >= 570 && e.min < 572) out.push({ id: `us|${e.key}`, kind: 'us', label: '米国市場が始まりました' });
  return out;
}

/* 市場が閉じた瞬間（前場11:30・大引け15:30（東証）、16:00（米国東部時間。短縮取引日は13:00））から2分以内なら、そのできごとを返す */
export function marketCloseEvents(now = Date.now()) {
  const out = [];
  const p = jst(now);
  if (isTradingDay(p.y, p.m, p.d)) {
    if (p.min >= AM[1] && p.min < AM[1] + 2) out.push({ id: `jp-am-close|${dayKey(now)}`, kind: 'jpClose', label: '東証の前場が終わりました' });
    if (p.min >= PM[1] && p.min < PM[1] + 2) out.push({ id: `jp-pm-close|${dayKey(now)}`, kind: 'jpClose', label: '東証の取引が終わりました（大引け）' });
  }
  const e = et(now);
  const c = usCloseMin(e);
  if (usTradingDay(e) && e.min >= c && e.min < c + 2) out.push({ id: `us-close|${e.key}`, kind: 'usClose', label: '米国市場の取引が終わりました' });
  return out;
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

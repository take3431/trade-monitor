// 東証の取引時間判定（端末のタイムゾーンに依存せず JST で計算）
const H = 3600e3;
const MIN = 60e3;

// 東証休場日（土日以外）。年末年始 12/31〜1/3 はロジックで判定。
// 2025〜2035年分。祝日法（ハッピーマンデー・振替休日・国民の休日）と春分/秋分の天文計算式から算出。
// ※春分・秋分の日は前年2月の官報公示で確定します。JPX の休業日カレンダーで確認・修正してください。
const HOLIDAYS = new Set([
  // 2025
  '2025-01-13', '2025-02-11', '2025-02-24', '2025-03-20', '2025-04-29', '2025-05-05', '2025-05-06',
  '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23', '2025-10-13', '2025-11-03', '2025-11-24',
  // 2026
  '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29', '2026-05-04', '2026-05-05',
  '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22', '2026-09-23', '2026-10-12',
  '2026-11-03', '2026-11-23',
  // 2027
  '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-22', '2027-04-29', '2027-05-03', '2027-05-04',
  '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23', '2027-10-11', '2027-11-03',
  '2027-11-23',
  // 2028
  '2028-01-10', '2028-02-11', '2028-02-23', '2028-03-20', '2028-05-03', '2028-05-04', '2028-05-05',
  '2028-07-17', '2028-08-11', '2028-09-18', '2028-09-22', '2028-10-09', '2028-11-03', '2028-11-23',
  // 2029
  '2029-01-08', '2029-02-12', '2029-02-23', '2029-03-20', '2029-04-30', '2029-05-03', '2029-05-04',
  '2029-07-16', '2029-09-17', '2029-09-24', '2029-10-08', '2029-11-23',
  // 2030
  '2030-01-14', '2030-02-11', '2030-03-20', '2030-04-29', '2030-05-03', '2030-05-06', '2030-07-15',
  '2030-08-12', '2030-09-16', '2030-09-23', '2030-10-14', '2030-11-04',
  // 2031
  '2031-01-13', '2031-02-11', '2031-02-24', '2031-03-21', '2031-04-29', '2031-05-05', '2031-05-06',
  '2031-07-21', '2031-08-11', '2031-09-15', '2031-09-23', '2031-10-13', '2031-11-03', '2031-11-24',
  // 2032
  '2032-01-12', '2032-02-11', '2032-02-23', '2032-04-29', '2032-05-03', '2032-05-04', '2032-05-05',
  '2032-07-19', '2032-08-11', '2032-09-20', '2032-09-21', '2032-09-22', '2032-10-11', '2032-11-03',
  '2032-11-23',
  // 2033
  '2033-01-10', '2033-02-11', '2033-02-23', '2033-03-21', '2033-04-29', '2033-05-03', '2033-05-04',
  '2033-05-05', '2033-07-18', '2033-08-11', '2033-09-19', '2033-09-23', '2033-10-10', '2033-11-03',
  '2033-11-23',
  // 2034
  '2034-01-09', '2034-02-23', '2034-03-20', '2034-05-03', '2034-05-04', '2034-05-05', '2034-07-17',
  '2034-08-11', '2034-09-18', '2034-10-09', '2034-11-03', '2034-11-23',
  // 2035
  '2035-01-08', '2035-02-12', '2035-02-23', '2035-03-21', '2035-04-30', '2035-05-03', '2035-05-04',
  '2035-07-16', '2035-09-17', '2035-09-24', '2035-10-08', '2035-11-23',
]);

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

export function marketPhase(now = Date.now()) {
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
export function isFresh(fetchedAt, ttlMs, now = Date.now()) {
  if (!fetchedAt) return false;
  if (!marketPhase(now).open) {
    const settle = lastSessionEnd(now) + SETTLE_MS;
    if (now >= settle) return fetchedAt >= settle;
  }
  return now - fetchedAt < ttlMs;
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

#!/usr/bin/env python3
"""js/holidays.js（東証・米国市場の休場日／短縮取引日）を作る。

    python3 tools/gen-holidays.py [最終年]   # 既定 2040

東証：祝日法（固定日・ハッピーマンデー・振替休日・国民の休日）と春分/秋分の天文計算式から算出。
      年末年始（12/31〜1/3）はアプリ側で判定する。
米国（NYSE/NASDAQ）：取引所の休場規則から算出。
      元日・キング牧師記念日・大統領の日・聖金曜日・戦没将兵追悼記念日・ジューンティーンス・独立記念日・
      労働者の日・感謝祭・クリスマス。土曜は前の金曜、日曜は翌月曜に振替（元日が土曜の場合は振替なし）。
      短縮取引（13:00 終了）：独立記念日の前日、感謝祭の翌日、クリスマスイブ。
※春分・秋分は前年2月の官報、米国の休場日は取引所の発表で確定する。将来分は予定日。
"""
import datetime as dt
import math
import pathlib
import sys

FIRST = 2025
LAST = int(sys.argv[1]) if len(sys.argv) > 1 else 2040
D = dt.date
day = dt.timedelta(days=1)


def nth_weekday(y, m, wd, n):  # wd: 0=月
    d = D(y, m, 1)
    d += dt.timedelta((wd - d.weekday()) % 7)
    return d + dt.timedelta(7 * (n - 1))


def last_weekday(y, m, wd):
    d = D(y, m + 1, 1) - day if m < 12 else D(y, 12, 31)
    return d - dt.timedelta((d.weekday() - wd) % 7)


# ---------------- 日本 ----------------
def jp_holidays(y):
    k = y - 1980
    spring = math.floor(20.8431 + 0.242194 * k - math.floor(k / 4))
    autumn = math.floor(23.2488 + 0.242194 * k - math.floor(k / 4))
    h = {D(y, 1, 1), nth_weekday(y, 1, 0, 2), D(y, 2, 11), D(y, 2, 23), D(y, 3, spring), D(y, 4, 29),
         D(y, 5, 3), D(y, 5, 4), D(y, 5, 5), nth_weekday(y, 7, 0, 3), D(y, 8, 11), nth_weekday(y, 9, 0, 3),
         D(y, 9, autumn), nth_weekday(y, 10, 0, 2), D(y, 11, 3), D(y, 11, 23)}
    for d in sorted(h):  # 国民の休日（祝日に挟まれた平日）
        if d + 2 * day in h and d + day not in h and (d + day).weekday() != 6:
            h.add(d + day)
    for d in sorted(h):  # 振替休日
        if d.weekday() == 6:
            n = d + day
            while n in h:
                n += day
            h.add(n)
    return sorted(d for d in h if d.weekday() < 5 and not ((d.month == 1 and d.day <= 3) or (d.month == 12 and d.day == 31)))


# ---------------- 米国 ----------------
def easter(y):  # 西暦の復活祭（グレゴリオ暦）
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4
    f = (b + 8) // 25; g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4; l_ = (32 + 2 * e + 2 * i - h - k) % 7; m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31; dd = ((h + l_ - 7 * m + 114) % 31) + 1
    return D(y, month, dd)


def observed(d, new_year=False):
    if d.weekday() == 5:
        return None if new_year else d - day  # 元日が土曜なら振替なし（NYSE規則）
    if d.weekday() == 6:
        return d + day
    return d


def us_holidays(y):
    h = [observed(D(y, 1, 1), True), nth_weekday(y, 1, 0, 3), nth_weekday(y, 2, 0, 3), easter(y) - 2 * day,
         last_weekday(y, 5, 0), observed(D(y, 6, 19)), observed(D(y, 7, 4)), nth_weekday(y, 9, 0, 1),
         nth_weekday(y, 11, 3, 4), observed(D(y, 12, 25))]
    return sorted(d for d in h if d)


def us_early(y, hol):
    out = []
    j3 = D(y, 7, 3)
    if j3.weekday() < 5 and j3 not in hol:
        out.append(j3)
    out.append(nth_weekday(y, 11, 3, 4) + day)
    ce = D(y, 12, 24)
    if ce.weekday() < 5 and ce not in hol:
        out.append(ce)
    return out


jp, us, early = [], [], []
for y in range(FIRST, LAST + 1):
    jp += jp_holidays(y)
    hol = us_holidays(y)
    us += hol
    early += us_early(y, set(hol))


def fmt(ds, per=8):
    items = [f"'{d.isoformat()}'" for d in ds]
    return '\n'.join('  ' + ', '.join(items[i:i + per]) + ',' for i in range(0, len(items), per))


out = f"""// 自動生成ファイル（tools/gen-holidays.py）。直接編集しないでください。
// 東証・米国市場の休場日（{FIRST}〜{LAST}年）。将来分は計算による予定日です。

// 東証の休場日（土日・年末年始 12/31〜1/3 以外）
export const JP_HOLIDAYS = new Set([
{fmt(jp)}
]);

// 米国（NYSE/NASDAQ）の休場日
export const US_HOLIDAYS = new Set([
{fmt(us)}
]);

// 米国の短縮取引日（13:00 終了）
export const US_EARLY_CLOSE = new Set([
{fmt(early)}
]);

export const CALENDAR_LAST_YEAR = {LAST};
"""
(pathlib.Path(__file__).resolve().parent.parent / 'js' / 'holidays.js').write_text(out, encoding='utf-8')
print(f'JP {len(jp)}日, US {len(us)}日, 短縮 {len(early)}日 ({FIRST}-{LAST})')
for y in (2025, 2026):
    print(y, 'US', [d.strftime('%m/%d') for d in us_holidays(y)])

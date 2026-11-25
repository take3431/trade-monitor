#!/usr/bin/env python3
"""JPX（日本取引所グループ）公表の「東証上場銘柄一覧」から data/jp-stocks.json を作り直す。

使い方（月1回程度。JPX は毎月初めに前月末時点の一覧を公開します）:
    pip install openpyxl
    python3 tools/update-jp-stocks.py
"""
import io, json, pathlib, unicodedata, urllib.request
import openpyxl

URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx"
MARKET = {
    "プライム（内国株式）": "P", "プライム（外国株式）": "P",
    "スタンダード（内国株式）": "S", "スタンダード（外国株式）": "S",
    "グロース（内国株式）": "G", "グロース（外国株式）": "G",
    "ETF・ETN": "E", "PRO Market": "PRO", "出資証券": "O",
    "REIT・ベンチャーファンド・カントリーファンド・インフラファンド": "R",
}

data = urllib.request.urlopen(URL, timeout=60).read()
rows = list(openpyxl.load_workbook(io.BytesIO(data), read_only=True).active.iter_rows(values_only=True))[1:]
out = {}
for r in rows:
    code = str(r[1]).strip().upper()
    out[code] = [unicodedata.normalize("NFKC", str(r[2])).strip(), MARKET.get(r[3], "")]
dest = pathlib.Path(__file__).resolve().parent.parent / "data" / "jp-stocks.json"
dest.write_text(json.dumps({"asof": str(rows[0][0]), "list": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(out)} 銘柄（{rows[0][0]} 時点）を {dest} に書き出しました")

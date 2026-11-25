#!/usr/bin/env python3
"""JPX（日本取引所グループ）公表の「東証上場銘柄一覧」から data/jp-stocks.json を作り直す。

使い方（月1回程度。JPX は毎月初めに前月末時点の一覧を公開します）:
    pip install openpyxl pykakasi
    python3 tools/update-jp-stocks.py

読みがな（ひらがな検索用）は pykakasi で自動生成します。読みが複数ある語（日本＝ニホン/ニッポン 等）は両方入れます。
"""
import io, json, pathlib, unicodedata, urllib.request
import openpyxl
import pykakasi
from jp_aliases import with_aliases  # 通称・略称（NEC、ホンダ 等）

_kks = pykakasi.kakasi()
# 読みが分かれやすい語は別の読みも入れておく
# (漢字, 読み, 別の読み)
ALT = [("日本", "ニッポン", "ニホン"), ("日本", "ニホン", "ニッポン"), ("大和", "ヤマト", "ダイワ"), ("大和", "ダイワ", "ヤマト")]


def reading(name):
    r = "".join(x["kana"] for x in _kks.convert(name))
    r = unicodedata.normalize("NFKC", r).upper()
    variants = {r}
    for kanji, a, b in ALT:
        if kanji in name and a in r:
            variants.add(r.replace(a, b))
    return "|".join(sorted(variants))


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
    name = unicodedata.normalize("NFKC", str(r[2])).strip()
    # 規模（TOPIX の規模区分）：検索結果で大きな会社を上に出すために使う
    size = {"TOPIX Core30": 0, "TOPIX Large70": 1, "TOPIX Mid400": 2, "TOPIX Small 1": 3, "TOPIX Small 2": 4}.get(str(r[9]).strip(), 5)
    out[code] = [name, MARKET.get(r[3], ""), with_aliases(code, reading(name)), size]
dest = pathlib.Path(__file__).resolve().parent.parent / "data" / "jp-stocks.json"
dest.write_text(json.dumps({"asof": str(rows[0][0]), "list": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(out)} 銘柄（{rows[0][0]} 時点）を {dest} に書き出しました")

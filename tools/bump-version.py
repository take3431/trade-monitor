#!/usr/bin/env python3
"""公開前に実行して、読み込むファイルの URL に版番号（?v=...）を付け直す。

ブラウザは同じ URL のファイルを最大10分ほど覚えている（GitHub Pages の設定）ため、
版番号を変えることで、更新した直後から新しいファイルが読み込まれるようにする。
また version.json を書き換え、開きっぱなしの端末も新しい版を検知して自動で読み込み直す。

    python3 tools/bump-version.py
"""
import json
import pathlib
import re
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
VER = time.strftime('%Y%m%d%H%M%S')

# index.html：CSS・JS の読み込み
p = ROOT / 'index.html'
s = p.read_text(encoding='utf-8')
s = re.sub(r'((?:href|src)="(?:css|js|vendor)/[^"?]+\.(?:css|js))(\?v=\d+)?"', rf'\1?v={VER}"', s)
s = re.sub(r'<meta name="app-version" content="\d*">', f'<meta name="app-version" content="{VER}">', s)
p.write_text(s, encoding='utf-8')

# js：モジュール同士の import と、銘柄辞書の読み込み
for f in (ROOT / 'js').glob('*.js'):
    s = f.read_text(encoding='utf-8')
    s = re.sub(r"(from '\./[^'?]+\.js)(\?v=\d+)?'", rf"\1?v={VER}'", s)
    s = re.sub(r"(import\('\./[^'?]+\.js)(\?v=\d+)?'", rf"\1?v={VER}'", s)
    s = re.sub(r"(fetch\('data/jp-stocks\.json)(\?v=\d+)?'", rf"\1?v={VER}'", s)
    f.write_text(s, encoding='utf-8')

(ROOT / 'version.json').write_text(json.dumps({'version': VER}) + '\n', encoding='utf-8')
print('version', VER)

// 銘柄名辞書
//  - 日本株：JPX（日本取引所グループ）公表の上場銘柄一覧から作成した data/jp-stocks.json（約4,400銘柄）
//  - 米国株：よく取引される銘柄の日本語名（それ以外は Yahoo の検索結果の英語名）

/* 主要な指数・為替・商品（Yahoo のシンボルをそのまま銘柄コードとして使う）
   コード: [日本語名, 検索用の別名（空白区切り）, 取引時間の区分, Yahoo!ファイナンス（日本）のページのコード]
   取引時間の区分：JP＝東証と同じ ／ US＝米国市場と同じ ／ X＝その他（海外市場・為替・暗号資産。時間で止めない） */
export const INDICES = {
  '^N225': ['日経平均株価', '日経平均 日経225 ニッケイヘイキン Nikkei225 N225', 'JP', '998407.O'],
  '^N500': ['日経500種平均株価', '日経500 Nikkei500', 'JP', '^N500'],
  '^GSPC': ['S&P500', 'エスアンドピー500 SP500 SPX スタンダードアンドプアーズ', 'US', '^GSPC'],
  '^DJI': ['NYダウ（ダウ平均株価）', 'ダウ NYダウ ダウ平均 ダウ工業株30種 ダウジョーンズ DJIA', 'US', '^DJI'],
  '^IXIC': ['ナスダック総合指数', 'NASDAQ ナスダック総合 ナスダック', 'US', '^IXIC'],
  '^NDX': ['ナスダック100指数', 'NASDAQ100 ナスダック100 NDX', 'US', '^NDX'],
  '^SOX': ['SOX指数（フィラデルフィア半導体株指数）', '半導体指数 フィラデルフィア半導体 SOX', 'US', '^SOX'],
  '^RUT': ['ラッセル2000指数', 'Russell2000 ラッセル 小型株', 'US', '^RUT'],
  '^VIX': ['VIX指数（恐怖指数）', '恐怖指数 ボラティリティ VIX', 'US', '^VIX'],
  '^TNX': ['米国10年国債利回り', '米国債 10年債 長期金利 金利 TNX', 'US', '^TNX'],
  '^HSI': ['香港ハンセン指数', 'ハンセン 香港 HangSeng HSI', 'X', '^HSI'],
  '000001.SS': ['上海総合指数', '上海 中国 Shanghai SSE', 'X', '000001.SS'],
  '^KS11': ['韓国総合株価指数（KOSPI）', 'KOSPI コスピ 韓国', 'X', '^KS11'],
  '^TWII': ['台湾加権指数', '台湾 TAIEX 加権', 'X', '^TWII'],
  '^BSESN': ['インドSENSEX指数', 'センセックス インド SENSEX', 'X', '^BSESN'],
  '^FTSE': ['英国FTSE100指数', 'FTSE100 フッツィー イギリス 英国', 'X', '^FTSE'],
  '^GDAXI': ['ドイツDAX指数', 'DAX ダックス ドイツ', 'X', '^GDAXI'],
  '^STOXX50E': ['ユーロ・ストックス50', 'ユーロストックス EuroStoxx50 欧州', 'X', '^STOXX50E'],
  'USDJPY=X': ['米ドル/円', 'ドル円 ドル 為替 USDJPY', 'X', 'USDJPY=FX'],
  'EURJPY=X': ['ユーロ/円', 'ユーロ円 ユーロ 為替 EURJPY', 'X', 'EURJPY=FX'],
  'BTC-USD': ['ビットコイン（米ドル建て）', 'ビットコイン BTC 仮想通貨 暗号資産 Bitcoin', 'X', 'BTC-USD'],
  'GC=F': ['金先物（NY金）', '金 ゴールド 金価格 Gold', 'X', 'GC=F'],
  'CL=F': ['WTI原油先物', '原油 WTI 石油 CrudeOil', 'X', 'CL=F'],
};
export const isIndex = (code) => Object.prototype.hasOwnProperty.call(INDICES, code);
// 市場の区分（米国株は英字で始まる。指数・為替などは除く）
export const isUS = (code) => /^[A-Z]/.test(code) && !isIndex(code);
// 取引時間の判定に使う市場：JP（東証）／ US（米国）／ X（時間で止めない）
export const marketOfCode = (code) => (isIndex(code) ? INDICES[code][2] : isUS(code) ? 'US' : 'JP');
// Yahoo に問い合わせるときのシンボル（日本株は .T を付ける）
export const yahooSymbol = (code) => (isIndex(code) || isUS(code) ? code : `${code}.T`);
// Yahoo!ファイナンス（日本）のページ
export const yahooJpUrl = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(isIndex(code) ? INDICES[code][3] : yahooSymbol(code))}`;
export const JP_RE = /^[0-9][0-9A-Z]{3}$/;
export const US_RE = /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/;

import { US, US_TOP } from './us-names.js?v=20261125150209';

export const US_NAMES = Object.fromEntries(Object.entries(US).map(([k, v]) => [k, v[0]]));

const MARKET_LABEL = { P: 'プライム', S: 'スタンダード', G: 'グロース', E: 'ETF・ETN', R: 'REIT等', PRO: 'PRO', O: '出資証券' };

let jp = null;
let index = null; // 検索用に正規化済みの一覧（読み込み時に1回だけ作る）
let jpLoading = null;

// 全角・半角、ひらがな・カタカナ、長音・記号の違いを吸収して比較する
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const norm = (s) => toKata(String(s).normalize('NFKC').toUpperCase()).replace(/[\s・･.\-()（）&＆'’]/g, '');

const LETTER_KANA = {
  A: 'エー', B: 'ビー', C: 'シー', D: 'ディー', E: 'イー', F: 'エフ', G: 'ジー', H: 'エイチ', I: 'アイ', J: 'ジェイ',
  K: 'ケー', L: 'エル', M: 'エム', N: 'エヌ', O: 'オー', P: 'ピー', Q: 'キュー', R: 'アール', S: 'エス', T: 'ティー',
  U: 'ユー', V: 'ブイ', W: 'ダブリュー', X: 'エックス', Y: 'ワイ', Z: 'ゼット',
};
const TOP_RANK = new Map(US_TOP.map((c, i) => [c, i]));
function buildIndex() {
  const rows = [];
  for (const [code, [name, m, rd, size = 5]] of Object.entries(jp || {})) {
    const market = MARKET_LABEL[m] || '東証';
    rows.push({ code, name, market, size, rank: 9999, k: norm(name), r: (rd || '').split('|').map(norm), minor: /ETF|PRO|REIT|出資/.test(market) });
  }
  // 指数は一番上に出す（「日経平均」で日経平均株価が先頭に来るように）
  for (const [code, [name, alt]] of Object.entries(INDICES)) {
    rows.push({ code, name, market: '指数', size: 0, rank: 0, k: norm(name), r: [norm(code), ...alt.split(' ').map(norm)], minor: false });
  }
  for (const [code, [name, en]] of Object.entries(US)) {
    const etf = /ETF|SPDR|ファンド|トラスト/.test(name);
    // 規模の目安：時価総額の上位50社は東証のCore30、上位300社はLarge70と同じ扱い。それ以外は中型株と同じ
    const rank = TOP_RANK.has(code) ? TOP_RANK.get(code) : 9999;
    const size = rank < 50 ? 1 : rank < 300 || etf ? 2 : 3;
    rows.push({ code, name, market: etf ? '米国ETF' : '米国', size, rank, k: norm(name), r: [norm(code), norm(en)], minor: false });
  }
  // 英字の読み（JP→ジェイピー、NTT→エヌティーティー）でも探せるようにする
  for (const x of rows) {
    if (/[A-Z]/.test(x.k)) x.r.push(x.k.replace(/[A-Z]/g, (c) => LETTER_KANA[c]));
  }
  // 長音「ー」の有無の違い（すたばっくす／スターバックス 等）も拾えるよう、「ー」を除いた形も持っておく
  for (const x of rows) { x.k2 = x.k.replace(/ー/g, ''); x.r2 = x.r.map((v) => v.replace(/ー/g, '')); }
  index = rows;
}

export function loadDict() {
  if (jp) return Promise.resolve(jp);
  if (!jpLoading) {
    jpLoading = fetch('data/jp-stocks.json?v=20261125150209')
      .then((r) => r.json())
      .then((j) => { jp = j.list; buildIndex(); return jp; })
      .catch(() => { jpLoading = null; return {}; });
  }
  return jpLoading;
}
export const dictReady = () => !!index;

export function lookupName(code) {
  if (isIndex(code)) return INDICES[code][0];
  if (isUS(code)) return US_NAMES[code] || '';
  return jp?.[code]?.[0] || '';
}

// 入力途中のローマ字（例: 「とy」の y）は無視して検索する
export function cleanQuery(q) {
  const t = String(q).trim();
  return /[^\x00-\x7F]/.test(t) ? t.replace(/[a-zA-Z]+$/, '') : t;
}

// 同期で即座に返す（辞書が未読込なら空）
export function searchLocal(q, limit = 30) {
  if (!index) return [];
  const n = norm(cleanQuery(q));
  if (!n) return [];
  const n2 = n.replace(/ー/g, '');
  const hits = [];
  for (const x of index) {
    let score;
    if (x.code === n || x.k === n || x.r.includes(n)) score = 0;
    else if (x.code.startsWith(n)) score = 1;
    else if (x.k.startsWith(n) || x.r.some((r) => r.startsWith(n))) score = 2;
    else if (x.k.includes(n) || x.r.some((r) => r.includes(n))) score = 3;
    else if (n2 && (x.k2.startsWith(n2) || x.r2.some((r) => r.startsWith(n2)))) score = 4;
    else if (n2 && n2.length >= 3 && (x.k2.includes(n2) || x.r2.some((r) => r.includes(n2)))) score = 5;
    else continue;
    hits.push({ code: x.code, name: x.name, market: x.market, size: x.size, rank: x.rank, score: score * 10 + (x.minor ? 5 : 0) });
  }
  // 同じ一致度なら、規模の大きい会社（TOPIX Core30 → Large70 → Mid400 → …）、次に社名の短いものを上に
  // 米国株は時価総額の大きい順
  hits.sort((a, b) => a.score - b.score || a.size - b.size || a.rank - b.rank || a.name.length - b.name.length || a.code.localeCompare(b.code));
  return hits.slice(0, limit);
}

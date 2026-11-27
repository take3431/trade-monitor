// 銘柄名辞書
//  - 日本株：JPX（日本取引所グループ）公表の上場銘柄一覧から作成した data/jp-stocks.json（約4,400銘柄）
//  - 米国株：よく取引される銘柄の日本語名（それ以外は Yahoo の検索結果の英語名）

/* 主要な指数・先物・為替・商品（Yahoo のシンボルをそのまま銘柄コードとして使う）
   コード: [日本語名, 検索用の別名（空白区切り）, 取引時間の種類, Yahoo!ファイナンス（日本）のページのコード]
   取引時間の種類（market.js の説明も参照）：
     JP＝東証 ／ US＝米国市場 ／ HK・CN・KR・TW・IN・UK・DE・EU＝各国の株価指数（現地の取引時間）
     FX＝為替（平日24時間。土日と FX_HOLIDAYS は休み） ／ FUT＝先物（FX と同じ扱い） ／ C＝暗号資産（24時間・土日も）
   JP・US・各国の指数は「その日の取引が始まってから、今日のデータが届くまで」前日比を「−」にする。
   FX・FUT・C はほぼ24時間動いているので、この扱いをしない。 */
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
  '^HSI': ['香港ハンセン指数', 'ハンセン 香港 HangSeng HSI', 'HK', '^HSI'],
  '000001.SS': ['上海総合指数', '上海 中国 Shanghai SSE', 'CN', '000001.SS'],
  '^KS11': ['韓国総合株価指数（KOSPI）', 'KOSPI コスピ 韓国', 'KR', '^KS11'],
  '^TWII': ['台湾加権指数', '台湾 TAIEX 加権', 'TW', '^TWII'],
  '^BSESN': ['インドSENSEX指数', 'センセックス インド SENSEX', 'IN', '^BSESN'],
  '^FTSE': ['英国FTSE100指数', 'FTSE100 フッツィー イギリス 英国', 'UK', '^FTSE'],
  '^GDAXI': ['ドイツDAX指数', 'DAX ダックス ドイツ', 'DE', '^GDAXI'],
  '^STOXX50E': ['ユーロ・ストックス50', 'ユーロストックス EuroStoxx50 欧州', 'EU', '^STOXX50E'],
  'USDJPY=X': ['米ドル/円', 'ドル円 ドル 為替 USDJPY', 'FX', 'USDJPY=FX'],
  'EURJPY=X': ['ユーロ/円', 'ユーロ円 ユーロ 為替 EURJPY', 'FX', 'EURJPY=FX'],
  'BTC-USD': ['ビットコイン（米ドル建て）', 'ビットコイン BTC 仮想通貨 暗号資産 Bitcoin', 'C', 'BTC-USD'],
  'NIY=F': ['日経平均先物（円建て・CME）', '日経先物 日経平均先物 先物 Nikkei Futures NIY', 'FUT', 'NIY=F'],
  'NKD=F': ['日経平均先物（ドル建て・CME）', '日経先物 日経平均先物 ドル建て 先物 NKD', 'FUT', 'NKD=F'],
  'YM=F': ['NYダウ先物（ミニ）', 'ダウ先物 NYダウ先物 先物 Dow Futures YM', 'FUT', 'YM=F'],
  'ES=F': ['S&P500先物（ミニ）', 'S&P500先物 SP500先物 エスアンドピー先物 先物 ES', 'FUT', 'ES=F'],
  'NQ=F': ['ナスダック100先物（ミニ）', 'ナスダック先物 ナスダック100先物 先物 Nasdaq Futures NQ', 'FUT', 'NQ=F'],
  'RTY=F': ['ラッセル2000先物（ミニ）', 'ラッセル先物 先物 Russell Futures RTY', 'FUT', 'RTY=F'],
  // ---- コモディティ（商品先物。値の単位は取引所の単位。¢＝セント） ----
  'GC=F': ['金先物（NY金・ドル/トロイオンス）', '金 ゴールド 金価格 Gold コモディティ 商品', 'FUT', 'GC=F'],
  'SI=F': ['銀先物（NY銀・ドル/トロイオンス）', '銀 シルバー 銀価格 Silver コモディティ 商品', 'FUT', 'SI=F'],
  'PL=F': ['プラチナ先物（白金・ドル/トロイオンス）', 'プラチナ 白金 Platinum コモディティ 商品', 'FUT', 'PL=F'],
  'PA=F': ['パラジウム先物（ドル/トロイオンス）', 'パラジウム Palladium コモディティ 商品', 'FUT', 'PA=F'],
  'HG=F': ['銅先物（ドル/ポンド）', '銅 カッパー Copper コモディティ 商品 非鉄', 'FUT', 'HG=F'],
  'ALI=F': ['アルミニウム先物（ドル/トン）', 'アルミ アルミニウム Aluminum コモディティ 商品 非鉄', 'FUT', 'ALI=F'],
  'TIO=F': ['鉄鉱石先物（ドル/トン）', '鉄鉱石 鉄 IronOre コモディティ 商品', 'FUT', 'TIO=F'],
  'UX=F': ['ウラン先物（ドル/ポンド）', 'ウラン Uranium コモディティ 商品', 'FUT', 'UX=F'],
  'CL=F': ['WTI原油先物（ドル/バレル）', '原油 WTI 石油 CrudeOil コモディティ 商品', 'FUT', 'CL=F'],
  'BZ=F': ['ブレント原油先物（ドル/バレル）', 'ブレント 原油 北海 石油 Brent コモディティ 商品', 'FUT', 'BZ=F'],
  'NG=F': ['天然ガス先物（ドル/百万BTU）', '天然ガス ガス LNG NaturalGas コモディティ 商品', 'FUT', 'NG=F'],
  'RB=F': ['ガソリン先物（ドル/ガロン）', 'ガソリン Gasoline コモディティ 商品', 'FUT', 'RB=F'],
  'HO=F': ['ヒーティングオイル先物（灯油・ドル/ガロン）', 'ヒーティングオイル 灯油 暖房油 HeatingOil コモディティ 商品', 'FUT', 'HO=F'],
  'ZC=F': ['トウモロコシ先物（¢/ブッシェル）', 'トウモロコシ コーン とうもろこし Corn 穀物 コモディティ 商品', 'FUT', 'ZC=F'],
  'ZW=F': ['小麦先物（シカゴ・¢/ブッシェル）', '小麦 コムギ Wheat 穀物 コモディティ 商品', 'FUT', 'ZW=F'],
  'KE=F': ['小麦先物（カンザス・¢/ブッシェル）', '小麦 カンザス KCWheat 穀物 コモディティ 商品', 'FUT', 'KE=F'],
  'ZS=F': ['大豆先物（¢/ブッシェル）', '大豆 ダイズ Soybean 穀物 コモディティ 商品', 'FUT', 'ZS=F'],
  'ZM=F': ['大豆ミール先物（ドル/ショートトン）', '大豆ミール 大豆粕 SoybeanMeal 穀物 コモディティ 商品', 'FUT', 'ZM=F'],
  'ZL=F': ['大豆油先物（¢/ポンド）', '大豆油 SoybeanOil 穀物 コモディティ 商品', 'FUT', 'ZL=F'],
  'ZO=F': ['オーツ麦先物（¢/ブッシェル）', 'オーツ麦 えん麦 燕麦 Oats 穀物 コモディティ 商品', 'FUT', 'ZO=F'],
  'ZR=F': ['米先物（ラフライス・ドル/ハンドレッドウェイト）', '米 コメ お米 ラフライス RoughRice 穀物 コモディティ 商品', 'FUT', 'ZR=F'],
  'KC=F': ['コーヒー先物（¢/ポンド）', 'コーヒー Coffee ソフト コモディティ 商品', 'FUT', 'KC=F'],
  'SB=F': ['砂糖先物（¢/ポンド）', '砂糖 シュガー Sugar ソフト コモディティ 商品', 'FUT', 'SB=F'],
  'CC=F': ['ココア先物（ドル/トン）', 'ココア カカオ Cocoa ソフト コモディティ 商品', 'FUT', 'CC=F'],
  'CT=F': ['綿花先物（¢/ポンド）', '綿花 コットン 綿 Cotton ソフト コモディティ 商品', 'FUT', 'CT=F'],
  'OJ=F': ['オレンジジュース先物（¢/ポンド）', 'オレンジジュース オレンジ OrangeJuice ソフト コモディティ 商品', 'FUT', 'OJ=F'],
  'LE=F': ['生牛先物（¢/ポンド）', '生牛 牛 牛肉 ライブキャトル LiveCattle 畜産 コモディティ 商品', 'FUT', 'LE=F'],
  'GF=F': ['肥育牛先物（¢/ポンド）', '肥育牛 牛 フィーダーキャトル FeederCattle 畜産 コモディティ 商品', 'FUT', 'GF=F'],
  'HE=F': ['豚先物（赤身豚・¢/ポンド）', '豚 豚肉 リーンホッグ LeanHog 畜産 コモディティ 商品', 'FUT', 'HE=F'],
  '^SPGSCI': ['S&P GSCI 商品指数', 'GSCI 商品指数 コモディティ指数 コモディティ 商品', 'FUT', '^SPGSCI'],
  'DX-Y.NYB': ['ドル指数（ドルインデックス）', 'ドル指数 ドルインデックス DXY 為替', 'FX', 'DX-Y.NYB'],
};
export const isIndex = (code) => Object.prototype.hasOwnProperty.call(INDICES, code);
// コモディティ（商品先物・商品指数）
export const COMMODITIES = new Set(['GC=F', 'SI=F', 'PL=F', 'PA=F', 'HG=F', 'ALI=F', 'TIO=F', 'UX=F', 'CL=F', 'BZ=F', 'NG=F', 'RB=F', 'HO=F',
  'ZC=F', 'ZW=F', 'KE=F', 'ZS=F', 'ZM=F', 'ZL=F', 'ZO=F', 'ZR=F', 'KC=F', 'SB=F', 'CC=F', 'CT=F', 'OJ=F', 'LE=F', 'GF=F', 'HE=F', '^SPGSCI']);
/* 銘柄の分類（順番設定の「種類別」で使う）：
   jp 日本株 → us 米国株 → idx 指数 → fut 株価指数先物 → cmd コモディティ → fx 為替 → crypto 暗号資産 */
export const CATEGORY_ORDER = ['jp', 'us', 'idx', 'fut', 'cmd', 'fx', 'crypto'];
export function categoryOf(code) {
  if (!isIndex(code)) return isUS(code) ? 'us' : 'jp';
  if (COMMODITIES.has(code)) return 'cmd';
  const s = INDICES[code][2];
  return s === 'FUT' ? 'fut' : s === 'FX' ? 'fx' : s === 'C' ? 'crypto' : 'idx';
}
// 市場の区分（米国株は英字で始まる。指数・為替などは除く）
export const isUS = (code) => /^[A-Z]/.test(code) && !isIndex(code);
/* 銘柄ごとの取引時間の種類を個別に変えたいときは、ここに書く（例：'7203': 'JP'、'ABCD': 'C'）。
   ここに無い銘柄は、指数・為替は上の INDICES の種類、米国株は US、日本株は JP。 */
export const SESSION_OVERRIDES = {};
// 取引時間の判定に使う種類：JP・US・各国の指数（HK など）・FX・FUT・C
export const marketOfCode = (code) => SESSION_OVERRIDES[code] || (isIndex(code) ? INDICES[code][2] : isUS(code) ? 'US' : 'JP');
// Yahoo に問い合わせるときのシンボル（日本株は .T を付ける）
export const yahooSymbol = (code) => (isIndex(code) || isUS(code) ? code : `${code}.T`);
// Yahoo!ファイナンス（日本）のページ
export const yahooJpUrl = (code) => `https://finance.yahoo.co.jp/quote/${encodeURIComponent(isIndex(code) ? INDICES[code][3] : yahooSymbol(code))}`;
export const JP_RE = /^[0-9][0-9A-Z]{3}$/;
export const US_RE = /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/;

import { US, US_TOP } from './us-names.js?v=20261127164219';

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
    const cat = categoryOf(code);
    const market = { cmd: '商品', fut: '先物', fx: '為替', crypto: '暗号資産' }[cat] || '指数';
    rows.push({ code, name, market, size: 0, rank: 0, k: norm(name), r: [norm(code), ...alt.split(' ').map(norm)], minor: false });
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
    jpLoading = fetch('data/jp-stocks.json?v=20261127164219')
      .then((r) => r.json())
      .then((j) => { jp = j.list; buildIndex(); return jp; })
      .catch(() => { jpLoading = null; return {}; });
  }
  return jpLoading;
}
export const dictReady = () => !!index;

// 並べ替え（名前順）用の読み。日本株は辞書の読み（カタカナ）、それ以外は表示名
export function readingOf(code, name) {
  if (!isIndex(code) && !isUS(code)) {
    const r = jp?.[code];
    if (r && (!name || name === r[0])) return (r[2] || '').split('|')[0] || r[0];
  }
  return name || lookupName(code) || code;
}

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

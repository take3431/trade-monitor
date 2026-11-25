// 銘柄名辞書
//  - 日本株：JPX（日本取引所グループ）公表の上場銘柄一覧から作成した data/jp-stocks.json（約4,400銘柄）
//  - 米国株：よく取引される銘柄の日本語名（それ以外は Yahoo の検索結果の英語名）

// 市場の区分（米国株は英字で始まる）
export const isUS = (code) => /^[A-Z]/.test(code);
export const JP_RE = /^[0-9][0-9A-Z]{3}$/;
export const US_RE = /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/;

export const US_NAMES = {
  AAPL: 'アップル', MSFT: 'マイクロソフト', NVDA: 'エヌビディア', AMZN: 'アマゾン・ドット・コム',
  GOOGL: 'アルファベット（クラスA）', GOOG: 'アルファベット（クラスC）', META: 'メタ・プラットフォームズ',
  TSLA: 'テスラ', AVGO: 'ブロードコム', 'BRK-B': 'バークシャー・ハサウェイ（クラスB）', JPM: 'JPモルガン・チェース',
  V: 'ビザ', MA: 'マスターカード', UNH: 'ユナイテッドヘルス・グループ', XOM: 'エクソンモービル',
  JNJ: 'ジョンソン・エンド・ジョンソン', WMT: 'ウォルマート', PG: 'プロクター・アンド・ギャンブル', HD: 'ホーム・デポ',
  COST: 'コストコ・ホールセール', LLY: 'イーライリリー', ABBV: 'アッヴィ', MRK: 'メルク', PFE: 'ファイザー',
  KO: 'コカ・コーラ', PEP: 'ペプシコ', MCD: 'マクドナルド', NKE: 'ナイキ', DIS: 'ウォルト・ディズニー',
  NFLX: 'ネットフリックス', ADBE: 'アドビ', CRM: 'セールスフォース', ORCL: 'オラクル', CSCO: 'シスコシステムズ',
  INTC: 'インテル', AMD: 'アドバンスト・マイクロ・デバイセズ', QCOM: 'クアルコム', TXN: 'テキサス・インスツルメンツ',
  MU: 'マイクロン・テクノロジー', AMAT: 'アプライド・マテリアルズ', LRCX: 'ラムリサーチ', ASML: 'ASMLホールディング',
  TSM: '台湾セミコンダクター（TSMC）', ARM: 'アーム・ホールディングス', PLTR: 'パランティア・テクノロジーズ',
  SMCI: 'スーパー・マイクロ・コンピューター', IBM: 'IBM', UBER: 'ウーバー・テクノロジーズ', ABNB: 'エアビーアンドビー',
  SHOP: 'ショッピファイ', PYPL: 'ペイパル', COIN: 'コインベース・グローバル', BAC: 'バンク・オブ・アメリカ',
  WFC: 'ウェルズ・ファーゴ', GS: 'ゴールドマン・サックス', MS: 'モルガン・スタンレー', C: 'シティグループ',
  AXP: 'アメリカン・エキスプレス', BA: 'ボーイング', CAT: 'キャタピラー', GE: 'GEエアロスペース', HON: 'ハネウェル',
  LMT: 'ロッキード・マーチン', DE: 'ディア', UPS: 'UPS', F: 'フォード・モーター', GM: 'ゼネラル・モーターズ',
  SBUX: 'スターバックス', CVX: 'シェブロン', T: 'AT&T', VZ: 'ベライゾン', TMUS: 'Tモバイル',
  BABA: 'アリババ・グループ', NVO: 'ノボ・ノルディスク', ISRG: 'インテュイティブサージカル', NOW: 'サービスナウ',
  INTU: 'インテュイット', PANW: 'パロアルトネットワークス', CRWD: 'クラウドストライク', SNOW: 'スノーフレーク',
  DELL: 'デル・テクノロジーズ', BKNG: 'ブッキング・ホールディングス', ANET: 'アリスタネットワークス',
  MRVL: 'マーベル・テクノロジー', SPOT: 'スポティファイ', RBLX: 'ロブロックス', HOOD: 'ロビンフッド',
  SOFI: 'ソーファイ・テクノロジーズ', LULU: 'ルルレモン', MO: 'アルトリア・グループ', PM: 'フィリップ・モリス',
  ABT: 'アボット・ラボラトリーズ', TMO: 'サーモフィッシャーサイエンティフィック', AMGN: 'アムジェン', GILD: 'ギリアド・サイエンシズ',
  O: 'リアルティ・インカム', BLK: 'ブラックロック', NEE: 'ネクステラ・エナジー',
  SPY: 'SPDR S&P500 ETF', VOO: 'バンガード S&P500 ETF', VTI: 'バンガード・トータル・ストック・マーケットETF',
  QQQ: 'インベスコQQQ（ナスダック100）', DIA: 'SPDR ダウ工業株平均ETF', IWM: 'iシェアーズ ラッセル2000 ETF',
  TQQQ: 'プロシェアーズ ウルトラプロQQQ', SOXL: 'Direxion 半導体ブル3倍ETF', SOXX: 'iシェアーズ 半導体ETF',
  VYM: 'バンガード 米国高配当株ETF', HDV: 'iシェアーズ コア米国高配当株ETF', SPYD: 'SPDR S&P500高配当株ETF',
  GLD: 'SPDR ゴールド・シェア', TLT: 'iシェアーズ 米国国債20年超ETF',
};

const MARKET_LABEL = { P: 'プライム', S: 'スタンダード', G: 'グロース', E: 'ETF・ETN', R: 'REIT等', PRO: 'PRO', O: '出資証券' };

let jp = null;
let jpLoading = null;
export function loadDict() {
  if (jp) return Promise.resolve(jp);
  if (!jpLoading) {
    jpLoading = fetch('data/jp-stocks.json', { cache: 'force-cache' })
      .then((r) => r.json())
      .then((j) => { jp = j.list; return jp; })
      .catch(() => { jpLoading = null; return {}; });
  }
  return jpLoading;
}

export function lookupName(code) {
  if (isUS(code)) return US_NAMES[code] || '';
  return jp?.[code]?.[0] || '';
}

// 全角・半角、ひらがな・カタカナの違いを吸収して比較する
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const norm = (s) => toKata(String(s).normalize('NFKC').toUpperCase()).replace(/[\s・･.\-()（）]/g, '');

export async function searchLocal(q) {
  await loadDict();
  const n = norm(q);
  if (!n) return [];
  const hits = [];
  const push = (code, name, market, score) => hits.push({ code, name, market, score });
  for (const [code, [name, m]] of Object.entries(jp || {})) {
    const k = norm(name);
    if (code === n || k === n) push(code, name, MARKET_LABEL[m] || '東証', 0);
    else if (code.startsWith(n)) push(code, name, MARKET_LABEL[m] || '東証', 1);
    else {
      if (k.startsWith(n)) push(code, name, MARKET_LABEL[m] || '東証', 2);
      else if (k.includes(n)) push(code, name, MARKET_LABEL[m] || '東証', 3);
    }
  }
  for (const [code, name] of Object.entries(US_NAMES)) {
    const k = norm(name);
    if (norm(code) === n || k === n) push(code, name, '米国', 0);
    else if (norm(code).startsWith(n)) push(code, name, '米国', 1);
    else if (k.startsWith(n)) push(code, name, '米国', 2);
    else if (k.includes(n)) push(code, name, '米国', 3);
  }
  // ETF・PRO などより一般の株式を上に
  const rank = (h) => h.score * 10 + (/ETF|PRO|REIT|出資/.test(h.market) ? 5 : 0);
  return hits.sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code)).slice(0, 30);
}

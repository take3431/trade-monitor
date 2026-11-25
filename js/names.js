// 銘柄名辞書
//  - 日本株：JPX（日本取引所グループ）公表の上場銘柄一覧から作成した data/jp-stocks.json（約4,400銘柄）
//  - 米国株：よく取引される銘柄の日本語名（それ以外は Yahoo の検索結果の英語名）

// 市場の区分（米国株は英字で始まる）
export const isUS = (code) => /^[A-Z]/.test(code);
export const JP_RE = /^[0-9][0-9A-Z]{3}$/;
export const US_RE = /^[A-Z][A-Z0-9]{0,5}(-[A-Z])?$/;

import { US } from './us-names.js?v=20261125135012';

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
function buildIndex() {
  const rows = [];
  for (const [code, [name, m, rd, size = 5]] of Object.entries(jp || {})) {
    const market = MARKET_LABEL[m] || '東証';
    rows.push({ code, name, market, size, k: norm(name), r: (rd || '').split('|').map(norm), minor: /ETF|PRO|REIT|出資/.test(market) });
  }
  for (const [code, [name, en]] of Object.entries(US)) {
    const etf = /ETF|SPDR|ファンド|トラスト/.test(name);
    rows.push({ code, name, market: etf ? '米国ETF' : '米国', size: 1, k: norm(name), r: [norm(code), norm(en)], minor: false });
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
    jpLoading = fetch('data/jp-stocks.json?v=20261125135012')
      .then((r) => r.json())
      .then((j) => { jp = j.list; buildIndex(); return jp; })
      .catch(() => { jpLoading = null; return {}; });
  }
  return jpLoading;
}
export const dictReady = () => !!index;

export function lookupName(code) {
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
    hits.push({ code: x.code, name: x.name, market: x.market, size: x.size, score: score * 10 + (x.minor ? 5 : 0) });
  }
  // 同じ一致度なら、規模の大きい会社（TOPIX Core30 → Large70 → Mid400 → …）、次に社名の短いものを上に
  hits.sort((a, b) => a.score - b.score || a.size - b.size || a.name.length - b.name.length || a.code.localeCompare(b.code));
  return hits.slice(0, limit);
}

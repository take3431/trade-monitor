// 表示レイヤー（ステージ）とチャート描画
// ステージを2枚重ねておき、非表示側に描画してから切り替えることでチラつきを防ぐ。
import { TF } from './data.js?v=20261125121301';
import { fmtStamp } from './market.js?v=20261125121301';

const LC = window.LightweightCharts;
const JST = 9 * 3600;

export const fmtPrice = (p) => {
  if (p == null || Number.isNaN(p)) return '—';
  const dec = Math.round(Math.abs(p) * 10) % 10 !== 0 ? 1 : 0;
  return p.toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
export const fmtSigned = (v, digits) => {
  if (v == null || Number.isNaN(v)) return '—';
  const s = digits == null ? fmtPrice(Math.abs(v)) : Math.abs(v).toFixed(digits);
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + s;
};
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
export function themeColors() {
  return {
    bg: cssVar('--chart-bg'), text: cssVar('--chart-text'), grid: cssVar('--chart-grid'),
    border: cssVar('--border'), up: cssVar('--up'), down: cssVar('--down'),
    ma1: cssVar('--ma1'), ma2: cssVar('--ma2'), bb: cssVar('--bb'), cross: cssVar('--muted'),
  };
}
const alpha = (hex, a) => {
  const m = hex.replace('#', '');
  if (m.length !== 6) return hex;
  const n = parseInt(m, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

function sma(bars, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}
function bollinger(bars, n = 20, k = 2) {
  const up = [], mid = [], lo = [];
  for (let i = n - 1; i < bars.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += bars[j].close;
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
    const sd = Math.sqrt(v / n);
    const t = bars[i].time;
    up.push({ time: t, value: m + k * sd }); mid.push({ time: t, value: m }); lo.push({ time: t, value: m - k * sd });
  }
  return { up, mid, lo };
}

const pad = (n) => String(n).padStart(2, '0');
function tickFmt(time, type) {
  const d = new Date(time * 1000);
  switch (type) {
    case 0: return `${d.getUTCFullYear()}`;
    case 1: return `${d.getUTCMonth() + 1}月`;
    case 2: return `${d.getUTCDate()}`;
    default: return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}

class Pane {
  constructor(card) {
    this.card = card;
    this.box = card.querySelector('.chart-box');
    this.titleEl = card.querySelector('.chart-title');
    this.legend = card.querySelector('.legend');
    this.msg = card.querySelector('.pane-msg');
    this.chart = null;
    this.tf = null;
    this.code = null;
  }

  build(ind, c) {
    if (this.chart) this.chart.remove();
    this.box.querySelector('.lc')?.remove();
    const host = document.createElement('div');
    host.className = 'lc';
    this.box.prepend(host);
    this.ind = ind;
    this.colors = c;
    const ch = LC.createChart(host, {
      autoSize: true,
      layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontSize: 11,
        fontFamily: '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif' },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: ind.vol ? 0.24 : 0.06 } },
      timeScale: { borderColor: c.border, rightOffset: 3, tickMarkFormatter: tickFmt, lockVisibleTimeRangeOnResize: true },
      crosshair: { mode: 0, vertLine: { color: c.cross }, horzLine: { color: c.cross } },
      localization: {
        locale: 'ja-JP', priceFormatter: (p) => (p < 0 ? '' : fmtPrice(p)),
        timeFormatter: (t) => {
          const d = new Date(t * 1000);
          const s = `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
          return this.tf === '5m' ? `${s} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : s;
        },
      },
    });
    this.chart = ch;
    this.s = {};
    if (ind.vol) {
      this.s.vol = ch.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    if (ind.bb) {
      const o = { color: c.bb, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      this.s.bbU = ch.addLineSeries(o);
      this.s.bbM = ch.addLineSeries({ ...o, lineStyle: 2 });
      this.s.bbL = ch.addLineSeries(o);
    }
    this.s.candle = ch.addCandlestickSeries({
      upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
      wickUpColor: c.up, wickDownColor: c.down, priceLineVisible: true, lastValueVisible: true,
    });
    if (ind.ma) {
      const o = { lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
      this.s.ma1 = ch.addLineSeries({ ...o, color: c.ma1 });
      this.s.ma2 = ch.addLineSeries({ ...o, color: c.ma2 });
    }
    ch.subscribeCrosshairMove((p) => this.updateLegend(p));
    this.tf = null;
    this.code = null;
  }

  setData(entry, tf, label, visibleBars, keepRange, loading = false) {
    const t = TF[tf];
    this.titleEl.textContent = t.title;
    const raw = entry?.bars || [];
    const bars = raw.map((b) => ({ time: b[0] + JST, open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] }));
    this.bars = bars;
    this.label = `${label}, ${t.short}, ${this.exch || 'TSE'}`;
    this.maLen = t.ma;
    this.msg.hidden = bars.length > 0;
    this.msg.textContent = loading ? 'チャートデータ読込中…' : 'チャートデータ未取得（自動で再取得します）';
    this.chart.applyOptions({ timeScale: { timeVisible: tf === '5m', secondsVisible: false } });

    const s = this.s;
    s.candle.setData(bars);
    if (s.vol) {
      const up = alpha(this.colors.up, 0.45), dn = alpha(this.colors.down, 0.45);
      s.vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? up : dn })));
    }
    this.ma = null;
    if (s.ma1) {
      const m1 = sma(bars, t.ma[0]), m2 = sma(bars, t.ma[1]);
      s.ma1.setData(m1); s.ma2.setData(m2);
      this.ma = [new Map(m1.map((x) => [x.time, x.value])), new Map(m2.map((x) => [x.time, x.value]))];
    }
    if (s.bbU) {
      const b = bollinger(bars);
      s.bbU.setData(b.up); s.bbM.setData(b.mid); s.bbL.setData(b.lo);
    }

    const sameView = keepRange && this.hadBars && this.tf === tf && this.code === label;
    if (!sameView) this.resetView();
    if (!sameView && bars.length) {
      const n = bars.length;
      if (visibleBars > 0 && n > visibleBars) this.chart.timeScale().setVisibleLogicalRange({ from: n - visibleBars, to: n + 2 });
      else this.chart.timeScale().fitContent();
    }
    this.tf = tf;
    this.code = label;
    this.hadBars = bars.length > 0;
    this.updateLegend(null);
  }

  // 拡大・縮小・スクロールした状態を初期状態に戻す（価格軸の自動調整も元に戻す）
  resetView() {
    if (!this.chart) return;
    this.chart.priceScale('right').applyOptions({ autoScale: true });
    if (this.s.vol) this.chart.priceScale('vol').applyOptions({ autoScale: true });
    this.chart.timeScale().applyOptions({ rightOffset: 3 });
    this.chart.clearCrosshairPosition?.();
  }

  updateLegend(p) {
    if (!this.bars) return;
    let bar = null;
    if (p && p.time != null && p.seriesData) bar = p.seriesData.get(this.s.candle);
    if (!bar) bar = this.bars[this.bars.length - 1];
    // 表示名は利用者が入力・貼り付けできるので、HTML として解釈させない
    let html = `<span class="lg-t">${escHtml(this.label)}</span>`;
    if (bar) {
      html += `<span class="lg-o">始 ${fmtPrice(bar.open)} 高 ${fmtPrice(bar.high)} 安 ${fmtPrice(bar.low)} 終 <b class="${dirClass(bar.close - bar.open)}">${fmtPrice(bar.close)}</b></span>`;
      if (this.ma) {
        const v1 = this.ma[0].get(bar.time), v2 = this.ma[1].get(bar.time);
        html += `<span class="lg-ma1">MA${this.maLen[0]} ${fmtPrice(v1 != null ? Math.round(v1 * 10) / 10 : null)}</span>`;
        html += `<span class="lg-ma2">MA${this.maLen[1]} ${fmtPrice(v2 != null ? Math.round(v2 * 10) / 10 : null)}</span>`;
      }
      if (this.s.bbU) html += '<span class="lg-bb">BB(20,2σ)</span>';
    }
    this.legend.innerHTML = html;
  }
}

const STAGE_HTML = `
  <section class="sym-head">
    <div class="sym-id">
      <div class="sym-title"><span class="sym-code"></span><a class="sym-name" target="_blank" rel="noopener noreferrer"></a>
        <span class="sym-quote"><span class="q-price"></span><span class="q-chg"></span></span></div>
    </div>
    <div class="sym-meta"><div class="sym-pos"></div><div class="sym-time"></div></div>
  </section>
  <section class="charts">
    ${['L', 'R'].map((s) => `
    <div class="chart-card" data-side="${s}">
      <div class="chart-title"></div>
      <div class="chart-box"><div class="legend"></div><div class="pane-msg" hidden>チャートデータ未取得（通信回復後に自動で再取得します）</div></div>
    </div>`).join('')}
  </section>`;

// Yahoo!ファイナンス（日本）の銘柄ページ。日本株は「7203.T」、米国株はティッカーのまま
function yahooJpUrl(code) {
  const sym = /^[A-Z]/.test(code) ? code : `${code}.T`;
  return `https://finance.yahoo.co.jp/quote/${encodeURIComponent(sym)}`;
}

export class Stage {
  constructor(root) {
    this.root = root;
    root.className = 'stage';
    root.innerHTML = STAGE_HTML;
    const $ = (s) => root.querySelector(s);
    this.el = {
      code: $('.sym-code'), name: $('.sym-name'), pos: $('.sym-pos'),
      time: $('.sym-time'), title: $('.sym-title'), qPrice: $('.q-price'), qChg: $('.q-chg'), quote: $('.sym-quote'),
    };
    this.panes = [...root.querySelectorAll('.chart-card')].map((c) => new Pane(c));
    this.code = null;
  }

  // 銘柄名が長くて株価と重なる場合だけ、銘柄名の文字を小さくする（最小で元の55%）
  fitTitle() {
    const { title, name } = this.el;
    name.style.fontSize = '';
    if (!title.clientWidth) return; // 非表示中は測れないので、表示時に再調整
    let scale = 1;
    const over = () => title.scrollWidth > title.clientWidth + 1 || name.scrollWidth > name.clientWidth + 1;
    while (over() && scale > 0.55) {
      scale -= 0.05;
      name.style.fontSize = `${scale.toFixed(2)}em`;
    }
  }

  build(ind, colors) {
    this.panes.forEach((p) => p.build(ind, colors));
    this.code = null;
  }

  render(item, entries, settings, { pos = '', keepRange = false, loading = false } = {}) {
    const e = this.el;
    this.code = item.code;
    this.entries = entries;
    e.code.textContent = item.code;
    e.name.textContent = item.name || '';
    // 銘柄名を押すと Yahoo!ファイナンス（日本）の銘柄ページを新しいタブで開く
    e.name.href = yahooJpUrl(item.code);
    e.name.title = 'Yahoo!ファイナンスで開く';
    // 現在値と前日比（日本式：上昇＝赤、下落＝緑。設定で逆にできる）
    const q = entries.quote;
    const isUs = /^[A-Z]/.test(item.code);
    const money = (v) => (isUs
      ? 'US$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : fmtPrice(v) + '円');
    const sign = (v) => (v > 0 ? '+' : v < 0 ? '\u2212' : '\u00b1');
    const signed = (v) => (isUs ? sign(v) + Math.abs(v).toFixed(2) : fmtSigned(v));
    e.quote.hidden = !q || q.price == null;
    if (q && q.price != null) {
      const d = dirClass(q.chg);
      e.qPrice.textContent = money(q.price);
      e.qChg.textContent = q.chg == null ? '' : signed(q.chg) + ' (' + fmtSigned(q.pct, 2) + '%)';
      e.qChg.className = 'q-chg ' + d;
      e.qPrice.className = 'q-price ' + d;
    }
    e.pos.textContent = pos;
    // データの時刻：Yahoo が返す最終約定時刻（東証は約20分遅れ）。無ければ取得時刻から遅延分を引く
    const last = entries[settings.leftTf] || entries[settings.rightTf];
    const us = /^[A-Z]/.test(item.code);
    const asOf = last?.meta?.time ? last.meta.time * 1000 : last?.fetchedAt ? last.fetchedAt - (us ? 0 : 20 * 60e3) : 0;
    e.time.textContent = asOf ? fmtStamp(asOf) : '';
    this.panes.forEach((p) => { p.exch = us ? 'US' : 'TSE'; });
    this.fitTitle();
    const label = `${item.code} ${item.name || ''}`.trim();
    this.panes[0].setData(entries[settings.leftTf], settings.leftTf, label, settings.leftBars, keepRange, loading);
    this.panes[1].setData(entries[settings.rightTf], settings.rightTf, label, settings.rightBars, keepRange, loading);
  }
}

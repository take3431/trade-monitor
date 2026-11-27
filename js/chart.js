// 表示レイヤー（ステージ）とチャート描画
// ステージを2枚重ねておき、非表示側に描画してから切り替えることでチラつきを防ぐ。
import { TF } from './data.js?v=20261127172538';
import { isUS, isIndex, yahooJpUrl } from './names.js?v=20261127172538';
import { smallDigits } from './alerts.js?v=20261127172538';
import { fmtStamp } from './market.js?v=20261127172538';

const LC = window.LightweightCharts;
const JST = 9 * 3600;

export const fmtPrice = (p, ref = p) => {
  if (p == null || Number.isNaN(p)) return '—';
  if (ref && Math.abs(ref) < 1) { const d = smallDigits(ref); return p.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  const dec = Math.round(Math.abs(p) * 10) % 10 !== 0 ? 1 : 0;
  return p.toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
export const fmtSigned = (v, digits, ref = v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const s = digits == null ? fmtPrice(Math.abs(v), ref) : Math.abs(v).toFixed(digits);
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
    ma1: cssVar('--ma1'), ma2: cssVar('--ma2'), ma3: cssVar('--ma3'), bb: cssVar('--bb'), cross: cssVar('--muted'),
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

// 保存データ → チャート用の足。数値でない値の足と、時刻が前の足以下の足（重複・逆順）は除く
// （Lightweight Charts は時刻の重複・逆順があると例外を出してチャートが描けなくなるため）
function toLcBars(raw) {
  const out = [];
  let prev = -Infinity;
  for (const b of raw) {
    if (!b || !Number.isFinite(b[0]) || ![b[1], b[2], b[3], b[4]].every(Number.isFinite)) continue;
    const time = b[0] + JST;
    const bar = { time, open: b[1], high: b[2], low: b[3], close: b[4], volume: Number.isFinite(b[5]) ? b[5] : 0 };
    if (time > prev) { out.push(bar); prev = time; } else if (time === prev) out[out.length - 1] = bar; // 同じ時刻は新しい方
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');
function priceFormatOf(bars) {
  const last = bars.length ? bars[bars.length - 1].close : 1;
  const d = smallDigits(last);
  return { type: 'price', precision: d, minMove: 10 ** -d };
}
function tickFmt(time, type) {
  const d = new Date(time * 1000);
  switch (type) {
    case 0: return `${d.getUTCFullYear()}`;
    case 1: return `${d.getUTCMonth() + 1}月`;
    case 2: return `${d.getUTCDate()}`;
    default: return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}

// テクニカル指標の設定（移動平均の期間・ボリンジャーバンドの期間とσ）
// 移動平均は短期・中期・長期の3本（既定は短期と中期を表示。中期・長期の色は ma2・ma3）
export const TA_DEFAULT = {
  ma: { '5m': [5, 25, 75], '1d': [5, 25, 75], '1wk': [13, 26, 52], '1mo': [12, 24, 60] },
  maOn: [true, true, false],
  bb: { n: 20, k: 2 },
};
const taOf = (ta, tf) => ({ ma: ta?.ma?.[tf] || TA_DEFAULT.ma[tf], on: ta?.maOn || TA_DEFAULT.maOn, bb: ta?.bb || TA_DEFAULT.bb });
const MA_CLS = ['lg-ma1', 'lg-ma2', 'lg-ma3'];

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
    this.pf = null;
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
      this.s.ma = [c.ma1, c.ma2, c.ma3].map((color) => ch.addLineSeries({ ...o, color }));
    }
    ch.subscribeCrosshairMove((p) => this.updateLegend(p));
    this.tf = null;
    this.code = null;
  }

  setData(entry, tf, label, visibleBars, keepRange, loading = false, ta = null) {
    const t = TF[tf];
    const p = taOf(ta, tf);
    const taKey = `${p.ma.join(',')}|${p.on.join(',')}|${p.bb.n},${p.bb.k}`;
    this.titleEl.textContent = t.title;
    const raw = entry?.bars || [];
    this.msg.hidden = raw.length > 0;
    this.msg.textContent = loading ? 'チャートデータ読込中…' : 'チャートデータ未取得（自動で再取得します）';
    // 同じ銘柄・同じ足種・同じデータなら、描き直さずに表示範囲だけ整える（切替のたびの無駄な計算を省く）
    if (raw.length && raw === this.raw && this.tf === tf && this.code === label && this.taKey === taKey) {
      if (!keepRange) {
        this.resetView();
        const n = this.bars.length;
        if (visibleBars > 0 && n > visibleBars) this.chart.timeScale().setVisibleLogicalRange({ from: n - visibleBars, to: n + 2 });
        else this.chart.timeScale().fitContent();
      }
      this.updateLegend(null);
      return;
    }
    this.raw = raw;
    this.taKey = taKey;
    this.bb = p.bb;
    const bars = toLcBars(raw);
    this.bars = bars;
    this.label = `${label}, ${t.short}, ${this.exch || 'TSE'}`;
    this.maLen = p.ma;
    this.maOn = p.on;
    this.chart.applyOptions({ timeScale: { timeVisible: tf === '5m', secondsVisible: false } });

    const s = this.s;
    // 1未満の値（暗号資産など）は、価格の刻みを細かくする（既定の0.01刻みだと値動きが描けない）
    const pf = priceFormatOf(bars);
    if (this.pf !== pf.precision) {
      this.pf = pf.precision;
      [s.candle, ...(s.ma || []), s.bbU, s.bbM, s.bbL].forEach((x) => x?.applyOptions({ priceFormat: pf }));
    }
    s.candle.setData(bars);
    if (s.vol) {
      const up = alpha(this.colors.up, 0.45), dn = alpha(this.colors.down, 0.45);
      s.vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? up : dn })));
    }
    this.ma = null;
    if (s.ma) {
      // 表示しない線は計算もしない
      this.ma = s.ma.map((line, i) => {
        const d = p.on[i] ? sma(bars, p.ma[i]) : [];
        line.setData(d);
        return p.on[i] ? new Map(d.map((x) => [x.time, x.value])) : null;
      });
    }
    if (s.bbU) {
      const b = bollinger(bars, p.bb.n, p.bb.k);
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
        this.ma.forEach((m, i) => {
          if (!m) return;
          const v = m.get(bar.time);
          html += `<span class="${MA_CLS[i]}">MA${this.maLen[i]} ${fmtPrice(v != null && Math.abs(v) >= 1 ? Math.round(v * 10) / 10 : v)}</span>`;
        });
      }
      if (this.s.bbU) html += `<span class="lg-bb">BB(${this.bb?.n ?? 20},${this.bb?.k ?? 2}σ)</span>`;
    }
    this.legend.innerHTML = html;
  }
}

const STAGE_HTML = `
  <section class="sym-head">
    <div class="sym-id">
      <div class="sym-title"><span class="sym-code"></span><a class="sym-name" target="_blank" rel="noopener noreferrer"></a>
        <span class="sym-quote"><span class="q-price"></span><span class="q-chg"></span><span class="q-flag" hidden></span></span></div>
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


export class Stage {
  constructor(root) {
    this.root = root;
    root.className = 'stage';
    root.innerHTML = STAGE_HTML;
    const $ = (s) => root.querySelector(s);
    this.el = {
      code: $('.sym-code'), name: $('.sym-name'), pos: $('.sym-pos'),
      time: $('.sym-time'), title: $('.sym-title'), qPrice: $('.q-price'), qChg: $('.q-chg'), qFlag: $('.q-flag'), quote: $('.sym-quote'),
    };
    this.panes = [...root.querySelectorAll('.chart-card')].map((c) => new Pane(c));
    this.code = null;
  }

  // 銘柄名が長くて株価と重なる場合だけ、銘柄名の文字を小さくする（最小で元の55%）
  fitTitle() {
    const { title, name, qChg, qFlag } = this.el;
    name.style.fontSize = '';
    qChg.style.fontSize = '';
    qFlag.style.fontSize = '';
    if (!title.clientWidth) return; // 非表示中は測れないので、表示時に再調整
    let scale = 1;
    const over = () => title.scrollWidth > title.clientWidth + 1 || name.scrollWidth > name.clientWidth + 1;
    while (over() && scale > 0.55) {
      scale -= 0.05;
      name.style.fontSize = `${scale.toFixed(2)}em`;
    }
    // 銘柄名を小さくしても右の「何銘柄目・時刻」とぶつかるときは、前日比と「高」「安」も小さくする（現在値はそのまま）
    let q = 1;
    while (over() && q > 0.6) {
      q -= 0.05;
      qChg.style.fontSize = `${(1.6 * q).toFixed(2)}rem`;
      qFlag.style.fontSize = `${(1.1 * q).toFixed(2)}rem`;
    }
  }

  build(ind, colors) {
    this.panes.forEach((p) => p.build(ind, colors));
    this.code = null;
  }

  // status：{ state: 'ok' | 'pending'（今日のデータ待ち。前日比を「−」） | 'special'（特別気配の可能性。「特」）, limit: 'high' | 'low' | null }
  render(item, entries, settings, { pos = '', keepRange = false, loading = false, status = null } = {}) {
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
    const isUs = isUS(item.code);
    const idx = isIndex(item.code);
    const dec2 = (v, ref = v) => { const d = smallDigits(ref); return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
    // 指数・為替は単位を付けない（小数2桁）
    const money = (v) => (isUs ? 'US$' + dec2(v) : idx ? dec2(v) : fmtPrice(v) + '円');
    const sign = (v) => (v > 0 ? '+' : v < 0 ? '\u2212' : '\u00b1');
    const signed = (v) => (isUs || idx ? sign(v) + dec2(Math.abs(v), q.price) : fmtSigned(v, null, q.price)); // 桁数は株価に合わせる
    e.quote.hidden = !q || q.price == null;
    e.qFlag.hidden = true;
    if (q && q.price != null) {
      const state = status?.state || 'ok';
      const waiting = state === 'pending' || state === 'special';
      const d = waiting ? 'flat' : dirClass(q.chg);
      e.qPrice.textContent = money(q.price);
      if (state === 'pending') {
        e.qChg.textContent = '\u2212';
        e.qChg.title = '取引が始まり、今日の株価が届くのを待っています（東証は約20分遅れ）';
      } else if (state === 'special') {
        e.qChg.textContent = '特';
        e.qChg.title = 'ほかの銘柄には今日の取引があるのに、この銘柄はまだ取引が成立していません（特別気配・売買停止の可能性）';
      } else {
        e.qChg.textContent = q.chg == null ? '' : signed(q.chg) + ' (' + fmtSigned(q.pct, 2) + '%)';
        e.qChg.title = '';
      }
      e.qChg.className = `q-chg ${d}${state === 'special' ? ' special' : ''}`;
      e.qPrice.className = 'q-price ' + d;
      // ストップ高・ストップ安（東証の値幅制限いっぱい）
      if (!waiting && status?.limit) {
        e.qFlag.hidden = false;
        e.qFlag.textContent = status.limit === 'high' ? '高' : '安';
        e.qFlag.className = `q-flag ${status.limit === 'high' ? 'lim-high' : 'lim-low'}`;
        e.qFlag.title = status.limit === 'high' ? 'ストップ高（値幅制限の上限）' : 'ストップ安（値幅制限の下限）';
      }
    }
    e.pos.textContent = pos;
    // データの時刻：Yahoo が返す最終約定時刻（東証は約20分遅れ）。無ければ取得時刻から遅延分を引く
    const last = entries[settings.leftTf] || entries[settings.rightTf];
    const asOf = last?.meta?.time ? last.meta.time * 1000 : last?.fetchedAt ? last.fetchedAt - (isUs || idx ? 0 : 20 * 60e3) : 0;
    e.time.textContent = asOf ? fmtStamp(asOf) : '';
    this.panes.forEach((p) => { p.exch = idx ? 'INDEX' : isUs ? 'US' : 'TSE'; });
    this.fitTitle();
    const label = `${item.code} ${item.name || ''}`.trim();
    // 片方のチャートで想定外のエラーが出ても、もう片方と画面の更新は止めない
    [[settings.leftTf, settings.leftBars], [settings.rightTf, settings.rightBars]].forEach(([tf, n], i) => {
      const pane = this.panes[i];
      try { pane.setData(entries[tf], tf, label, n, keepRange, loading, settings.ta); }
      catch (err) { console.error(err); pane.raw = null; pane.msg.hidden = false; pane.msg.textContent = 'チャートを描けませんでした（次の更新で描き直します）'; }
    });
  }
}

/* 全銘柄一覧の「チャート一覧」用の小さなチャート（保存済みデータだけで描く）。
   触っても動かない（画面のスクロールを邪魔しない）。見えなくなったら destroy で消す。 */
export function miniChart(host, bars, tf, c, ind, ta) {
  const ch = LC.createChart(host, {
    autoSize: true,
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontSize: 10, attributionLogo: false,
      fontFamily: '-apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif' },
    grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
    rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: 0.06 } },
    timeScale: { borderColor: c.border, rightOffset: 2, tickMarkFormatter: tickFmt },
    crosshair: { mode: 2, vertLine: { visible: false }, horzLine: { visible: false } },
    handleScroll: false, handleScale: false,
    localization: { locale: 'ja-JP', priceFormatter: (p) => (p < 0 ? '' : fmtPrice(p)) },
  });
  const data = toLcBars(bars);
  const cs = ch.addCandlestickSeries({
    upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down,
    wickUpColor: c.up, wickDownColor: c.down, priceLineVisible: false, lastValueVisible: true,
  });
  cs.applyOptions({ priceFormat: priceFormatOf(data) });
  cs.setData(data);
  if (ind?.ma) {
    const p = taOf(ta, tf);
    const o = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    [c.ma1, c.ma2, c.ma3].forEach((color, i) => { if (p.on[i]) ch.addLineSeries({ ...o, color }).setData(sma(data, p.ma[i])); });
  }
  ch.timeScale().fitContent();
  return { destroy: () => ch.remove() };
}

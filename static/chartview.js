// One chart: candles, volume, indicators, your trades, drawings, replay.
// The page can show 1, 2 or 4 of these (see app.js, the "hub").
(function () {
  'use strict';

  const LWC = window.LightweightCharts;
  const IND = window.Indicators;
  const DM = window.DrawMath;

  const T = () => window.HPTheme.get(); // the active Hello Purple theme (theme.js)
  const VISIBLE_BARS = 150;

  /** Chart-wide options for the active theme. */
  function chartOptions() {
    const t = T();
    return {
      layout: {
        background: { type: 'solid', color: t.graph },
        textColor: t.muted,
        fontFamily: window.HPTheme.SANS,
        fontSize: 11,
        attributionLogo: true, // keep TradingView's attribution visible
        panes: { separatorColor: t.border, separatorHoverColor: t.grid },
      },
      // The grid as a field of sparse dots: Hello Purple's dot-matrix motif.
      grid: {
        vertLines: { color: t.grid, style: LWC.LineStyle.SparseDotted },
        horzLines: { color: t.grid, style: LWC.LineStyle.SparseDotted },
      },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: t.crosshair, style: LWC.LineStyle.Dashed, width: 1, labelBackgroundColor: t.crosshairLabel },
        horzLine: { color: t.crosshair, style: LWC.LineStyle.Dashed, width: 1, labelBackgroundColor: t.crosshairLabel },
      },
    };
  }

  /** Candles in ink: rising = hollow, falling = filled. Direction never depends on colour. */
  function candleOptions() {
    const t = T();
    return {
      upColor: t.candleHollow, downColor: t.candleInk,
      borderVisible: true, borderUpColor: t.candleInk, borderDownColor: t.candleInk,
      wickUpColor: t.candleInk, wickDownColor: t.candleInk,
      priceLineColor: t.crosshair,
    };
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  class ChartView {
    constructor(hub, container) {
      this.hub = hub;
      this.container = container;
      this.symbol = null;
      this.tf = null;
      this.data = null;
      this.shown = 0;          // number of candles currently on the chart
      this.indicatorSeries = []; // { def, label, series, full: [point|null] }
      this.loadToken = 0;

      container.classList.add('view');
      // While loading: a breathing dot matrix (the brand motif) over the chart.
      container.innerHTML = '<div class="legend"></div><div class="chart"></div>' +
        `<div class="veil" aria-hidden="true"><div class="dots">${'<i></i>'.repeat(21)}</div></div>`;
      this.legendEl = container.querySelector('.legend');
      this.chartEl = container.querySelector('.chart');

      const opts = chartOptions();
      opts.autoSize = true;
      opts.timeScale.timeVisible = true;
      opts.timeScale.secondsVisible = false;
      const chart = LWC.createChart(this.chartEl, opts);
      this.chart = chart;
      this.candles = chart.addSeries(LWC.CandlestickSeries, candleOptions(), 0);
      this.volume = chart.addSeries(LWC.HistogramSeries, {
        priceFormat: { type: 'volume' }, priceLineVisible: false,
      }, 1);
      this.markers = LWC.createSeriesMarkers(this.candles, []);

      this.tools = new window.DrawingTools(chart, this.candles, {
        onStatus: (t, e) => hub.status(t, e),
        onSaved: (sym) => hub.drawingsSaved(sym, this),
      });
      this.tradeLines = new window.TradeLinesPrimitive(chart, this.candles, () => ({
        positions: this.symbol ? hub.positionsFor(this.symbol) : [],
        times: this.visibleTimes(),
        barSeconds: this.data ? this.data.barSeconds : 60,
        cursor: hub.replayCursor(),
        selectedKey: hub.selectedKey,
        visible: hub.showTradeLines,
      }));
      this.candles.attachPrimitive(this.tradeLines);

      chart.subscribeCrosshairMove((param) => {
        this.updateLegend(param);
        // Only real mouse movement is passed on to the other charts
        // (sourceEvent is missing when we set the crosshair ourselves).
        if (param.sourceEvent || param.time === undefined) hub.crosshairMoved(this, param);
      });
      container.addEventListener('pointerdown', () => hub.activate(this), true);
    }

    // ---- data ----------------------------------------------------------
    visibleTimes() {
      return this.data ? this.data.candles.slice(0, this.shown).map((c) => c.time) : [];
    }

    async load(symbol, tf, { keepView } = {}) {
      const token = ++this.loadToken;
      this.hub.status(`Loading ${symbol} ${tf}… (the first time for a symbol MT5 may need to download history)`);
      const previousRange = keepView && symbol === this.symbol && tf === this.tf
        ? this.chart.timeScale().getVisibleRange() : null;
      this.container.classList.add('loading');
      let res;
      let body;
      try {
        res = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}&tf=${tf}`, { cache: 'no-store' });
        body = await res.json().catch(() => ({}));
      } finally {
        if (token === this.loadToken) this.container.classList.remove('loading');
      }
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      if (token !== this.loadToken) return null; // a newer request replaced this one
      this.symbol = symbol;
      this.tf = tf;
      this.data = body;
      // Second charts (S5/S15/S30) need seconds on the time axis.
      this.chart.applyOptions({ timeScale: { secondsVisible: body.barSeconds < 60 } });
      this.render();
      if (previousRange) this.chart.timeScale().setVisibleRange(previousRange);
      else this.showLatest();
      return body;
    }

    showLatest() {
      const n = this.shown;
      this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_BARS), to: n + 5 });
    }

    precision() {
      return this.data && typeof this.data.digits === 'number' ? this.data.digits : 5;
    }

    /** How many candles to show: all of them, or only the closed ones in replay. */
    countFor(cursor) {
      const times = this.data.candles.map((c) => c.time);
      return cursor === null ? times.length : DM.completedBarCount(times, this.data.barSeconds, cursor);
    }

    /** Full redraw. Order matters: see the notes in BUILD_NOTES (bug C). */
    render() {
      if (!this.data) return;
      const d = this.data;
      const n = this.countFor(this.hub.replayCursor());
      this.shown = n;
      // 1. remove old indicator lines first, so the time axis never mixes timeframes
      this.clearIndicators();
      // 2. candles and volume
      const p = this.precision();
      this.candles.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) } });
      this.candles.setData(d.candles.slice(0, n));
      this.volume.setData(d.volume.slice(0, n).map((v) => this.volumePoint(v)));
      // 3. indicators (computed on all data; every value only uses the past)
      this.buildIndicators();
      // 4. trade arrows last
      this.applyMarkers();
      this.layoutPanes();
      this.tools.setContext(d.symbol, this.visibleTimes(), d.barSeconds);
      this.tradeLines.requestUpdate();
      this.updateLegend(null);
    }

    volumePoint(v) {
      return { time: v.time, value: v.value, color: v.up ? T().volUp : T().volDown };
    }

    /** Replay moved: add only the newly closed candles (fast), or redraw if it went back. */
    replayMoved() {
      if (!this.data) return;
      const n = this.countFor(this.hub.replayCursor());
      if (n < this.shown) { this.render(); return; }
      const d = this.data;
      for (let i = this.shown; i < n; i++) {
        this.candles.update(d.candles[i]);
        this.volume.update(this.volumePoint(d.volume[i]));
        for (const s of this.indicatorSeries) if (s.full[i]) s.series.update(s.full[i]);
      }
      if (n !== this.shown) {
        this.shown = n;
        this.applyMarkers();
        this.tools.setContext(d.symbol, this.visibleTimes(), d.barSeconds);
      }
      this.tradeLines.requestUpdate();
      this.updateLegend(null);
    }

    exitReplay() { this.render(); }

    /** The theme changed: recolour everything and redraw. */
    applyTheme() {
      this.chart.applyOptions(chartOptions());
      this.candles.applyOptions(candleOptions());
      this.render();
    }

    applyMarkers() {
      const d = this.data;
      const cursor = this.hub.replayCursor();
      const lastTime = this.shown ? d.candles[this.shown - 1].time : -Infinity;
      const trades = d.trades.filter((t) => t.barTime <= lastTime && (cursor === null || t.time <= cursor));
      this.markers.setMarkers(trades.map((t) => {
        const buy = t.side === 'buy';
        return {
          time: t.barTime,
          position: buy ? 'atPriceTop' : 'atPriceBottom', // arrow tip on the deal price
          price: t.price,
          shape: buy ? 'arrowUp' : 'arrowDown',
          color: buy ? T().buy : T().sell,
          size: 1.5,
          text: `${t.entry} ${t.volume}`,
        };
      }));
    }

    // ---- indicators --------------------------------------------------------
    clearIndicators() {
      this.indicatorSeries.forEach((s) => this.chart.removeSeries(s.series));
      this.indicatorSeries = [];
    }

    lineSeries(pane, color, extra) {
      return this.chart.addSeries(LWC.LineSeries, {
        color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, ...extra,
      }, pane);
    }

    addIndicator(def, label, series, full, swatch) {
      series.setData(full.slice(0, this.shown).filter(Boolean));
      this.indicatorSeries.push({ def, label, series, full, swatch });
    }

    buildIndicators() {
      const d = this.data;
      const times = d.candles.map((c) => c.time);
      const closes = d.candles.map((c) => c.close);
      const p = this.precision();
      const priceFormat = { type: 'price', precision: p, minMove: Math.pow(10, -p) };
      const line = (values) => values.map((v, i) => (v === null ? null : { time: times[i], value: v }));
      let nextPane = 2; // 0 = price, 1 = volume
      let lineIndex = 0;  // n-th single-line indicator: picks hue + line style
      const t = T();

      for (const def of this.hub.indicators) {
        const q = def.params;
        const auto = window.HPTheme.seriesStyle(lineIndex);
        const color = def.color || auto.color;
        const lineStyle = def.color ? 0 : auto.lineStyle;
        const swatch = { color, lineStyle };
        if (['sma', 'ema', 'bb', 'rsi'].includes(def.type)) lineIndex++;
        if (def.type === 'sma' || def.type === 'ema') {
          const values = IND[def.type](closes, q.period);
          this.addIndicator(def, `${def.type.toUpperCase()}(${q.period})`,
            this.lineSeries(0, color, { priceFormat, lineStyle }), line(values), swatch);
        } else if (def.type === 'bb') {
          const b = IND.bollinger(closes, q.period, q.mult);
          const label = `BB(${q.period}, ${q.mult})`;
          this.addIndicator(def, `${label} upper`, this.lineSeries(0, color, { priceFormat, lineWidth: 1 }), line(b.upper), swatch);
          this.addIndicator(def, label, this.lineSeries(0, color, { priceFormat, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed }), line(b.middle), { color, lineStyle: 2 });
          this.addIndicator(def, `${label} lower`, this.lineSeries(0, color, { priceFormat, lineWidth: 1 }), line(b.lower), swatch);
        } else if (def.type === 'rsi') {
          const pane = nextPane++;
          const s = this.lineSeries(pane, color, {
            lineStyle,
            lastValueVisible: true,
            priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
            autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
          });
          this.addIndicator(def, `RSI(${q.period})`, s, line(IND.rsi(closes, q.period)), swatch);
          [70, 30].forEach((level) => s.createPriceLine({
            price: level, color: t.level, lineWidth: 1, lineStyle: LWC.LineStyle.SparseDotted,
            axisLabelVisible: false, title: String(level),
          }));
        } else if (def.type === 'macd') {
          const pane = nextPane++;
          const m = IND.macd(closes, q.fast, q.slow, q.signal);
          const label = `MACD(${q.fast}, ${q.slow}, ${q.signal})`;
          const fmt = { type: 'price', precision: p + 1, minMove: Math.pow(10, -(p + 1)) };
          const hist = this.chart.addSeries(LWC.HistogramSeries, { priceFormat: fmt, priceLineVisible: false, lastValueVisible: false }, pane);
          this.addIndicator(def, `${label} histogram`, hist, m.histogram.map((v, i) => (v === null ? null
            : { time: times[i], value: v, color: v >= 0 ? t.histUp : t.histDown })));
          this.addIndicator(def, `${label} line`, this.lineSeries(pane, t.series[0], { priceFormat: fmt, lineWidth: 1.5, lastValueVisible: true }), line(m.line));
          this.addIndicator(def, `${label} signal`, this.lineSeries(pane, t.series[1], { priceFormat: fmt, lineWidth: 1.5 }), line(m.signal));
        } else if (def.type === 'spread') {
          // The broker's spread per candle, in points (straight from MT5, no calculation).
          const pane = nextPane++;
          const s = this.chart.addSeries(LWC.HistogramSeries, {
            color: def.color || t.spread, priceLineVisible: false, lastValueVisible: true,
            priceFormat: { type: 'price', precision: 0, minMove: 1 },
          }, pane);
          this.addIndicator(def, 'Spread (points)', s, d.volume.map((v) => ({ time: v.time, value: v.spread })));
        }
      }
    }

    /** Proportional pane heights (stretch factors), see BUILD_NOTES bug D. */
    layoutPanes() {
      this.chart.panes().forEach((pane, i) => pane.setStretchFactor(i === 0 ? 6 : i === 1 ? 1 : 1.5));
    }

    // ---- legend & crosshair -----------------------------------------------
    updateLegend(param) {
      const d = this.data;
      if (!d) { this.legendEl.textContent = ''; return; }
      const fmt = (v) => v.toFixed(this.precision());
      let bar;
      let valueOf;
      if (param && param.time !== undefined) {
        bar = param.seriesData.get(this.candles);
        valueOf = (s) => { const pt = param.seriesData.get(s); return pt ? pt.value : undefined; };
      } else {
        bar = this.shown ? d.candles[this.shown - 1] : null;
        valueOf = (s) => { const data = s.data(); return data.length ? data[data.length - 1].value : undefined; };
      }
      const parts = [`<span class="sym">${esc(d.symbol)}</span><span class="tf">${esc(d.timeframe)}</span>`];
      if (bar) {
        parts.push(`<span class="ohlc"><i>O</i>${fmt(bar.open)} <i>H</i>${fmt(bar.high)} ` +
                   `<i>L</i>${fmt(bar.low)} <i>C</i>${fmt(bar.close)}</span>`);
      }
      for (const ind of this.indicatorSeries) {
        if (!['sma', 'ema', 'bb'].includes(ind.def.type) || / (upper|lower)$/.test(ind.label)) continue;
        const v = valueOf(ind.series);
        if (v === undefined) continue;
        // Text stays in ink; the small line beside it carries the series identity.
        const sw = ind.swatch || {};
        const dash = sw.lineStyle === 2 ? 'dashed' : sw.lineStyle === 1 ? 'dotted' : 'solid';
        parts.push(`<span class="ind"><b class="sw" style="border-top:2px ${dash} ${esc(sw.color || 'currentColor')}"></b>${esc(ind.label)} ${fmt(v)}</span>`);
      }
      this.legendEl.innerHTML = parts.join('');
    }

    /** Show the crosshair at the candle that contains `time` (crosshair sync). */
    showCrosshairAt(time, price, sameSymbol) {
      const times = this.visibleTimes();
      const i = DM.floorIndex(times, time);
      if (i < 0) { this.chart.clearCrosshairPosition(); return; }
      const y = sameSymbol && price !== null ? price : this.data.candles[i].close;
      this.chart.setCrosshairPosition(y, times[i], this.candles);
    }

    clearCrosshair() { this.chart.clearCrosshairPosition(); }

    /** Scroll so that a period (e.g. one trade) is in view, with some margin. */
    focusPeriod(from, to) {
      const times = this.visibleTimes();
      if (!times.length) return;
      const bs = this.data.barSeconds;
      const a = DM.timeToLogical(times, from, bs);
      const b = DM.timeToLogical(times, to || from, bs);
      const span = Math.max(20, (b - a) * 1.5);
      this.chart.timeScale().setVisibleLogicalRange({ from: a - span / 2, to: b + span / 2 });
    }

    setActive(on) { this.container.classList.toggle('active', on); }

    redrawTrades() { this.tradeLines.requestUpdate(); }

    // ---- CSV ---------------------------------------------------------------
    csv() {
      const d = this.data;
      if (!d) return null;
      const cols = [
        { key: 'time', label: 'time (broker server time)' },
        { key: 'open', label: 'open' }, { key: 'high', label: 'high' },
        { key: 'low', label: 'low' }, { key: 'close', label: 'close' },
        { key: 'volume', label: 'volume' }, { key: 'spread', label: 'spread (points)' },
      ];
      this.indicatorSeries.forEach((s, j) => cols.push({ key: `i${j}`, label: s.label }));
      const rows = [];
      for (let i = 0; i < this.shown; i++) {
        const c = d.candles[i];
        const row = { time: window.CSV.isoTime(c.time), open: c.open, high: c.high, low: c.low,
          close: c.close, volume: d.volume[i].value, spread: d.volume[i].spread };
        this.indicatorSeries.forEach((s, j) => { row[`i${j}`] = s.full[i] ? s.full[i].value : null; });
        rows.push(row);
      }
      return window.CSV.toCSV(cols, rows);
    }

    destroy() {
      this.tools.destroy();
      this.chart.remove();
      this.container.innerHTML = '';
      this.container.classList.remove('view', 'active');
    }
  }

  window.ChartView = ChartView;
})();

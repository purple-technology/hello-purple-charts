// Drawing tools: trend line, horizontal line, rectangle, eraser.
//
// Built the way TradingView's plugin skill describes:
// - trend lines and rectangles are drawn by a *series primitive* attached to
//   the candles (ISeriesPrimitive: attached / detached / updateAllViews /
//   paneViews, drawing in bitmap coordinates so lines stay sharp);
// - horizontal lines use the library's own price lines (createPriceLine),
//   which also give a price label on the axis;
// - mouse positions come from chart.subscribeCrosshairMove and are converted
//   with the public coordinate API (clicks: see the note in the constructor).
//
// Drawings are stored as time + price (see drawmath.js) and saved per symbol
// in a local file through our own server.
(function () {
  'use strict';

  const DM = window.DrawMath;
  const HIT_PIXELS = 6;

  // ---- The primitive that paints trend lines and rectangles -------------
  class DrawingsPrimitive {
    constructor(tools) {
      this._tools = tools;
      this._shapes = []; // screen coordinates, recomputed in updateAllViews
      const self = this;
      this._view = {
        zOrder: () => 'top',
        renderer: () => ({ draw: (target) => self._draw(target) }),
      };
    }

    attached(param) {
      this._requestUpdate = param.requestUpdate;
    }

    detached() {
      this._requestUpdate = undefined;
    }

    requestUpdate() {
      if (this._requestUpdate) this._requestUpdate();
    }

    updateAllViews() {
      this._shapes = this._tools.screenShapes();
    }

    paneViews() {
      return [this._view];
    }

    _draw(target) {
      const shapes = this._shapes;
      if (!shapes.length) return;
      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio;
        const vr = scope.verticalPixelRatio;
        ctx.save();
        for (const s of shapes) {
          const x1 = Math.round(s.a.x * hr);
          const y1 = Math.round(s.a.y * vr);
          const x2 = Math.round(s.b.x * hr);
          const y2 = Math.round(s.b.y * vr);
          ctx.lineWidth = Math.max(1, Math.round(2 * hr));
          ctx.strokeStyle = s.color;
          ctx.setLineDash(s.preview ? [6 * hr, 4 * hr] : []);
          if (s.type === 'trend') {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          } else if (s.type === 'rect') {
            const x = Math.min(x1, x2);
            const y = Math.min(y1, y2);
            const w = Math.abs(x2 - x1);
            const h = Math.abs(y2 - y1);
            ctx.globalAlpha = 0.15;
            ctx.fillStyle = s.color;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
            ctx.strokeRect(x, y, w, h);
          }
        }
        ctx.restore(); // leave the canvas as we found it
      });
    }
  }

  // ---- The tools controller ----------------------------------------------
  class DrawingTools {
    constructor(chart, series, { onStatus, onSaved }) {
      this.chart = chart;
      this.series = series;
      this.onStatus = onStatus || (() => {});
      this.onSaved = onSaved || (() => {}); // tells other charts of the same symbol
      this.tool = 'none';
      this.color = '#7c3aed'; // Hello Purple blue-violet: readable on Paper and Midnight
      this.drawings = [];
      this.symbol = null;
      this.times = [];
      this.barSeconds = 3600;
      this.pending = null;   // first point of a drawing in progress
      this.hover = null;     // current mouse point (for the preview)
      this.priceLines = new Map(); // drawing id -> IPriceLine
      this.listeners = [];

      this.primitive = new DrawingsPrimitive(this);
      series.attachPrimitive(this.primitive);

      // Clicks: chart.subscribeClick drops the second of two clicks made
      // within about half a second (tested: even 200 px apart), which loses
      // points when drawing quickly. So we listen to the mouse button
      // ourselves and take the position from the latest crosshair event,
      // which always has the chart's own pane and coordinates.
      this.lastParam = null;
      this._onMove = (p) => { this.lastParam = p; this._move(p); };
      chart.subscribeCrosshairMove(this._onMove);

      const el = chart.chartElement();
      let down = null;
      this._onPointerDown = (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
      this._onPointerUp = (e) => {
        if (!down || e.button !== 0) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        down = null;
        if (moved > 5) return; // that was a drag (scrolling the chart), not a click
        if (this.lastParam) this._click(this.lastParam);
      };
      el.addEventListener('pointerdown', this._onPointerDown);
      el.addEventListener('pointerup', this._onPointerUp);
      this._element = el;
    }

    destroy() {
      this.chart.unsubscribeCrosshairMove(this._onMove);
      this._element.removeEventListener('pointerdown', this._onPointerDown);
      this._element.removeEventListener('pointerup', this._onPointerUp);
      this.series.detachPrimitive(this.primitive);
    }

    onToolChange(fn) { this.listeners.push(fn); }

    setTool(tool) {
      this.tool = this.tool === tool ? 'none' : tool;
      this.pending = null;
      this.listeners.forEach((fn) => fn(this.tool));
      this.primitive.requestUpdate();
    }

    cancel() {
      if (this.tool !== 'none' || this.pending) this.setTool('none');
    }

    /** Called after every data load. Loads saved drawings when the symbol changes. */
    async setContext(symbol, times, barSeconds, forceReload) {
      this.times = times;
      this.barSeconds = barSeconds;
      if (symbol !== this.symbol || forceReload) {
        this.symbol = symbol;
        this.pending = null;
        if (!forceReload) this._replaceDrawings([]);
        try {
          const res = await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Could not load drawings');
          if (this.symbol === symbol) this._replaceDrawings(body.drawings);
        } catch (err) {
          this.onStatus(`Drawings not loaded: ${err.message}`, true);
        }
      }
      this.primitive.requestUpdate();
    }

    clearAll() {
      this._replaceDrawings([]);
      this._save();
    }

    count() { return this.drawings.length; }

    // ---- conversions ------------------------------------------------------
    _pointFromParam(param) {
      if (!param.point || param.paneIndex !== 0) return null;
      const logical = this.chart.timeScale().coordinateToLogical(param.point.x);
      const price = this.series.coordinateToPrice(param.point.y);
      if (logical === null || price === null || !this.times.length) return null;
      // Snap to the nearest candle (or candle slot to the right of the last one).
      const time = Math.round(DM.logicalToTime(this.times, Math.round(logical), this.barSeconds));
      return { time, price };
    }

    _toScreen(pt) {
      // timeToX interpolates between candles (see drawmath.js for why).
      const x = DM.timeToX(this.chart.timeScale(), this.times, pt.time, this.barSeconds);
      const y = this.series.priceToCoordinate(pt.price);
      if (x === null || y === null) return null; // off-scale: skip, never draw to NaN
      return { x, y };
    }

    /** Screen shapes for the primitive (trend lines, rectangles, preview). */
    screenShapes() {
      const out = [];
      for (const d of this.drawings) {
        if (d.type === 'hline') continue; // drawn as a price line
        const a = this._toScreen(d.points[0]);
        const b = this._toScreen(d.points[1]);
        if (a && b) out.push({ type: d.type, color: d.color, a, b });
      }
      if (this.pending && this.hover) {
        const a = this._toScreen(this.pending);
        const b = this._toScreen(this.hover);
        if (a && b) out.push({ type: this.tool, color: this.color, a, b, preview: true });
      }
      return out;
    }

    // ---- mouse ------------------------------------------------------------
    _move(param) {
      if (!this.pending) return;
      const pt = this._pointFromParam(param);
      if (pt) {
        this.hover = pt;
        this.primitive.requestUpdate();
      }
    }

    _click(param) {
      if (this.tool === 'none') return;
      if (this.tool === 'erase') return this._erase(param);
      const pt = this._pointFromParam(param);
      if (!pt) return;

      if (this.tool === 'hline') {
        this._add({ type: 'hline', points: [pt] });
        return this.setTool('none');
      }
      if (!this.pending) {
        this.pending = pt;
        this.hover = pt;
        this.primitive.requestUpdate();
        return;
      }
      if (pt.time === this.pending.time && pt.price === this.pending.price) return;
      this._add({ type: this.tool, points: [this.pending, pt] });
      this.setTool('none');
    }

    _erase(param) {
      if (!param.point || param.paneIndex !== 0) return;
      const p = param.point;
      let best = null;
      let bestDist = HIT_PIXELS;
      for (const d of this.drawings) {
        let dist = Infinity;
        if (d.type === 'hline') {
          const y = this.series.priceToCoordinate(d.points[0].price);
          if (y !== null) dist = Math.abs(p.y - y);
        } else {
          const a = this._toScreen(d.points[0]);
          const b = this._toScreen(d.points[1]);
          if (!a || !b) continue;
          if (d.type === 'trend') dist = DM.distanceToSegment(p, a, b);
          else if (DM.insideRect(p, a, b, HIT_PIXELS)) dist = 0;
        }
        if (dist <= bestDist) { best = d; bestDist = dist; }
      }
      if (best) {
        this._replaceDrawings(this.drawings.filter((d) => d !== best));
        this._save();
      }
    }

    // ---- storage ------------------------------------------------------------
    _add(partial) {
      const id = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      this._replaceDrawings(this.drawings.concat([{ id, color: this.color, ...partial }]));
      this._save();
    }

    _replaceDrawings(list) {
      this.drawings = list;
      // Sync horizontal lines with the library's price lines.
      const wanted = new Map(list.filter((d) => d.type === 'hline').map((d) => [d.id, d]));
      for (const [id, line] of this.priceLines) {
        if (!wanted.has(id)) { this.series.removePriceLine(line); this.priceLines.delete(id); }
      }
      for (const [id, d] of wanted) {
        if (this.priceLines.has(id)) continue;
        this.priceLines.set(id, this.series.createPriceLine({
          price: d.points[0].price, color: d.color, lineWidth: 2,
          lineStyle: 0, axisLabelVisible: true, title: '',
        }));
      }
      this.primitive.requestUpdate();
    }

    async _save() {
      const symbol = this.symbol;
      try {
        const res = await fetch(`/api/drawings?symbol=${encodeURIComponent(symbol)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drawings: this.drawings }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        this.onSaved(symbol);
      } catch (err) {
        this.onStatus(`Drawing not saved: ${err.message}`, true);
      }
    }
  }

  window.DrawingTools = DrawingTools;
})();

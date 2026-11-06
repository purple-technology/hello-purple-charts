// Draws your positions on the chart: a dashed line from entry to exit,
// a faint red band for the risk (entry to stop) and a faint green band for
// the target (entry to take-profit), plus the result in R at the exit.
// A series primitive, like the drawing tools (see drawings.js).
(function () {
  'use strict';

  const DM = window.DrawMath;
  const T = () => window.HPTheme.get(); // Hello Purple theme colours (theme.js)

  class TradeLinesPrimitive {
    /**
     * getState() returns { positions, times, barSeconds, cursor, selectedKey,
     * visible } where cursor is the replay time (or null).
     */
    constructor(chart, series, getState) {
      this.chart = chart;
      this.series = series;
      this.getState = getState;
      this._items = [];
      const self = this;
      this._view = {
        zOrder: () => 'normal', // behind the candles' markers, above the grid
        renderer: () => ({ draw: (target) => self._draw(target) }),
      };
    }

    attached(param) { this._requestUpdate = param.requestUpdate; }
    detached() { this._requestUpdate = undefined; }
    requestUpdate() { if (this._requestUpdate) this._requestUpdate(); }
    paneViews() { return [this._view]; }

    updateAllViews() {
      const st = this.getState();
      this._items = [];
      if (!st.visible || !st.times.length) return;
      const ts = this.chart.timeScale();
      const x = (t) => DM.timeToX(ts, st.times, t, st.barSeconds);
      const y = (p) => this.series.priceToCoordinate(p);
      for (const p of st.positions) {
        if (st.cursor !== null && p.entryTime > st.cursor) continue; // not opened yet in replay
        const closedYet = p.exitTime !== null && (st.cursor === null || p.exitTime <= st.cursor);
        const endTime = closedYet ? p.exitTime : (st.cursor !== null ? st.cursor : p.exitTime);
        if (endTime === null) continue;
        const x1 = x(p.entryTime);
        const x2 = x(endTime);
        const yEntry = y(p.entryPrice);
        if (x1 === null || x2 === null || yEntry === null) continue; // off-scale: skip
        this._items.push({
          x1, x2: Math.max(x2, x1 + 2), yEntry,
          yExit: closedYet ? y(p.exitPrice) : null,
          yStop: p.stop ? y(p.stop) : null,
          yTarget: p.target ? y(p.target) : null,
          win: closedYet ? p.move > 0 : null,
          label: closedYet && p.r !== null && p.r !== undefined
            ? `${p.r >= 0 ? '+' : ''}${p.r.toFixed(1)}R` : null,
          selected: p.key === st.selectedKey,
        });
      }
    }

    _draw(target) {
      const items = this._items;
      if (!items.length) return;
      target.useBitmapCoordinateSpace((scope) => {
        const ctx = scope.context;
        const hr = scope.horizontalPixelRatio;
        const vr = scope.verticalPixelRatio;
        const t = T();
        ctx.save();
        for (const it of items) {
          const x1 = Math.round(it.x1 * hr);
          const x2 = Math.round(it.x2 * hr);
          const ye = Math.round(it.yEntry * vr);
          const alpha = it.selected ? 0.13 : 0.06;
          // risk band (entry -> stop, orange) and target band (entry -> TP, violet)
          if (it.yStop !== null) {
            const ys = Math.round(it.yStop * vr);
            ctx.fillStyle = `rgba(${t.lossBand},${alpha})`;
            ctx.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye));
          }
          if (it.yTarget !== null) {
            const yt = Math.round(it.yTarget * vr);
            ctx.fillStyle = `rgba(${t.winBand},${alpha})`;
            ctx.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye));
          }
          // entry -> exit line, with a dot at each end (the brand's dot motif)
          const colour = it.yExit === null ? t.muted : it.win ? t.win : t.loss;
          if (it.yExit !== null) {
            const yx = Math.round(it.yExit * vr);
            ctx.strokeStyle = colour;
            ctx.lineWidth = Math.max(1, Math.round((it.selected ? 2.5 : 1.5) * hr));
            ctx.setLineDash([2 * hr, 4 * hr]); // a dotted path
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x1, ye);
            ctx.lineTo(x2, yx);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = colour;
            ctx.beginPath();
            ctx.arc(x2, yx, 3.5 * hr, 0, Math.PI * 2);
            ctx.fill();
          }
          // entry: a hollow ring
          ctx.setLineDash([]);
          ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
          ctx.strokeStyle = colour;
          ctx.fillStyle = t.graph;
          ctx.beginPath();
          ctx.arc(x1, ye, 3.5 * hr, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore(); // leave the canvas as we found it
      });
      // R labels in CSS pixels (text belongs in media coordinates): a small
      // pill with ink text and a hairline in the result's colour.
      target.useMediaCoordinateSpace(({ context: ctx }) => {
        const t = T();
        ctx.save();
        ctx.font = `600 11px ${window.HPTheme.SANS}`;
        ctx.textBaseline = 'middle';
        for (const it of items) {
          if (!it.label || it.yExit === null) continue;
          const w = ctx.measureText(it.label).width + 14;
          const x = it.x2 + 8;
          const y = it.yExit - 9;
          ctx.fillStyle = t.labelBg;
          ctx.strokeStyle = it.win ? t.win : t.loss;
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(x, y, w, 18, 9); else ctx.rect(x, y, w, 18);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = t.labelText;
          ctx.fillText(it.label, x + 7, it.yExit + 0.5);
        }
        ctx.restore();
      });
    }
  }

  window.TradeLinesPrimitive = TradeLinesPrimitive;
})();

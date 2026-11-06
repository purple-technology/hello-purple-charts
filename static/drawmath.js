// Geometry for the drawing tools. No chart library needed, so it can be
// tested in Node.js. Works in the browser as window.DrawMath.
//
// Drawings are stored as real times + prices, never as screen pixels or
// candle numbers, so they stay in the right place when you switch timeframe.
// To draw them we convert a time into a "logical index": 0 = first candle,
// 1 = second candle, 2.5 = halfway between the third and fourth, and beyond
// the last candle we keep counting with the timeframe's length.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DrawMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Last index i with times[i] <= t (binary search), or -1. */
  function floorIndex(times, t) {
    let lo = 0;
    let hi = times.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  /** Time (seconds) -> logical index, interpolating between candles. */
  function timeToLogical(times, t, barSeconds) {
    const n = times.length;
    if (!n) return null;
    if (t <= times[0]) return (t - times[0]) / barSeconds;
    if (t >= times[n - 1]) return (n - 1) + (t - times[n - 1]) / barSeconds;
    const i = floorIndex(times, t);
    return i + (t - times[i]) / (times[i + 1] - times[i]);
  }

  /** Logical index -> time (seconds). Exact inverse of timeToLogical. */
  function logicalToTime(times, logical, barSeconds) {
    const n = times.length;
    if (!n) return null;
    if (logical <= 0) return times[0] + logical * barSeconds;
    if (logical >= n - 1) return times[n - 1] + (logical - (n - 1)) * barSeconds;
    const i = Math.floor(logical);
    return times[i] + (logical - i) * (times[i + 1] - times[i]);
  }

  /** Shortest pixel distance from point p to the segment a-b. */
  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  /** Is point p inside the rectangle spanned by corners a and b (+ margin)? */
  function insideRect(p, a, b, margin) {
    const m = margin || 0;
    return p.x >= Math.min(a.x, b.x) - m && p.x <= Math.max(a.x, b.x) + m &&
           p.y >= Math.min(a.y, b.y) - m && p.y <= Math.max(a.y, b.y) + m;
  }

  /**
   * Replay: how many candles have *closed* at `cursor` (seconds)? A candle
   * opening at t closes at t + barSeconds. Showing only closed candles means
   * replay never shows an unfinished candle from the future.
   */
  function completedBarCount(times, barSeconds, cursor) {
    return floorIndex(times, cursor - barSeconds) + 1;
  }

  /**
   * Screen x for a time, also between two candles. The chart's own
   * logicalToCoordinate only handles whole candle numbers (a fraction came
   * back as 0), so we interpolate between the two whole neighbours.
   */
  function timeToX(timeScale, times, t, barSeconds) {
    const logical = timeToLogical(times, t, barSeconds);
    if (logical === null) return null;
    const i = Math.floor(logical);
    const frac = logical - i;
    const x0 = timeScale.logicalToCoordinate(i);
    if (x0 === null || frac === 0) return x0;
    const x1 = timeScale.logicalToCoordinate(i + 1);
    return x1 === null ? null : x0 + (x1 - x0) * frac;
  }

  return { floorIndex, timeToLogical, logicalToTime, distanceToSegment, insideRect,
           completedBarCount, timeToX };
});

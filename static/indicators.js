// Technical indicators, written by hand (no indicator library).
// Works in the browser (window.Indicators) and in Node.js tests (require).
//
// Every function takes a plain array of numbers and returns an array of the
// same length. Positions without enough data yet are `null`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Indicators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function checkPeriod(period) {
    if (!Number.isInteger(period) || period < 1) {
      throw new Error('period must be a whole number of 1 or more');
    }
  }

  /** Simple moving average: plain average of the last `period` values. */
  function sma(values, period) {
    checkPeriod(period);
    const out = new Array(values.length).fill(null);
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += values[i];
      if (i >= period) total -= values[i - period];
      if (i >= period - 1) out[i] = total / period;
    }
    return out;
  }

  /**
   * Exponential moving average. Starts with the simple average of the first
   * `period` values, then each step: ema = value * k + previous * (1 - k),
   * with k = 2 / (period + 1). `null` values at the start are skipped, so an
   * EMA can be taken of another indicator (used by MACD).
   */
  function ema(values, period) {
    checkPeriod(period);
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let start = values.findIndex((v) => v !== null && v !== undefined);
    if (start < 0) return out;
    let seedSum = 0;
    let count = 0;
    let prev = null;
    for (let i = start; i < values.length; i++) {
      if (prev === null) {
        seedSum += values[i];
        count++;
        if (count === period) {
          prev = seedSum / period;
          out[i] = prev;
        }
      } else {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  /**
   * Bollinger Bands: middle = SMA(period), upper/lower = middle +/- mult x
   * standard deviation of the same `period` values (population standard
   * deviation, as MetaTrader and TradingView use).
   */
  function bollinger(values, period, mult) {
    checkPeriod(period);
    const middle = sma(values, period);
    const upper = new Array(values.length).fill(null);
    const lower = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let sq = 0;
      for (let j = i - period + 1; j <= i; j++) sq += (values[j] - middle[i]) ** 2;
      const sd = Math.sqrt(sq / period);
      upper[i] = middle[i] + mult * sd;
      lower[i] = middle[i] - mult * sd;
    }
    return { middle, upper, lower };
  }

  /**
   * RSI (Wilder). First average gain/loss = simple average of the first
   * `period` price changes; after that avg = (previous avg x (period-1) +
   * current) / period. RSI = 100 - 100 / (1 + avgGain / avgLoss).
   */
  function rsi(values, period) {
    checkPeriod(period);
    const out = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = values[i] - values[i - 1];
      if (ch > 0) gain += ch; else loss -= ch;
    }
    gain /= period;
    loss /= period;
    const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
    out[period] = value();
    for (let i = period + 1; i < values.length; i++) {
      const ch = values[i] - values[i - 1];
      gain = (gain * (period - 1) + (ch > 0 ? ch : 0)) / period;
      loss = (loss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
      out[i] = value();
    }
    return out;
  }

  /**
   * MACD: line = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of the
   * line; histogram = line - signal.
   */
  function macd(values, fast, slow, signalPeriod) {
    const f = ema(values, fast);
    const s = ema(values, slow);
    const line = values.map((_, i) => (f[i] === null || s[i] === null ? null : f[i] - s[i]));
    const signal = ema(line, signalPeriod);
    const histogram = line.map((v, i) => (v === null || signal[i] === null ? null : v - signal[i]));
    return { line, signal, histogram };
  }

  return { sma, ema, bollinger, rsi, macd };
});

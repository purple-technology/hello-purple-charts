// Trade statistics for the journal, from the positions the server sends
// (/api/journal). Everything is in R-multiples, percent, points, counts and
// durations: never money. Works in the browser (window.Stats) and in Node.
//
// "Win" means the price moved in the trade's favour (move > 0).
// Hours and weekdays are broker server time.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const closedOnly = (positions) => positions.filter((p) => !p.open && p.move !== null);
  const isWin = (p) => p.move > 0;
  const rOf = (ps) => ps.map((p) => p.r).filter((r) => r !== null && r !== undefined);

  /** The headline numbers. */
  function summary(positions) {
    const ps = closedOnly(positions);
    const wins = ps.filter(isWin);
    const losses = ps.filter((p) => !isWin(p));
    const rs = rOf(ps);
    const posR = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const negR = rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
    const winsWithMfe = wins.filter((p) => p.mfe > 0);
    const reached1R = ps.filter((p) => p.mfeR !== null && p.mfeR !== undefined && p.mfeR >= 1);
    return {
      trades: ps.length,
      wins: wins.length,
      losses: losses.length,
      winRate: ps.length ? wins.length / ps.length : null,
      tradesWithR: rs.length,
      avgR: mean(rs),                    // = expectancy per trade, in R
      totalR: rs.reduce((a, b) => a + b, 0),
      profitFactorR: negR < 0 ? posR / -negR : null,
      avgWinR: mean(rOf(wins)),
      avgLossR: mean(rOf(losses)),
      bestR: rs.length ? Math.max(...rs) : null,
      worstR: rs.length ? Math.min(...rs) : null,
      avgHoldWin: mean(wins.map((p) => p.duration)),
      avgHoldLoss: mean(losses.map((p) => p.duration)),
      avgMaeR: mean(ps.map((p) => p.maeR).filter((x) => x !== null && x !== undefined)),
      avgMfeR: mean(ps.map((p) => p.mfeR).filter((x) => x !== null && x !== undefined)),
      // Of the best price reached, how much did winners keep?
      captured: mean(winsWithMfe.map((p) => p.move / p.mfe)),
      // Trades that were 1R or more in profit at some point, but closed at a loss.
      gaveBack: reached1R.filter((p) => p.move <= 0).length,
      reached1R: reached1R.length,
    };
  }

  /** Count, win rate and average R per group (hour, weekday, symbol, ...). */
  function groupBy(positions, keyFn, keys) {
    const ps = closedOnly(positions);
    const groups = new Map();
    (keys || []).forEach((k) => groups.set(k, []));
    ps.forEach((p) => {
      const k = keyFn(p);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    return [...groups.entries()].map(([key, list]) => ({
      key,
      count: list.length,
      winRate: list.length ? list.filter(isWin).length / list.length : null,
      avgR: mean(rOf(list)),
      totalR: rOf(list).reduce((a, b) => a + b, 0),
      avgPct: mean(list.map((p) => p.movePct)),
    }));
  }

  const hourOf = (p) => new Date(p.entryTime * 1000).getUTCHours();
  const weekdayOf = (p) => new Date(p.entryTime * 1000).getUTCDay(); // 0 = Sunday
  const byHour = (ps) => groupBy(ps, hourOf, [...Array(24).keys()]);
  const byWeekday = (ps) => groupBy(ps, weekdayOf, [1, 2, 3, 4, 5, 6, 0]);
  const bySymbol = (ps) => groupBy(ps, (p) => p.symbol).sort((a, b) => b.count - a.count);
  const bySide = (ps) => groupBy(ps, (p) => p.side, ['buy', 'sell']);
  const byExit = (ps) => groupBy(ps, (p) => p.exitReason, ['SL', 'TP', 'manual']);

  /**
   * Behaviour after a loss.
   * - quick re-entry: a trade opened within `withinSeconds` after a losing
   *   trade closed. Compared with all other trades.
   * - relative volume: volume / that symbol's median volume (so BTC 0.1 and
   *   EURUSD 1.0 can be compared). Average for the trade right after a
   *   loss vs right after a win.
   * - streaks: longest run of wins / losses in order of closing.
   */
  function behaviour(positions, withinSeconds) {
    const within = withinSeconds || 3600;
    const ps = closedOnly(positions).sort((a, b) => a.entryTime - b.entryTime);
    const medianVol = {};
    const bySym = {};
    ps.forEach((p) => { (bySym[p.symbol] = bySym[p.symbol] || []).push(p.volume); });
    Object.keys(bySym).forEach((s) => { medianVol[s] = median(bySym[s]); });
    const relVol = (p) => p.volume / medianVol[p.symbol];

    const quick = [];
    const others = [];
    const afterLossVol = [];
    const afterWinVol = [];
    ps.forEach((p) => {
      // the most recent trade that was closed before this one opened
      let prev = null;
      for (const q of ps) {
        if (q !== p && q.exitTime <= p.entryTime && (!prev || q.exitTime > prev.exitTime)) prev = q;
      }
      if (prev && !isWin(prev) && p.entryTime - prev.exitTime <= within) quick.push(p);
      else others.push(p);
      if (prev) (isWin(prev) ? afterWinVol : afterLossVol).push(relVol(p));
    });

    const byExitTime = [...ps].sort((a, b) => a.exitTime - b.exitTime);
    let maxWin = 0; let maxLoss = 0; let run = 0; let last = null;
    byExitTime.forEach((p) => {
      const w = isWin(p);
      run = w === last ? run + 1 : 1;
      last = w;
      if (w) maxWin = Math.max(maxWin, run); else maxLoss = Math.max(maxLoss, run);
    });

    const describe = (list) => ({
      count: list.length,
      winRate: list.length ? list.filter(isWin).length / list.length : null,
      avgR: mean(rOf(list)),
    });
    return {
      withinSeconds: within,
      quickAfterLoss: describe(quick),
      otherTrades: describe(others),
      relVolumeAfterLoss: mean(afterLossVol),
      relVolumeAfterWin: mean(afterWinVol),
      longestWinStreak: maxWin,
      longestLossStreak: maxLoss,
    };
  }

  /** Execution quality per symbol: spread at entry and slippage on stop-loss exits. */
  function execution(positions) {
    const ps = closedOnly(positions);
    const out = {};
    ps.forEach((p) => {
      const e = (out[p.symbol] = out[p.symbol] || { symbol: p.symbol, spreads: [], slEx: [] });
      if (p.entryFill && p.entryFill.spreadPoints !== null) e.spreads.push(p.entryFill.spreadPoints);
      if (p.exitReason === 'SL' && p.exitFill && p.exitFill.slippagePoints !== null) e.slEx.push(p.exitFill.slippagePoints);
    });
    return Object.values(out).map((e) => ({
      symbol: e.symbol,
      medianSpreadPoints: median(e.spreads),
      stopExits: e.slEx.length,
      stopExitsWorse: e.slEx.filter((x) => x > 0).length,
      medianStopSlippagePoints: median(e.slEx),
    })).sort((a, b) => b.stopExits - a.stopExits);
  }

  return { mean, median, summary, groupBy, byHour, byWeekday, bySymbol, bySide, byExit, behaviour, execution };
});

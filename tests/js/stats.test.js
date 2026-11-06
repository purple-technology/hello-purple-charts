// Journal statistics checked by hand on a small, made-up trade list.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../static/stats.js');

const H = 3600;
// Monday 2026-01-05 00:00 UTC = 1767571200
const MON = 1767571200;
const t = (day, hour, min = 0) => MON + day * 86400 + hour * H + min * 60;
const pos = (o) => ({ open: false, symbol: 'EURUSD', side: 'buy', volume: 1, maeR: null, mfeR: null,
  mae: null, mfe: null, exitReason: 'manual', duration: 3600, movePct: 0, ...o });

const P = [
  // 1. Mon 09:00 win +2R, MFE 3R
  pos({ entryTime: t(0, 9), exitTime: t(0, 10), move: 0.002, r: 2, mfe: 0.003, mfeR: 3, maeR: 0.5, exitReason: 'TP', movePct: 0.2 }),
  // 2. Mon 11:00 loss -1R, had been +1.2R first ("gave back")
  pos({ entryTime: t(0, 11), exitTime: t(0, 12), move: -0.001, r: -1, mfeR: 1.2, maeR: 1, exitReason: 'SL', movePct: -0.1 }),
  // 3. Mon 12:30 (30 min after the loss), double volume, loss -1R
  pos({ entryTime: t(0, 12, 30), exitTime: t(0, 13), move: -0.001, r: -1, volume: 2, mfeR: 0.2, maeR: 1, exitReason: 'SL', movePct: -0.1 }),
  // 4. Tue 09:00 win +1R, no MFE known
  pos({ entryTime: t(1, 9), exitTime: t(1, 11), move: 0.001, r: 1, duration: 7200, movePct: 0.1 }),
  // 5. Tue 15:00 win, no stop -> no R
  pos({ entryTime: t(1, 15), exitTime: t(1, 16), move: 0.0005, r: null, side: 'sell', movePct: 0.05 }),
  // an open trade is ignored everywhere
  { open: true, symbol: 'EURUSD', entryTime: t(2, 9), exitTime: null, move: null, r: null, volume: 1 },
];

test('summary: counts, win rate, R figures', () => {
  const s = S.summary(P);
  assert.equal(s.trades, 5);
  assert.equal(s.wins, 3);
  assert.equal(s.winRate, 3 / 5);
  assert.equal(s.tradesWithR, 4);          // trade 5 has no R
  assert.equal(s.avgR, (2 - 1 - 1 + 1) / 4); // 0.25R per trade
  assert.equal(s.totalR, 1);
  assert.equal(s.profitFactorR, 3 / 2);    // (+2 +1) / (1 + 1)
  assert.equal(s.avgWinR, 1.5);            // (2 + 1) / 2
  assert.equal(s.avgLossR, -1);
  assert.equal(s.bestR, 2);
  assert.equal(s.worstR, -1);
  assert.equal(s.avgHoldWin, (3600 + 7200 + 3600) / 3);
});

test('summary: MAE/MFE figures', () => {
  const s = S.summary(P);
  assert.equal(s.reached1R, 2);            // trades 1 (3R) and 2 (1.2R)
  assert.equal(s.gaveBack, 1);             // trade 2 closed at a loss after +1.2R
  assert.equal(s.captured, 0.002 / 0.003); // only trade 1 has both a win and an MFE
  assert.equal(s.avgMfeR, (3 + 1.2 + 0.2) / 3);
});

test('by hour and weekday', () => {
  const h = S.byHour(P);
  assert.equal(h.length, 24);
  const nine = h.find((g) => g.key === 9);
  assert.equal(nine.count, 2);             // trades 1 and 4
  assert.equal(nine.winRate, 1);
  assert.equal(nine.avgR, 1.5);
  assert.equal(h.find((g) => g.key === 3).count, 0);
  const w = S.byWeekday(P);
  assert.deepEqual(w.map((g) => g.key), [1, 2, 3, 4, 5, 6, 0]); // Monday first
  assert.equal(w[0].count, 3);
  assert.equal(w[1].count, 2);
});

test('by side and exit reason', () => {
  assert.deepEqual(S.bySide(P).map((g) => [g.key, g.count]), [['buy', 4], ['sell', 1]]);
  const ex = S.byExit(P);
  assert.equal(ex.find((g) => g.key === 'SL').avgR, -1);
  assert.equal(ex.find((g) => g.key === 'TP').count, 1);
});

test('behaviour after a loss', () => {
  const b = S.behaviour(P, 3600);
  // Only trade 3 was opened within 60 min after a losing trade closed.
  assert.equal(b.quickAfterLoss.count, 1);
  assert.equal(b.quickAfterLoss.winRate, 0);
  assert.equal(b.otherTrades.count, 4);
  // Median EURUSD volume is 1. After a loss: trade 3 (2x) and trade 4 (1x, after loss 3) -> 1.5
  assert.equal(b.relVolumeAfterLoss, 1.5);
  // After a win: trade 2 (after 1) and trade 5 (after 4) -> 1
  assert.equal(b.relVolumeAfterWin, 1);
  assert.equal(b.longestLossStreak, 2);
  assert.equal(b.longestWinStreak, 2);     // trades 4 and 5
});

test('execution per symbol', () => {
  const ps = [
    pos({ entryTime: 1, exitTime: 2, move: -1, exitReason: 'SL', entryFill: { spreadPoints: 10 }, exitFill: { slippagePoints: 5 } }),
    pos({ entryTime: 3, exitTime: 4, move: -1, exitReason: 'SL', entryFill: { spreadPoints: 20 }, exitFill: { slippagePoints: -1 } }),
    pos({ entryTime: 5, exitTime: 6, move: 1, exitReason: 'TP', entryFill: { spreadPoints: 30 }, exitFill: { slippagePoints: 9 } }),
  ];
  assert.deepEqual(S.execution(ps), [{ symbol: 'EURUSD', medianSpreadPoints: 20, stopExits: 2,
    stopExitsWorse: 1, medianStopSlippagePoints: 2 }]);
});

test('no trades at all', () => {
  const s = S.summary([]);
  assert.equal(s.trades, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.avgR, null);
});

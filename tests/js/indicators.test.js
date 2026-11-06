// Indicators checked against values worked out by hand.
// Run: node --test tests/js
const test = require('node:test');
const assert = require('node:assert/strict');
const { sma, ema, bollinger, rsi, macd } = require('../../static/indicators.js');

function close(actual, expected, places = 9) {
  assert.equal(actual.length, expected.length, 'length');
  actual.forEach((a, i) => {
    if (expected[i] === null) return assert.equal(a, null, `index ${i}`);
    assert.ok(Math.abs(a - expected[i]) < 10 ** -places, `index ${i}: ${a} != ${expected[i]}`);
  });
}

// ---- Simple moving average (same hand examples as the first version) ----
test('SMA period 3 on 1..5: (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});
test('SMA period 2: 15, 25, 35', () => {
  assert.deepEqual(sma([10, 20, 30, 40], 2), [null, 15, 25, 35]);
});
test('SMA period 4 on 3,1,4,1,5,9,2,6: 2.25, 2.75, 4.75, 4.25, 5.5', () => {
  assert.deepEqual(sma([3, 1, 4, 1, 5, 9, 2, 6], 4), [null, null, null, 2.25, 2.75, 4.75, 4.25, 5.5]);
});
test('SMA on forex prices: 1.1005, 1.1015, 1.1025', () => {
  close(sma([1.1, 1.101, 1.102, 1.103], 2), [null, 1.1005, 1.1015, 1.1025]);
});
test('SMA edge cases', () => {
  assert.deepEqual(sma([7, 8, 9], 1), [7, 8, 9]);
  assert.deepEqual(sma([2, 4], 3), [null, null]);
  assert.deepEqual(sma([], 3), []);
  assert.throws(() => sma([1, 2, 3], 0));
});

// ---- Exponential moving average ----
test('EMA period 3 on 1..5 (k=0.5): start 2, then 4*.5+2*.5=3, 5*.5+3*.5=4', () => {
  close(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});
test('EMA period 2 on 2,4,6,8,12 (k=2/3): 3, 5, 7, 31/3', () => {
  // start (2+4)/2=3; 6*2/3+3/3=5; 8*2/3+5/3=7; 12*2/3+7/3=31/3
  close(ema([2, 4, 6, 8, 12], 2), [null, 3, 5, 7, 31 / 3]);
});
test('EMA skips leading nulls', () => {
  close(ema([null, null, 2, 4, 6], 2), [null, null, null, 3, 5]);
});

// ---- Bollinger Bands ----
test('Bollinger(3, 2) on 1..5: sd of each window = sqrt(2/3)', () => {
  // window 1,2,3: mean 2, variance (1+0+1)/3 = 2/3, sd = 0.816497, 2*sd = 1.632993
  const sd2 = 2 * Math.sqrt(2 / 3);
  const b = bollinger([1, 2, 3, 4, 5], 3, 2);
  close(b.middle, [null, null, 2, 3, 4]);
  close(b.upper, [null, null, 2 + sd2, 3 + sd2, 4 + sd2]);
  close(b.lower, [null, null, 2 - sd2, 3 - sd2, 4 - sd2]);
});
test('Bollinger of a flat line has zero width', () => {
  const b = bollinger([5, 5, 5, 5], 2, 2);
  close(b.upper, [null, 5, 5, 5]);
  close(b.lower, [null, 5, 5, 5]);
});

// ---- RSI ----
test('RSI(2) on 1,2,3,2,3,4: 100, 50, 75, 87.5', () => {
  // changes +1 +1 -1 +1 +1
  // start: gain (1+1)/2 = 1, loss 0           -> RSI 100
  // -1:    gain (1+0)/2 = .5, loss (0+1)/2=.5  -> RS 1 -> 50
  // +1:    gain (.5+1)/2=.75, loss .25         -> RS 3 -> 75
  // +1:    gain .875, loss .125                -> RS 7 -> 87.5
  close(rsi([1, 2, 3, 2, 3, 4], 2), [null, null, 100, 50, 75, 87.5]);
});
test('RSI of a flat line is 50, and too little data gives nulls', () => {
  close(rsi([3, 3, 3, 3], 2), [null, null, 50, 50]);
  assert.deepEqual(rsi([1, 2], 2), [null, null]);
});

// ---- MACD ----
test('MACD(2,3,2) on 1..6: line 0.5 everywhere, signal 0.5, histogram 0', () => {
  // EMA2: 1.5, 2.5, 3.5, 4.5, 5.5   EMA3: 2, 3, 4, 5   -> line = 0.5 from index 2
  const m = macd([1, 2, 3, 4, 5, 6], 2, 3, 2);
  close(m.line, [null, null, 0.5, 0.5, 0.5, 0.5]);
  close(m.signal, [null, null, null, 0.5, 0.5, 0.5]);
  close(m.histogram, [null, null, null, 0, 0, 0]);
});
test('MACD(2,3,2) on 1,2,4,8,16: worked out step by step', () => {
  // EMA2 (k=2/3): 1.5, 4*2/3+1.5/3=3.1667, 8*2/3+3.1667/3=6.3889, 16*2/3+6.3889/3=12.7963
  // EMA3 (k=1/2): (1+2+4)/3=2.3333, 8*.5+2.3333*.5=5.1667, 16*.5+5.1667*.5=10.5833
  // line: 3.1667-2.3333=0.8333, 6.3889-5.1667=1.2222, 12.7963-10.5833=2.2130
  // signal EMA2 of line: (0.8333+1.2222)/2=1.0278, 2.2130*2/3+1.0278/3=1.8179
  const m = macd([1, 2, 4, 8, 16], 2, 3, 2);
  close(m.line, [null, null, 5 / 6, 11 / 9, 239 / 108], 9);
  // As exact fractions: line = 5/6, 11/9, 239/108; signal = 37/36, then
  // (239/108)*2/3 + (37/36)/3 = (2*239/108 + 37/36) / 3
  const signal4 = (2 * 239 / 108 + 37 / 36) / 3;
  close(m.signal, [null, null, null, 37 / 36, signal4], 9);
  close(m.histogram, [null, null, null, 11 / 9 - 37 / 36, 239 / 108 - signal4], 9);
});

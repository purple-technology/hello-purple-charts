// CSV export, alert rules and replay arithmetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const CSV = require('../../static/csv.js');
const A = require('../../static/alerts.js');
const D = require('../../static/drawmath.js');

// ---- CSV ----
test('CSV cells: numbers, empty values, quotes, commas', () => {
  assert.equal(CSV.cell(1.2345), '1.2345');
  assert.equal(CSV.cell(null), '');
  assert.equal(CSV.cell(NaN), '');
  assert.equal(CSV.cell('EU50'), 'EU50');
  assert.equal(CSV.cell('a,b'), '"a,b"');
  assert.equal(CSV.cell('say "hi"'), '"say ""hi"""');
});
test('CSV cells: text that looks like a formula is neutralised', () => {
  assert.equal(CSV.cell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(CSV.cell('+1'), "'+1");
  assert.equal(CSV.cell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(CSV.cell(-5), '-5'); // a real negative number stays a number
});
test('CSV table and time format', () => {
  const out = CSV.toCSV([{ key: 't', label: 'time' }, { key: 'c', label: 'close' }],
    [{ t: CSV.isoTime(0), c: 1.1 }, { t: CSV.isoTime(90), c: null }]);
  assert.equal(out, 'time,close\r\n1970-01-01 00:00:00,1.1\r\n1970-01-01 00:01:30,\r\n');
});

// ---- Alerts ----
const above = { id: 'a', kind: 'price_above', value: 1.2 };
const below = { id: 'b', kind: 'rsi_below', value: 30 };
test('first check only records the state (no instant fire)', () => {
  assert.deepEqual(A.evaluate(above, 1.25, undefined), { state: true, fire: false });
  assert.deepEqual(A.evaluate(above, 1.15, undefined), { state: false, fire: false });
});
test('fires on a crossing, once', () => {
  assert.deepEqual(A.evaluate(above, 1.2, false), { state: true, fire: true }); // exactly on the level counts
  assert.deepEqual(A.evaluate(above, 1.3, true), { state: true, fire: false });  // still above: no repeat
  assert.deepEqual(A.evaluate(below, 29, false), { state: true, fire: true });
  assert.deepEqual(A.evaluate(below, 31, true), { state: false, fire: false });
});
test('missing value keeps the previous state', () => {
  assert.deepEqual(A.evaluate(above, null, false), { state: false, fire: false });
  assert.deepEqual(A.evaluate(above, NaN, true), { state: true, fire: false });
});
test('one server request per symbol and timeframe', () => {
  const r = A.requests([
    { symbol: 'EURUSD', kind: 'price_above', value: 1, active: true },
    { symbol: 'EURUSD', kind: 'price_below', value: 0.9, active: true },
    { symbol: 'EURUSD', kind: 'rsi_above', value: 70, tf: 'H1', period: 14, active: true },
    { symbol: 'XAUUSD', kind: 'price_above', value: 3000, active: false },
  ]);
  assert.deepEqual(r, [
    { symbol: 'EURUSD', tf: 'M1', count: 1 },
    { symbol: 'EURUSD', tf: 'H1', count: 141 }, // RSI needs history: 14 x 10 + 1
  ]);
});
test('alert descriptions', () => {
  assert.equal(A.describe({ symbol: 'EURUSD', kind: 'price_above', value: 1.2 }), 'EURUSD ≥ 1.2');
  assert.equal(A.describe({ symbol: 'EURUSD', kind: 'rsi_below', value: 30, tf: 'H1', period: 14 }), 'EURUSD RSI(14) H1 ≤ 30');
});

// ---- Replay ----
test('replay shows only closed candles', () => {
  const H = 3600;
  const times = [0, H, 2 * H, 3 * H];
  assert.equal(D.completedBarCount(times, H, 0), 0);         // first candle still running
  assert.equal(D.completedBarCount(times, H, H), 1);         // 01:00: candle 00:00 just closed
  assert.equal(D.completedBarCount(times, H, 2.5 * H), 2);   // 02:30: candles 0 and 1 closed
  assert.equal(D.completedBarCount(times, H, 10 * H), 4);
  // Daily candles at 01:00 on day 3: only days 1 and 2 have closed
  const day = 86400;
  assert.equal(D.completedBarCount([0, day, 2 * day], day, 2 * day + H), 2);
});

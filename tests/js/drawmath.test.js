// Drawing-tool geometry checked by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../static/drawmath.js');

// Hourly candles at 0h, 1h, 2h, then a weekend gap, then 50h.
const H = 3600;
const times = [0, H, 2 * H, 50 * H];

test('a time exactly on a candle gives that candle number', () => {
  assert.equal(D.timeToLogical(times, H, H), 1);
  assert.equal(D.timeToLogical(times, 50 * H, H), 3);
});

test('a time between candles is a fraction', () => {
  assert.equal(D.timeToLogical(times, 1.5 * H, H), 1.5);
  // Across the gap: 2h..50h is one step, so 26h is halfway: 2.5
  assert.equal(D.timeToLogical(times, 26 * H, H), 2.5);
});

test('beyond the last candle we keep counting in timeframe steps', () => {
  assert.equal(D.timeToLogical(times, 53 * H, H), 6);
  assert.equal(D.timeToLogical(times, -2 * H, H), -2);
});

test('logicalToTime undoes timeToLogical', () => {
  for (const t of [0, 0.25 * H, H, 1.5 * H, 26 * H, 50 * H, 60 * H, -3 * H]) {
    assert.equal(D.logicalToTime(times, D.timeToLogical(times, t, H), H), t);
  }
});

test('a line drawn on H1 lands in the right place on D1', () => {
  const day = 86400;
  const daily = [0, day, 2 * day];
  // 06:00 on day 1 is a quarter of the way from candle 1 to candle 2
  assert.equal(D.timeToLogical(daily, day + 6 * H, day), 1.25);
});

test('no candles: nothing to convert', () => {
  assert.equal(D.timeToLogical([], 5, H), null);
  assert.equal(D.logicalToTime([], 1, H), null);
});

test('distance from a point to a line segment', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.equal(D.distanceToSegment({ x: 5, y: 3 }, a, b), 3);   // above the middle
  assert.equal(D.distanceToSegment({ x: 13, y: 4 }, a, b), 5);  // past the end: 3-4-5 triangle
  assert.equal(D.distanceToSegment({ x: 2, y: 2 }, a, a), Math.hypot(2, 2)); // zero-length line
});

test('inside a rectangle, with either corner order', () => {
  const a = { x: 10, y: 10 };
  const b = { x: 0, y: 0 };
  assert.ok(D.insideRect({ x: 5, y: 5 }, a, b));
  assert.ok(!D.insideRect({ x: 12, y: 5 }, a, b));
  assert.ok(D.insideRect({ x: 12, y: 5 }, a, b, 3));
});

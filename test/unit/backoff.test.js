const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeBackoffDelay, DEFAULT_TIMINGS } = require('../../src/services/DockerMonitor');

const timings = { reconnectInitialMs: 1000, reconnectMaxMs: 30000 };
const bases = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];

test('the delay spans [base/2, base] with base doubling from 1000 and capped at 30000', () => {
  bases.forEach((base, attempt) => {
    assert.equal(computeBackoffDelay(attempt, timings, () => 0), base / 2, `attempt ${attempt}, random 0`);
    assert.equal(computeBackoffDelay(attempt, timings, () => 1), base, `attempt ${attempt}, random 1`);
    assert.equal(computeBackoffDelay(attempt, timings, () => 0.5), (base * 3) / 4, `attempt ${attempt}, random 0.5`);
  });
});

test('the cap holds for very large attempt counts', () => {
  assert.equal(computeBackoffDelay(1000, timings, () => 1), 30000);
  assert.equal(computeBackoffDelay(1000, timings, () => 0), 15000);
});

test('the default timings reproduce the design schedule and random delays stay in bounds', () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const base = Math.min(30000, 1000 * 2 ** attempt);
    const delay = computeBackoffDelay(attempt, DEFAULT_TIMINGS);
    assert.ok(Number.isInteger(delay), `attempt ${attempt}: ${delay} is an integer`);
    assert.ok(delay >= base / 2 && delay <= base, `attempt ${attempt}: ${delay} within [${base / 2}, ${base}]`);
  }
});

test('injected timings are honoured', () => {
  const fast = { reconnectInitialMs: 20, reconnectMaxMs: 100 };
  assert.deepEqual([0, 1, 2, 3, 4].map((attempt) => computeBackoffDelay(attempt, fast, () => 1)), [20, 40, 80, 100, 100]);
});

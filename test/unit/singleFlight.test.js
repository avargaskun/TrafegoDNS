const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SingleFlight } = require('../../src/utils/singleFlight');
const { waitFor } = require('../helpers/waitFor');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeControlledFlight() {
  const calls = [];
  const pending = [];
  let active = 0;
  let maxActive = 0;
  const sf = new SingleFlight(async (arg) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(arg);
    const d = deferred();
    pending.push(d);
    try {
      return await d.promise;
    } finally {
      active -= 1;
    }
  });
  return {
    sf,
    calls,
    pending,
    stats: () => ({ active, maxActive })
  };
}

test('never runs two executions at once', async () => {
  const { sf, pending, stats } = makeControlledFlight();
  const first = sf.run('A');
  await waitFor(() => pending.length === 1, 1000, 'first run to start');
  const second = sf.run('B');
  assert.equal(stats().active, 1);
  pending[0].resolve('a');
  await waitFor(() => pending.length === 2, 1000, 'rerun to start');
  assert.equal(stats().active, 1);
  pending[1].resolve('b');
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.equal(stats().maxActive, 1);
  assert.equal(sf.running, false);
});

test('three calls during a run lead to exactly one rerun with the last arguments', async () => {
  const { sf, calls, pending } = makeControlledFlight();
  const first = sf.run('A');
  await waitFor(() => pending.length === 1, 1000, 'first run to start');
  const queued = [sf.run('B'), sf.run('C'), sf.run('D')];
  pending[0].resolve('a');
  await waitFor(() => pending.length === 2, 1000, 'rerun to start');
  pending[1].resolve('d');
  await Promise.all([first, ...queued]);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['A', 'D']);
});

test('callers that arrive during a run receive the rerun result', async () => {
  const { sf, pending } = makeControlledFlight();
  const first = sf.run('A');
  await waitFor(() => pending.length === 1, 1000, 'first run to start');
  const second = sf.run('B');
  const third = sf.run('C');
  assert.equal(second, third);
  pending[0].resolve('result-A');
  await waitFor(() => pending.length === 2, 1000, 'rerun to start');
  pending[1].resolve('result-C');
  assert.equal(await first, 'result-A');
  assert.equal(await second, 'result-C');
  assert.equal(await third, 'result-C');
});

test('a rejection reaches only its own callers and the queued rerun still runs', async () => {
  const { sf, calls, pending } = makeControlledFlight();
  const first = sf.run('A');
  await waitFor(() => pending.length === 1, 1000, 'first run to start');
  const second = sf.run('B');
  pending[0].reject(new Error('run A failed'));
  await assert.rejects(first, /run A failed/);
  await waitFor(() => pending.length === 2, 1000, 'rerun to start');
  pending[1].resolve('result-B');
  assert.equal(await second, 'result-B');
  assert.deepEqual(calls, ['A', 'B']);
});

test('a call in the hand-off window joins the queued rerun instead of starting another execution', async () => {
  const { sf, calls, pending, stats } = makeControlledFlight();
  const helper = async () => {
    await sf.run('A');
  };
  const helperDone = helper();
  await waitFor(() => pending.length === 1, 1000, 'first run to start');
  const queued = sf.run('B');
  pending[0].resolve('a');
  await helperDone;
  const late = sf.run('C');
  await waitFor(() => pending.length >= 2, 1000, 'rerun to start');
  await new Promise(setImmediate);
  for (const d of pending) d.resolve('rerun');
  await Promise.all([queued, late]);
  assert.equal(stats().maxActive, 1);
  assert.deepEqual(calls, ['A', 'C']);
});

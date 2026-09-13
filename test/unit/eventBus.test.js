const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');

function axiosLikeError(message) {
  return Object.assign(new Error(message), {
    code: 'ERR_BAD_RESPONSE',
    config: { headers: { Authorization: 'Bearer SYNTHETIC-TOKEN' } },
    response: { status: 525 }
  });
}

function trackUnhandledRejections(t) {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return reasons;
}

test('a throwing or rejecting subscriber is logged sanitised and does not stop the others', async (t) => {
  const { entries, lines } = captureLogs(t);
  const unhandled = trackUnhandledRejections(t);
  const bus = new EventBus();
  const received = [];

  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, () => {
    throw axiosLikeError('sync subscriber failed');
  });
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, async () => {
    throw axiosLikeError('async subscriber failed');
  });
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, (data) => received.push(data));

  bus.publish(EventTypes.DNS_RECORDS_UPDATED, { stats: 1 });

  assert.deepEqual(received, [{ stats: 1 }]);
  await waitFor(() => entries.filter((e) => e.level === 'ERROR').length === 2, 1000, 'both subscriber errors to be logged');
  const errors = entries.filter((e) => e.level === 'ERROR').map((e) => e.text);
  assert.ok(errors.some((text) => text.includes(`Error in ${EventTypes.DNS_RECORDS_UPDATED} subscriber: sync subscriber failed code=ERR_BAD_RESPONSE status=525`)));
  assert.ok(errors.some((text) => text.includes(`Error in ${EventTypes.DNS_RECORDS_UPDATED} subscriber: async subscriber failed code=ERR_BAD_RESPONSE status=525`)));
  for (const line of lines) {
    assert.ok(!line.includes('SYNTHETIC-TOKEN'), `leaked token: ${line}`);
    assert.ok(!line.includes('Authorization'), `leaked header name: ${line}`);
    assert.ok(!line.includes('Bearer'), `leaked auth scheme: ${line}`);
  }

  await new Promise(setImmediate);
  assert.deepEqual(unhandled, []);
});

test('unsubscribing removes the wrapped handler', (t) => {
  captureLogs(t);
  const bus = new EventBus();
  let removedCalls = 0;
  let keptCalls = 0;
  const unsubscribe = bus.subscribe(EventTypes.DOCKER_LABELS_UPDATED, () => {
    removedCalls += 1;
  });
  bus.subscribe(EventTypes.DOCKER_LABELS_UPDATED, () => {
    keptCalls += 1;
  });

  bus.publish(EventTypes.DOCKER_LABELS_UPDATED, {});
  assert.equal(removedCalls, 1);
  assert.equal(keptCalls, 1);

  unsubscribe();
  bus.publish(EventTypes.DOCKER_LABELS_UPDATED, {});
  assert.equal(removedCalls, 1);
  assert.equal(keptCalls, 2);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DNSManager = require('../../src/services/DNSManager');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');
const { createStubDnsProvider } = require('../helpers/stubDnsProvider');

const MANAGE = { 'dns.manage': 'true' };

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafegodns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function trackerEntry(name, id, extra = {}) {
  return {
    id,
    provider: 'cloudflare',
    domain: 'example.com',
    name,
    type: 'CNAME',
    createdAt: '2026-01-01T00:00:00.000Z',
    managedBy: 'TráfegoDNS',
    ...extra
  };
}

function readTracker(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'dns-records.json'), 'utf8'));
}

function createManager(t, { config = {}, stub = createStubDnsProvider(), seed } = {}) {
  const dataDir = makeTmpDir(t);
  if (seed) fs.writeFileSync(path.join(dataDir, 'dns-records.json'), JSON.stringify(seed, null, 2), 'utf8');
  const bus = new EventBus();
  const dnsManager = new DNSManager(makeConfig({ cleanupOrphaned: false, ...config }), bus, { dnsProvider: stub, dataDir });
  const updates = [];
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, (data) => updates.push(data));
  return { bus, dnsManager, stub, dataDir, updates };
}

function labelsFor(hostnames, labels = MANAGE) {
  return Object.fromEntries(hostnames.map((hostname) => [hostname, labels]));
}

async function runPass(harness, hostnames, containerLabels = labelsFor(hostnames)) {
  const before = harness.updates.length;
  harness.bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames, containerLabels });
  await waitFor(() => harness.updates.length > before, 2000, 'DNS_RECORDS_UPDATED');
  return harness.updates[harness.updates.length - 1];
}

function managingLines(entries) {
  return entries
    .filter((entry) => entry.level === 'INFO' && / Managing \d+ hostnames/.test(entry.text))
    .map((entry) => entry.text.slice(entry.text.indexOf('Managing ')));
}

test('with cleanupOrphaned off, DNS passes never run orphan cleanup or delete records', async (t) => {
  captureLogs(t);
  const harness = createManager(t);
  const cleanup = t.mock.method(harness.dnsManager, 'cleanupOrphanedRecords');
  const deleteRecord = t.mock.method(harness.stub, 'deleteRecord');

  await runPass(harness, ['a.example.com', 'b.example.com']);
  await runPass(harness, ['b.example.com']);
  await runPass(harness, []);
  await runPass(harness, ['c.example.com']);

  assert.equal(harness.stub.batches.length, 3);
  assert.equal(cleanup.mock.callCount(), 0);
  assert.equal(deleteRecord.mock.callCount(), 0);
  assert.equal(harness.stub.records.length, 3);
});

test('with cleanupOrphaned on, the cleanup spy is reached with the processed hostnames', async (t) => {
  captureLogs(t);
  const harness = createManager(t, { config: { cleanupOrphaned: true } });
  const cleanup = t.mock.method(harness.dnsManager, 'cleanupOrphanedRecords', async () => {});

  await runPass(harness, ['a.example.com']);

  assert.equal(cleanup.mock.callCount(), 1);
  assert.deepEqual(cleanup.mock.calls[0].arguments, [['a.example.com']]);
});

test('passes keep every pre-seeded tracker entry and change only id/updatedAt', async (t) => {
  captureLogs(t);
  const seed = [
    trackerEntry('a.example.com', 'old-a'),
    trackerEntry('b.example.com', 'old-b'),
    trackerEntry('c.example.com', 'old-c'),
    trackerEntry('gone.example.com', 'old-gone')
  ];
  const stub = createStubDnsProvider({
    records: [
      { id: 'rec-a', type: 'CNAME', name: 'a.example.com', content: 'example.com', proxied: true, ttl: 1 },
      { id: 'rec-b', type: 'CNAME', name: 'b.example.com', content: 'other.example.com', proxied: true, ttl: 1 }
    ]
  });
  const harness = createManager(t, { stub, seed });
  const deleteRecord = t.mock.method(stub, 'deleteRecord');

  await runPass(harness, ['a.example.com', 'b.example.com', 'c.example.com']);
  await runPass(harness, ['a.example.com', 'b.example.com']);
  await runPass(harness, ['a.example.com']);

  assert.deepEqual(stub.created.map((record) => record.name), ['c.example.com']);
  assert.deepEqual(stub.updated.map((record) => record.name), ['b.example.com']);
  assert.deepEqual(stub.unchanged.map((record) => record.name).sort(), [
    'a.example.com',
    'a.example.com',
    'a.example.com',
    'b.example.com'
  ]);
  assert.equal(deleteRecord.mock.callCount(), 0);

  const after = readTracker(harness.dataDir);
  assert.equal(after.length, seed.length);
  const byName = new Map(after.map((entry) => [entry.name, entry]));
  const expectedIds = { 'a.example.com': 'rec-a', 'b.example.com': 'rec-b', 'c.example.com': 'stub-1', 'gone.example.com': 'old-gone' };
  for (const original of seed) {
    const entry = byName.get(original.name);
    assert.ok(entry, `tracker entry ${original.name} still exists`);
    assert.equal(entry.id, expectedIds[original.name]);
    assert.equal('orphanedAt' in entry, false);
    const { id: _id, updatedAt, ...rest } = entry;
    const { id: _origId, ...originalRest } = original;
    assert.deepEqual(rest, originalRest);
    if (original.name === 'gone.example.com') {
      assert.equal(updatedAt, undefined);
    } else {
      assert.equal(typeof updatedAt, 'string');
    }
  }
});

test('the managed-set INFO line reports the first pass, then only changes, capped at 10 entries', async (t) => {
  const { entries } = captureLogs(t, 'INFO');
  const harness = createManager(t);

  await runPass(harness, ['a.example.com', 'b.example.com']);
  assert.deepEqual(managingLines(entries), ['Managing 2 hostnames']);

  await runPass(harness, ['b.example.com', 'c.example.com']);
  assert.deepEqual(managingLines(entries).slice(1), ['Managing 2 hostnames (+c.example.com, -a.example.com)']);

  await runPass(harness, ['c.example.com', 'b.example.com']);
  assert.equal(managingLines(entries).length, 2);

  const added = Array.from({ length: 12 }, (_, i) => `h${String(i + 1).padStart(2, '0')}.example.com`);
  await runPass(harness, ['b.example.com', 'c.example.com', ...added]);
  const shown = added.slice(0, 10).map((hostname) => `+${hostname}`).join(', ');
  assert.deepEqual(managingLines(entries).slice(2), [`Managing 14 hostnames (${shown}, … (+2 more))`]);

  await runPass(harness, ['b.example.com'], { 'b.example.com': MANAGE, 'c.example.com': MANAGE });
  const removed = ['c.example.com', ...added].sort().map((hostname) => `-${hostname}`);
  assert.deepEqual(managingLines(entries).slice(3), [`Managing 1 hostnames (${removed.slice(0, 10).join(', ')}, … (+3 more))`]);
});

test('the managed-set line lists additions before removals and counts unmanaged hostnames out', async (t) => {
  const { entries } = captureLogs(t, 'INFO');
  const harness = createManager(t);

  await runPass(harness, ['b.example.com', 'a.example.com', 'z.example.com']);
  await runPass(harness, ['z.example.com', 'plain.example.com', 'n.example.com', 'm.example.com'], {
    'm.example.com': MANAGE,
    'n.example.com': MANAGE,
    'z.example.com': MANAGE
  });

  assert.deepEqual(managingLines(entries), [
    'Managing 3 hostnames',
    'Managing 3 hostnames (+m.example.com, +n.example.com, -a.example.com, -b.example.com)'
  ]);
});

test('DNS passes never overlap, and publishes during a pass lead to one follow-up with the latest payload', async (t) => {
  captureLogs(t);
  const harness = createManager(t);
  const { stub } = harness;
  const gate = deferred();
  const original = stub.batchEnsureRecords;
  let active = 0;
  let maxActive = 0;
  const batchEnsure = t.mock.method(stub, 'batchEnsureRecords', async (configs) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await gate.promise;
      return await original.call(stub, configs);
    } finally {
      active--;
    }
  });

  harness.bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames: ['first.example.com'], containerLabels: labelsFor(['first.example.com']) });
  await waitFor(() => batchEnsure.mock.callCount() === 1, 2000, 'the first pass to reach the provider');

  harness.bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames: ['second.example.com'], containerLabels: labelsFor(['second.example.com']) });
  harness.bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames: ['third.example.com'], containerLabels: labelsFor(['third.example.com']) });
  await new Promise(setImmediate);
  assert.equal(batchEnsure.mock.callCount(), 1);

  gate.resolve();
  await waitFor(() => harness.updates.length === 2, 2000, 'the follow-up pass');
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(maxActive, 1);
  assert.equal(stub.batches.length, 2);
  assert.deepEqual(stub.batches[0].map((config) => config.name), ['first.example.com']);
  assert.deepEqual(stub.batches[1].map((config) => config.name), ['third.example.com']);
  assert.equal(harness.updates.length, 2);
  assert.deepEqual(harness.updates[1].processedHostnames, ['third.example.com']);
});

test('a failing pass is logged by the EventBus guard and the next pass still runs', async (t) => {
  const { entries } = captureLogs(t);
  const harness = createManager(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const original = harness.stub.batchEnsureRecords;
  let fail = true;
  t.mock.method(harness.stub, 'batchEnsureRecords', async (configs) => {
    if (fail) throw new Error('provider unavailable');
    return original.call(harness.stub, configs);
  });

  harness.bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames: ['a.example.com'], containerLabels: labelsFor(['a.example.com']) });
  await waitFor(
    () => entries.some((entry) => entry.level === 'ERROR' && entry.text.includes('Error in traefik:routers:updated subscriber: provider unavailable')),
    2000,
    'the guarded subscriber error'
  );

  fail = false;
  const update = await runPass(harness, ['a.example.com']);
  assert.deepEqual(update.processedHostnames, ['a.example.com']);
  await new Promise(setImmediate);
  assert.deepEqual(unhandled, []);
});

test('a hostname labelled dns.skip=true is unmanaged even with defaultManage on', async (t) => {
  captureLogs(t);
  const harness = createManager(t, { config: { defaultManage: true } });

  const update = await runPass(harness, ['keep.example.com', 'skip.example.com', 'provider-skip.example.com'], {
    'skip.example.com': { 'dns.skip': 'true', 'dns.manage': 'true' },
    'provider-skip.example.com': { 'dns.cloudflare.skip': 'true' }
  });

  assert.deepEqual(update.processedHostnames, ['keep.example.com']);
  assert.deepEqual(harness.stub.batches.flat().map((config) => config.name), ['keep.example.com']);
});

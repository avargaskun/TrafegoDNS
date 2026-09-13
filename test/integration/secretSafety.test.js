const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CloudflareProvider = require('../../src/providers/cloudflare/provider');
const DNSManager = require('../../src/services/DNSManager');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');
const { startFakeCloudflare } = require('../helpers/fakeCloudflare');
const { installExitWatchdog } = require('../helpers/exitWatchdog');

installExitWatchdog();

const SECRET_MARKERS = ['SYNTHETIC-TOKEN-123', 'Authorization', 'Bearer'];
const GUARD_LINE = 'Error in traefik:routers:updated subscriber:';

function recordProcessFaults(t) {
  const faults = [];
  const onRejection = (reason) => faults.push(['unhandledRejection', reason]);
  const onException = (error) => faults.push(['uncaughtException', error]);
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  t.after(() => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  });
  return faults;
}

async function assertNoFaults(faults) {
  await new Promise(setImmediate);
  assert.equal(faults.length, 0, faults.map(([kind]) => kind).join(', '));
}

function assertNoSecrets(lines) {
  const leaking = lines.filter((line) => SECRET_MARKERS.some((marker) => line.includes(marker)));
  assert.equal(leaking.length, 0, `${leaking.length} captured log lines contain a secret marker`);
}

async function setup(t, { records = [] } = {}) {
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const cloudflare = await startFakeCloudflare({ records });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafegodns-'));
  const config = makeConfig({ defaultManage: true });
  const provider = new CloudflareProvider(config);
  provider.client.defaults.baseURL = cloudflare.baseURL;
  const bus = new EventBus();
  const dnsManager = new DNSManager(config, bus, { dnsProvider: provider, dataDir });
  const updates = [];
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, (data) => updates.push(data));
  t.after(async () => {
    await cloudflare.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const publish = (hostnames) => bus.publish(EventTypes.TRAEFIK_ROUTERS_UPDATED, { hostnames, containerLabels: {} });
  return { logs, faults, cloudflare, dnsManager, updates, publish };
}

function succeeded(cloudflare, method, name) {
  return cloudflare.requests.some((r) => r.method === method && r.status === 200 && r.body?.name === name);
}

function hasLine(logs, level, text) {
  return logs.entries.some((entry) => entry.level === level && entry.text.includes(text));
}

test('a rejected Cloudflare call never leaks the token and never crashes the process', async (t) => {
  await t.test('rejection path: a failed record listing reaches the EventBus guard sanitised', async (t) => {
    const { logs, faults, cloudflare, dnsManager, updates, publish } = await setup(t);
    await dnsManager.init();
    cloudflare.failPage(1, 525);

    publish(['new.example.com']);
    await waitFor(() => logs.lines.some((line) => line.includes(GUARD_LINE)), 2000, 'the EventBus guard line');

    const guard = logs.entries.find((entry) => entry.text.includes(GUARD_LINE));
    assert.equal(guard.level, 'ERROR');
    assert.match(guard.text, /Request failed with status code 525 code=ERR_BAD_RESPONSE status=525$/);
    assert.equal(updates.length, 0);
    assertNoSecrets(logs.lines);
    await assertNoFaults(faults);

    cloudflare.failPage(null);
    publish(['new.example.com']);
    await waitFor(() => succeeded(cloudflare, 'POST', 'new.example.com'), 2000, 'a successful POST for new.example.com');
    await waitFor(() => updates.length === 1, 2000, 'the DNS pass after the fault cleared');

    assert.deepEqual(updates[0].processedHostnames, ['new.example.com']);
    assert.equal(logs.lines.filter((line) => line.includes(GUARD_LINE)).length, 1);
    assertNoSecrets(logs.lines);
    await assertNoFaults(faults);
  });

  await t.test('write path: failed creates and updates are logged by message only', async (t) => {
    const stale = { type: 'CNAME', name: 'old.example.com', content: 'stale.example.com', proxied: true, ttl: 1 };
    const { logs, faults, cloudflare, dnsManager, updates, publish } = await setup(t, { records: [stale] });
    await dnsManager.init();
    cloudflare.setWriteFailure(525);

    publish(['new.example.com', 'old.example.com']);
    await waitFor(() => updates.length === 1, 2000, 'the DNS pass with failing writes');

    assert.ok(hasLine(logs, 'ERROR', 'Failed to create CNAME record for new.example.com: Request failed with status code 525'));
    assert.ok(hasLine(logs, 'ERROR', 'Failed to update CNAME record for old.example.com: Request failed with status code 525'));
    assert.deepEqual(
      cloudflare.requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.status]),
      [['POST', 525], ['PUT', 525]]
    );
    assert.equal(logs.lines.some((line) => line.includes(GUARD_LINE)), false);
    assertNoSecrets(logs.lines);
    await assertNoFaults(faults);

    cloudflare.setWriteFailure(null);
    publish(['new.example.com', 'old.example.com']);
    await waitFor(() => updates.length === 2, 2000, 'the DNS pass after the fault cleared');

    assert.ok(succeeded(cloudflare, 'POST', 'new.example.com'));
    assert.ok(succeeded(cloudflare, 'PUT', 'old.example.com'));
    assertNoSecrets(logs.lines);
    await assertNoFaults(faults);
  });
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DockerMonitor = require('../../src/services/DockerMonitor');
const DirectDNSManager = require('../../src/services/DirectDNSManager');
const DNSManager = require('../../src/services/DNSManager');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');
const { startFakeDockerDaemon } = require('../helpers/fakeDockerDaemon');
const { createStubDnsProvider } = require('../helpers/stubDnsProvider');
const { FAST_TIMINGS, startTraefikPipeline, batchedHostnames } = require('../helpers/pipeline');
const { installExitWatchdog } = require('../helpers/exitWatchdog');

installExitWatchdog();

const REFRESH_TIMEOUT_MS = 200;

const PROXY = {
  Id: 'c'.repeat(64),
  Names: ['/proxy'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.proxy.rule': 'Host(`proxy.example.com`)' }
};
const OTHER = {
  Id: 'a'.repeat(64),
  Names: ['/other'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.other.rule': 'Host(`other.example.com`)' }
};
const LATE = {
  Id: 'f'.repeat(64),
  Names: ['/late'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.late.rule': 'Host(`late.example.com`)' }
};
const BASE = {
  Id: '1'.repeat(64),
  Names: ['/base'],
  Labels: { 'dns.hostname': 'base.example.com', 'dns.manage': 'true' }
};
const DIRECT = {
  Id: '2'.repeat(64),
  Names: ['/direct'],
  Labels: { 'dns.hostname': 'direct.example.com', 'dns.manage': 'true' }
};
const PROXY_ROUTER = { name: 'proxy@docker', provider: 'docker', entryPoints: ['https'], service: 'proxy', rule: 'Host(`proxy.example.com`)', status: 'enabled' };
const LATE_ROUTER = { name: 'late@docker', provider: 'docker', entryPoints: ['https'], service: 'late', rule: 'Host(`late.example.com`)', status: 'enabled' };

const REFRESH_FAILURE = 'Could not refresh Docker labels';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function faultSummary(faults) {
  return faults.map(([kind, error]) => `${kind}: ${error?.message ?? String(error)}`).join('; ');
}

function entriesAt(logs, level, text) {
  return logs.entries.filter((entry) => entry.level === level && entry.text.includes(text));
}

const manages = (hostname) => (update) =>
  update.hostnames.includes(hostname) && update.containerLabels[hostname]?.['dns.manage'] === 'true';

async function startDirectPipeline(t, { containers = [] } = {}) {
  const daemon = await startFakeDockerDaemon();
  daemon.setContainers(containers);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafegodns-'));
  const config = makeConfig({ operationMode: 'direct' });
  const bus = new EventBus();
  const dockerMonitor = new DockerMonitor(config, bus, { docker: daemon.docker, timings: FAST_TIMINGS, random: () => 0.5 });
  const direct = new DirectDNSManager(config, bus);
  direct.dockerMonitor = dockerMonitor;
  const stub = createStubDnsProvider();
  const dnsManager = new DNSManager(config, bus, { dnsProvider: stub, dataDir });

  const routerUpdates = [];
  const dnsUpdates = [];
  bus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, (data) => routerUpdates.push(data));
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, (data) => dnsUpdates.push(data));

  t.after(async () => {
    direct.stopPolling();
    dockerMonitor.stopWatching();
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return { daemon, dockerMonitor, direct, dnsManager, stub, routerUpdates, dnsUpdates };
}

test('(g) a failing, then hanging, container list keeps the last good cache and DNS passes keep running', async (t) => {
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const pipeline = await startTraefikPipeline(t, {
    containers: [PROXY],
    routers: [PROXY_ROUTER],
    timings: { refreshTimeoutMs: REFRESH_TIMEOUT_MS }
  });
  const { daemon, dockerMonitor, monitor, stub, routerUpdates, dnsUpdates } = pipeline;

  await pipeline.boot();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
  assert.deepEqual(dnsUpdates[0].processedHostnames, ['proxy.example.com']);
  const goodContainers = structuredClone(dockerMonitor.getContainers());
  const goodProxyLabels = structuredClone(routerUpdates.at(-1).containerLabels['proxy.example.com']);
  assert.equal(goodProxyLabels['dns.manage'], 'true');

  daemon.setContainers([PROXY, OTHER]);
  daemon.setContainersMode('fail');
  assert.equal(daemon.emit('start', 'other', OTHER.Id), 1);
  await waitFor(() => entriesAt(logs, 'WARN', `${REFRESH_FAILURE} (trigger=event)`).length === 1, 2000, 'the event refresh WARN');

  daemon.setContainersMode('hang');
  const listBefore = daemon.stats.listRequests;
  const updatesBefore = routerUpdates.length;
  const batchesBefore = stub.batches.length;
  const passesBefore = dnsUpdates.length;
  let pollSettled = false;
  const poll = monitor.pollTraefikAPI().finally(() => { pollSettled = true; });
  await waitFor(() => pollSettled, REFRESH_TIMEOUT_MS + 1000, 'the poll to resolve despite the hanging container list');
  await poll;

  assert.equal(daemon.stats.listRequests, listBefore + 1);
  assert.equal(entriesAt(logs, 'DEBUG', `${REFRESH_FAILURE} (trigger=poll)`).length, 1);
  assert.deepEqual(dockerMonitor.getContainers(), goodContainers);
  assert.equal(entriesAt(logs, 'WARN', REFRESH_FAILURE).length, 1);
  assert.equal(logs.entries.filter((entry) => entry.level === 'WARN').length, 1);

  assert.equal(routerUpdates.length, updatesBefore + 1);
  const update = routerUpdates.at(-1);
  assert.deepEqual(update.hostnames, ['proxy.example.com']);
  assert.deepEqual(update.containerLabels['proxy.example.com'], goodProxyLabels);

  await waitFor(() => stub.batches.length > batchesBefore, 2000, 'the stub to receive the pass');
  await waitFor(() => dnsUpdates.length > passesBefore, 2000, 'the DNS pass to finish');
  assert.deepEqual(stub.batches.at(-1).map((record) => record.name), ['proxy.example.com']);
  assert.deepEqual(dnsUpdates.at(-1).processedHostnames, ['proxy.example.com']);
  assert.ok(!batchedHostnames(stub).includes('other.example.com'));
  assert.equal(faults.length, 0, faultSummary(faults));
});

test('(h) with the event stream down, a poll re-lists containers and picks up a new one without an event', async (t) => {
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const pipeline = await startTraefikPipeline(t, { containers: [PROXY], routers: [PROXY_ROUTER] });
  const { daemon, traefik, dockerMonitor, monitor, stub, routerUpdates, dnsUpdates } = pipeline;

  await pipeline.boot();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');

  daemon.setEventsMode('refuse');
  const connectionsBefore = daemon.stats.eventsConnections;
  daemon.sever();
  await waitFor(() => daemon.stats.eventsConnections >= connectionsBefore + 2, 2000, 'two refused reconnect attempts');
  assert.equal(daemon.openEventStreams(), 0);

  daemon.setContainers([PROXY, LATE]);
  traefik.setRouters([PROXY_ROUTER, LATE_ROUTER]);
  const listBefore = daemon.stats.listRequests;
  const updatesBefore = routerUpdates.length;
  await monitor.pollTraefikAPI();

  assert.equal(daemon.stats.listRequests, listBefore + 1);
  assert.ok(dockerMonitor.getContainers().some((c) => c.name === 'late'));
  assert.equal(routerUpdates.length, updatesBefore + 1);
  assert.ok(manages('late.example.com')(routerUpdates.at(-1)), 'the poll publishes late.example.com as managed');

  await waitFor(() => batchedHostnames(stub).includes('late.example.com'), 2000, 'a stub batch with late.example.com');
  await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('late.example.com')), 2000, 'the DNS pass with late to finish');
  assert.deepEqual(dnsUpdates.at(-1).processedHostnames, ['proxy.example.com', 'late.example.com']);
  assert.equal(daemon.openEventStreams(), 0);
  assert.equal(logs.lines.filter((line) => line.includes('Docker event start')).length, 0);
  const warnings = logs.entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warnings.length, 1, warnings.map((entry) => entry.text).join('\n'));
  assert.match(warnings[0].text, /Docker event stream (error: .*|ended); reconnecting$/);
  assert.equal(faults.length, 0, faultSummary(faults));
});

test('direct mode: every poll re-lists containers and picks up a container added without an event', async (t) => {
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const { daemon, dockerMonitor, direct, dnsManager, stub, routerUpdates, dnsUpdates } = await startDirectPipeline(t, { containers: [BASE] });

  await dockerMonitor.startWatching();
  await dnsManager.init();
  await direct.init();
  await direct.startPolling();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
  assert.deepEqual(dnsUpdates[0].processedHostnames, ['base.example.com']);

  daemon.setContainers([BASE, DIRECT]);
  const listBefore = daemon.stats.listRequests;
  const updatesBefore = routerUpdates.length;
  const batchesBefore = stub.batches.length;
  await direct.pollContainers();

  assert.ok(daemon.stats.listRequests > listBefore, 'the poll re-listed containers');
  assert.equal(routerUpdates.length, updatesBefore + 1, 'the nested poll from the label update is skipped');
  assert.ok(logs.lines.some((line) => line.includes('Skipping poll - another poll cycle is already in progress')));
  assert.ok(routerUpdates.at(-1).hostnames.includes('direct.example.com'));

  await waitFor(() => stub.batches.slice(batchesBefore).some((batch) => batch.some((record) => record.name === 'direct.example.com')), 2000, 'a stub batch with direct.example.com');
  await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('direct.example.com')), 2000, 'the DNS pass with direct to finish');
  assert.deepEqual(dnsUpdates.at(-1).processedHostnames.slice().sort(), ['base.example.com', 'direct.example.com']);
  assert.equal(logs.lines.filter((line) => line.includes('Docker event start')).length, 0);
  assert.equal(faults.length, 0, faultSummary(faults));
});

test('direct mode: the boot label refresh starts no DNS pass before the DNS manager is initialised', async (t) => {
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const { dockerMonitor, direct, dnsManager, stub, routerUpdates, dnsUpdates } = await startDirectPipeline(t, { containers: [DIRECT] });

  await dockerMonitor.startWatching();
  assert.ok(logs.lines.some((line) => line.includes('Docker labels refreshed (trigger=boot): 1 running containers; DNS label changes: direct')));
  await sleep(200);
  assert.equal(routerUpdates.length, 0);
  assert.ok(!stub.calls.includes('batchEnsureRecords'));

  await dnsManager.init();
  await direct.startPolling();
  await waitFor(() => batchedHostnames(stub).includes('direct.example.com'), 2000, 'a stub batch with direct.example.com');
  await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('direct.example.com')), 2000, 'the DNS pass with direct to finish');

  assert.ok(stub.calls.includes('init'));
  assert.ok(stub.calls.indexOf('init') < stub.calls.indexOf('batchEnsureRecords'), `call order: ${stub.calls.join(', ')}`);
  assert.equal(routerUpdates.length, 1);
  assert.equal(faults.length, 0, faultSummary(faults));
});

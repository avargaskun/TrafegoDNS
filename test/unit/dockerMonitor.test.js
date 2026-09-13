const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const DockerMonitor = require('../../src/services/DockerMonitor');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');

const APP_ID = 'a1'.repeat(32);
const DB_ID = 'b2'.repeat(32);
const APP_LABELS = { 'traefik.enable': 'true', 'dns.manage': 'true' };

function dockerContainer(id, name, labels) {
  return { Id: id, Names: [`/${name}`], Labels: labels };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hangUntilAborted(opts) {
  return new Promise((_resolve, reject) => {
    opts.abortSignal.addEventListener('abort', () => reject(opts.abortSignal.reason), { once: true });
  });
}

function createHarness({ timings } = {}) {
  const bus = new EventBus();
  const published = [];
  bus.subscribe(EventTypes.DOCKER_LABELS_UPDATED, (data) => published.push(data));
  const state = { listCalls: [], respond: async () => [] };
  const docker = {
    listContainers: (opts) => {
      state.listCalls.push(opts);
      return state.respond(opts);
    },
    getEvents: async () => new PassThrough()
  };
  const monitor = new DockerMonitor(makeConfig(), bus, { docker, timings, random: () => 0.5 });
  return { monitor, published, state };
}

function linesContaining(entries, text) {
  return entries.filter((entry) => entry.text.includes(text));
}

test('DEFAULT_TIMINGS holds the design defaults and is exported on the module', () => {
  assert.deepEqual({ ...DockerMonitor.DEFAULT_TIMINGS }, {
    eventDebounceMs: 3000,
    eventDebounceMaxMs: 10000,
    reconnectInitialMs: 1000,
    reconnectMaxMs: 30000,
    stableConnectionMs: 30000,
    connectTimeoutMs: 10000,
    refreshTimeoutMs: 15000
  });
  assert.equal(require('../../src/services/DockerMonitor').DEFAULT_TIMINGS, DockerMonitor.DEFAULT_TIMINGS);
});

test('a successful refresh publishes one DOCKER_LABELS_UPDATED with the trigger, containers and legacy cache', async (t) => {
  captureLogs(t);
  const { monitor, published, state } = createHarness();
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS), { Id: DB_ID, Names: ['/db'] }];
  assert.equal(monitor.hasLoadedLabels(), false);
  assert.deepEqual(monitor.getContainers(), []);

  const result = await monitor.refreshLabels('boot');

  assert.deepEqual(result, { ok: true, containerCount: 2, changed: ['app'] });
  assert.equal(state.listCalls.length, 1);
  assert.equal(state.listCalls[0].all, false);
  assert.ok(state.listCalls[0].abortSignal instanceof AbortSignal);

  assert.equal(published.length, 1);
  const payload = published[0];
  assert.deepEqual(Object.keys(payload).sort(), ['containerIdToName', 'containerLabelsCache', 'containers', 'hasChanges', 'trigger']);
  assert.equal(payload.trigger, 'boot');
  assert.equal(payload.hasChanges, true);
  assert.deepEqual(payload.containers, [
    { id: APP_ID, name: 'app', labels: APP_LABELS },
    { id: DB_ID, name: 'db', labels: {} }
  ]);
  assert.deepEqual(payload.containerLabelsCache, { [APP_ID]: APP_LABELS, app: APP_LABELS, [DB_ID]: {}, db: {} });
  assert.deepEqual([...payload.containerIdToName], [[APP_ID, 'app'], [DB_ID, 'db']]);

  assert.deepEqual(monitor.getContainers(), payload.containers);
  assert.equal(monitor.getContainerLabelsCache(), payload.containerLabelsCache);
  assert.equal(monitor.getContainerName(APP_ID), 'app');
  assert.equal(monitor.hasLoadedLabels(), true);
});

test('failed and timed-out refreshes keep the last good cache, publish nothing and WARN once per outage', async (t) => {
  const { entries, lines } = captureLogs(t);
  const { monitor, published, state } = createHarness({ timings: { refreshTimeoutMs: 50 } });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  await monitor.refreshLabels('boot');
  const goodContainers = monitor.getContainers();
  const goodCache = monitor.getContainerLabelsCache();

  state.respond = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
      code: 'ECONNREFUSED',
      config: { headers: { Authorization: 'Bearer SYNTHETIC-TOKEN' } }
    });
  };
  const rejected = await monitor.refreshLabels('event');

  state.respond = hangUntilAborted;
  const startedAt = Date.now();
  const hung = await monitor.refreshLabels('poll');
  const hungMs = Date.now() - startedAt;

  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ECONNREFUSED');
  assert.equal(hung.ok, false);
  assert.equal(hung.error.name, 'TimeoutError');
  assert.ok(hungMs < 1000, `hanging list resolved after ${hungMs} ms`);

  assert.equal(monitor.getContainers(), goodContainers);
  assert.equal(monitor.getContainerLabelsCache(), goodCache);
  assert.equal(monitor.hasLoadedLabels(), true);
  assert.equal(published.length, 1);

  const warns = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(
    warns[0].text,
    /Could not refresh Docker labels \(trigger=event\): connect ECONNREFUSED \/var\/run\/docker\.sock code=ECONNREFUSED; keeping last good cache \(1 containers\)$/
  );
  const debugFailures = linesContaining(entries, 'Could not refresh Docker labels (trigger=poll)');
  assert.deepEqual(debugFailures.map((entry) => entry.level), ['DEBUG']);
  assert.match(debugFailures[0].text, /keeping last good cache \(1 containers\)$/);
  assert.ok(lines.every((line) => !line.includes('SYNTHETIC-TOKEN') && !line.includes('Authorization')));

  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  const recovered = await monitor.refreshLabels('poll');
  await monitor.refreshLabels('poll');

  assert.equal(recovered.ok, true);
  assert.equal(published.length, 3);
  const recoveryLines = linesContaining(entries, 'Docker label refresh recovered');
  assert.equal(recoveryLines.length, 1);
  assert.equal(recoveryLines[0].level, 'INFO');
  assert.match(recoveryLines[0].text, /Docker label refresh recovered \(trigger=poll\)$/);
});

test('refreshes requested during a pending list coalesce into one rerun', async (t) => {
  captureLogs(t);
  const { monitor, published, state } = createHarness();
  const responses = [deferred(), deferred()];
  state.respond = () => responses[state.listCalls.length - 1].promise;

  const first = monitor.refreshLabels('boot');
  await waitFor(() => state.listCalls.length === 1, 2000, 'the first listContainers call');
  const queued = [monitor.refreshLabels('event'), monitor.refreshLabels('event'), monitor.refreshLabels('poll')];

  responses[0].resolve([dockerContainer(APP_ID, 'app', APP_LABELS)]);
  await waitFor(() => state.listCalls.length === 2, 2000, 'the rerun listContainers call');
  responses[1].resolve([dockerContainer(APP_ID, 'app', APP_LABELS), dockerContainer(DB_ID, 'db', {})]);

  const results = await Promise.all([first, ...queued]);

  assert.equal(state.listCalls.length, 2);
  assert.deepEqual(results.map((result) => [result.ok, result.containerCount]), [[true, 1], [true, 2], [true, 2], [true, 2]]);
  assert.deepEqual(published.map((payload) => payload.trigger), ['boot', 'poll']);
});

test('the refresh summary is INFO for boot, event and changed polls, and DEBUG for unchanged polls', async (t) => {
  const { entries } = captureLogs(t);
  const { monitor, state } = createHarness();
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  await monitor.refreshLabels('boot');
  await monitor.refreshLabels('poll');
  state.respond = async () => [dockerContainer(APP_ID, 'app', { ...APP_LABELS, 'dns.proxied': 'false' })];
  await monitor.refreshLabels('poll');
  await monitor.refreshLabels('event');

  const summaries = linesContaining(entries, 'Docker labels refreshed').map((entry) => [
    entry.level,
    entry.text.slice(entry.text.indexOf('Docker labels refreshed'))
  ]);
  assert.deepEqual(summaries, [
    ['INFO', 'Docker labels refreshed (trigger=boot): 1 running containers; DNS label changes: app'],
    ['DEBUG', 'Docker labels refreshed (trigger=poll): 1 running containers; no DNS label changes'],
    ['INFO', 'Docker labels refreshed (trigger=poll): 1 running containers; DNS label changes: app'],
    ['INFO', 'Docker labels refreshed (trigger=event): 1 running containers; no DNS label changes']
  ]);
});

test('a container with DNS labels that stops running is reported once', async (t) => {
  const { entries } = captureLogs(t);
  const { monitor, published, state } = createHarness();
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS), dockerContainer(DB_ID, 'db', {})];
  await monitor.refreshLabels('boot');
  state.respond = async () => [dockerContainer(DB_ID, 'db', {})];

  const result = await monitor.refreshLabels('poll');

  assert.deepEqual(result.changed, ['app']);
  const removals = linesContaining(entries, 'no longer running');
  assert.equal(removals.length, 1);
  assert.equal(removals[0].level, 'INFO');
  assert.match(removals[0].text, /Container app with DNS labels is no longer running$/);
  assert.equal(linesContaining(entries, 'was removed').length, 0);
  assert.equal(published.at(-1).hasChanges, true);
  assert.deepEqual(monitor.getContainers().map((container) => container.name), ['db']);
});

test('startWatching refreshes labels with trigger boot', async (t) => {
  captureLogs(t);
  const { monitor, published, state } = createHarness();
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  t.after(() => monitor.stopWatching());

  await monitor.startWatching();

  assert.deepEqual(published.map((payload) => payload.trigger), ['boot']);
  assert.equal(monitor.hasLoadedLabels(), true);
});

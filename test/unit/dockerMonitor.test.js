const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const DockerMonitor = require('../../src/services/DockerMonitor');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');
const { installExitWatchdog } = require('../helpers/exitWatchdog');

installExitWatchdog();

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
    // Stands in for the pending socket: AbortSignal.timeout's timer is unref'd and alone lets the loop drain.
    const keepAlive = setInterval(() => {}, 1000);
    opts.abortSignal.addEventListener('abort', () => {
      clearInterval(keepAlive);
      reject(opts.abortSignal.reason);
    }, { once: true });
  });
}

const FAST_TIMINGS = {
  eventDebounceMs: 40,
  eventDebounceMaxMs: 200,
  reconnectInitialMs: 20,
  reconnectMaxMs: 50,
  stableConnectionMs: 1000,
  connectTimeoutMs: 500,
  refreshTimeoutMs: 500
};

function openStream(state) {
  const stream = new PassThrough();
  state.streams.push(stream);
  return stream;
}

function createHarness({ timings } = {}) {
  const bus = new EventBus();
  const published = [];
  const timeline = [];
  bus.subscribe(EventTypes.DOCKER_LABELS_UPDATED, (data) => {
    published.push(data);
    timeline.push(`labels:${data.trigger}`);
  });
  const started = [];
  const stopped = [];
  bus.subscribe(EventTypes.DOCKER_CONTAINER_STARTED, (data) => {
    started.push(data);
    timeline.push('started');
  });
  bus.subscribe(EventTypes.DOCKER_CONTAINER_STOPPED, (data) => {
    stopped.push(data);
    timeline.push('stopped');
  });
  const state = {
    listCalls: [],
    respond: async () => [],
    eventsCalls: [],
    streams: [],
    events: async () => openStream(state)
  };
  const docker = {
    listContainers: (opts) => {
      state.listCalls.push(opts);
      return state.respond(opts);
    },
    getEvents: (opts) => {
      state.eventsCalls.push(opts);
      return state.events(opts);
    }
  };
  const monitor = new DockerMonitor(makeConfig(), bus, { docker, timings, random: () => 0.5 });
  return { monitor, published, started, stopped, timeline, state };
}

function linesContaining(entries, text) {
  return entries.filter((entry) => entry.text.includes(text));
}

function containerEvent(action, name, id) {
  return {
    Type: 'container',
    Action: action,
    Actor: { ID: id, Attributes: { name, image: `ghcr.io/example/${name}:1.0` } },
    scope: 'local',
    time: 1757664000,
    timeNano: 1757664000000000000
  };
}

function writeEvent(stream, event) {
  stream.write(`${JSON.stringify(event)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refusedError() {
  return Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address: '/var/run/docker.sock'
  });
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

test('startWatching subscribes to container events without an event filter, since or API pin, then re-lists', async (t) => {
  const { entries } = captureLogs(t);
  const { monitor, state } = createHarness({ timings: FAST_TIMINGS });
  let eventsCallsAtList = null;
  state.respond = async () => {
    eventsCallsAtList = state.eventsCalls.length;
    return [dockerContainer(APP_ID, 'app', APP_LABELS)];
  };
  t.after(() => monitor.stopWatching());

  await monitor.startWatching();
  await monitor.startWatching();

  assert.equal(eventsCallsAtList, 1, 'the event stream is opened before the re-list');
  assert.equal(state.eventsCalls.length, 1);
  assert.deepEqual(Object.keys(state.eventsCalls[0]).sort(), ['abortSignal', 'filters']);
  assert.deepEqual(state.eventsCalls[0].filters, { type: ['container'] });
  assert.ok(state.eventsCalls[0].abortSignal instanceof AbortSignal);
  assert.equal(state.listCalls.length, 1);
  const successLines = linesContaining(entries, 'Docker event monitoring started successfully');
  assert.equal(successLines.length, 1);
  assert.equal(successLines[0].level, 'INFO');
});

test('five start events inside the debounce window lead to exactly one event refresh', async (t) => {
  captureLogs(t);
  const { monitor, published, started, state } = createHarness({
    timings: { ...FAST_TIMINGS, eventDebounceMs: 50, eventDebounceMaxMs: 500 }
  });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  t.after(() => monitor.stopWatching());
  await monitor.startWatching();
  assert.equal(state.listCalls.length, 1);

  for (let i = 0; i < 5; i++) writeEvent(state.streams[0], containerEvent('start', 'app', APP_ID));

  await waitFor(() => published.some((payload) => payload.trigger === 'event'), 2000, 'the event refresh');
  await sleep(150);
  assert.equal(started.length, 5);
  assert.equal(state.listCalls.length, 2);
  assert.deepEqual(published.map((payload) => payload.trigger), ['boot', 'event']);
});

test('events arriving every eventDebounceMs / 2 still refresh within eventDebounceMaxMs', async (t) => {
  captureLogs(t);
  const timings = { ...FAST_TIMINGS, eventDebounceMs: 100, eventDebounceMaxMs: 250 };
  const { monitor, published, timeline, state } = createHarness({ timings });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  t.after(() => monitor.stopWatching());
  await monitor.startWatching();

  const firstEventAt = Date.now();
  writeEvent(state.streams[0], containerEvent('start', 'app', APP_ID));
  const storm = setInterval(() => writeEvent(state.streams[0], containerEvent('start', 'app', APP_ID)), timings.eventDebounceMs / 2);
  t.after(() => clearInterval(storm));

  await waitFor(() => published.some((payload) => payload.trigger === 'event'), 2000, 'the capped event refresh');
  const elapsed = Date.now() - firstEventAt;
  clearInterval(storm);

  const eventsBeforeRefresh = timeline.slice(0, timeline.indexOf('labels:event')).filter((entry) => entry === 'started').length;
  assert.ok(eventsBeforeRefresh >= 4, `${eventsBeforeRefresh} events kept resetting the debounce`);
  assert.ok(elapsed <= timings.eventDebounceMaxMs + 200, `refresh after ${elapsed} ms`);
});

test('handleEvent logs and publishes handled actions and ignores exec noise', (t) => {
  const { entries } = captureLogs(t, 'TRACE');
  const { monitor, started, stopped } = createHarness();
  const NEW_ID = 'd4'.repeat(32);

  monitor.handleEvent(containerEvent('start', 'newapp', NEW_ID));

  const startLines = linesContaining(entries, 'Docker event start newapp');
  assert.equal(startLines.length, 1);
  assert.equal(startLines[0].level, 'INFO');
  assert.deepEqual(started, [{ containerId: NEW_ID, containerName: 'newapp', status: 'start' }]);

  const before = entries.length;
  monitor.handleEvent(containerEvent('exec_create: sh -c true', 'newapp', NEW_ID));
  monitor.handleEvent(containerEvent('exec_start: sh -c true', 'newapp', NEW_ID));
  monitor.handleEvent(containerEvent('exec_die', 'newapp', NEW_ID));
  monitor.handleEvent(containerEvent('health_status: unhealthy', 'newapp', NEW_ID));
  monitor.handleEvent({ Type: 'network', Action: 'connect', Actor: { ID: 'n1', Attributes: { name: 'bridge' } } });
  assert.equal(entries.slice(before).filter((entry) => entry.level !== 'TRACE').length, 0);
  assert.equal(entries.filter((entry) => entry.text.includes('exec_')).length, 0);
  assert.equal(started.length, 1);
  assert.equal(stopped.length, 0);

  for (const action of ['stop', 'die', 'destroy']) monitor.handleEvent(containerEvent(action, 'newapp', NEW_ID));
  monitor.handleEvent(containerEvent('health_status: healthy', 'newapp', NEW_ID));

  assert.deepEqual(stopped.map((payload) => payload.status), ['stop', 'die', 'destroy']);
  assert.ok(stopped.every((payload) => payload.containerId === NEW_ID && payload.containerName === 'newapp'));
  assert.equal(started.length, 1);
  assert.equal(linesContaining(entries, 'Docker event health_status: healthy newapp').length, 1);
});

test('when getEvents is refused, startWatching resolves, WARNs once and keeps retrying', async (t) => {
  const { entries, lines } = captureLogs(t);
  const { monitor, state } = createHarness({ timings: FAST_TIMINGS });
  state.events = async () => {
    throw refusedError();
  };
  t.after(() => monitor.stopWatching());

  await assert.doesNotReject(monitor.startWatching());
  await waitFor(() => state.eventsCalls.length >= 3, 2000, 'two more getEvents attempts');

  const warns = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(
    warns[0].text,
    /Docker is unreachable \(connect ECONNREFUSED \/var\/run\/docker\.sock code=ECONNREFUSED\); continuing and retrying in the background$/
  );
  const attempts = linesContaining(entries, 'Docker event stream reconnect attempt');
  assert.ok(attempts.length >= 2);
  assert.ok(attempts.every((entry) => entry.level === 'DEBUG'));
  assert.match(attempts[0].text, /reconnect attempt 1 in 15 ms \(connect ECONNREFUSED/);
  assert.equal(entries.filter((entry) => entry.level === 'ERROR').length, 0);
  assert.equal(state.listCalls.length, 0);
  assert.equal(monitor.hasLoadedLabels(), false);
  assert.equal(lines.filter((line) => line.includes('started successfully')).length, 0);
});

test('stopWatching cancels pending reconnects and debounces, and a restart still refreshes on events', async (t) => {
  const { entries } = captureLogs(t);
  const timings = { ...FAST_TIMINGS, eventDebounceMs: 200, eventDebounceMaxMs: 400 };
  const { monitor, published, state } = createHarness({ timings });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  t.after(() => monitor.stopWatching());
  await monitor.startWatching();

  writeEvent(state.streams[0], containerEvent('start', 'app', APP_ID));
  await waitFor(() => linesContaining(entries, 'Docker event start app').length === 1, 2000, 'the start event');
  const openStreamOk = state.events;
  state.events = async () => {
    throw refusedError();
  };
  state.streams[0].end();
  await waitFor(() => linesContaining(entries, 'reconnect attempt').length >= 1, 2000, 'a scheduled reconnect');
  assert.equal(state.listCalls.length, 1, 'the debounce is still pending');

  monitor.stopWatching();
  const eventsCallsAtStop = state.eventsCalls.length;
  await sleep(Math.max(3 * timings.reconnectMaxMs, timings.eventDebounceMaxMs) + 100);

  assert.equal(state.eventsCalls.length, eventsCallsAtStop);
  assert.equal(state.listCalls.length, 1);
  assert.deepEqual(published.map((payload) => payload.trigger), ['boot']);

  state.events = openStreamOk;
  await monitor.startWatching();
  assert.equal(state.listCalls.length, 2);
  writeEvent(state.streams.at(-1), containerEvent('start', 'app', APP_ID));

  await waitFor(() => published.some((payload) => payload.trigger === 'event'), 2000, 'an event refresh after the restart');
  assert.deepEqual(published.map((payload) => payload.trigger), ['boot', 'boot', 'event']);
});

test('a live connection keeps its signal past connectTimeoutMs, and stopWatching aborts it and destroys the stream', async (t) => {
  captureLogs(t);
  const timings = { ...FAST_TIMINGS, connectTimeoutMs: 50 };
  const { monitor, state } = createHarness({ timings });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  t.after(() => monitor.stopWatching());
  await monitor.startWatching();
  const [stream] = state.streams;
  const { abortSignal } = state.eventsCalls[0];

  await sleep(3 * timings.connectTimeoutMs);
  assert.equal(abortSignal.aborted, false);
  assert.equal(stream.destroyed, false);

  monitor.stopWatching();
  assert.equal(abortSignal.aborted, true);
  assert.equal(stream.destroyed, true);
  await sleep(3 * timings.reconnectMaxMs);
  assert.equal(state.eventsCalls.length, 1);
});

test('a getEvents that resolves after stopWatching is destroyed and never re-listed', async (t) => {
  const { entries } = captureLogs(t);
  const { monitor, state } = createHarness({ timings: FAST_TIMINGS });
  const pending = deferred();
  state.events = () => pending.promise;
  t.after(() => monitor.stopWatching());

  const booted = monitor.startWatching();
  await waitFor(() => state.eventsCalls.length === 1, 2000, 'the getEvents call');
  monitor.stopWatching();
  const late = new PassThrough();
  pending.resolve(late);
  await booted;

  assert.equal(late.destroyed, true);
  assert.equal(state.listCalls.length, 0);
  assert.equal(monitor.hasLoadedLabels(), false);
  await sleep(3 * FAST_TIMINGS.reconnectMaxMs);
  assert.equal(state.eventsCalls.length, 1);
  assert.equal(entries.filter((entry) => entry.level === 'WARN').length, 0);
});

test('only a connection that stayed up for stableConnectionMs resets the reconnect backoff', async (t) => {
  const { entries } = captureLogs(t);
  const timings = { ...FAST_TIMINGS, reconnectMaxMs: 1000, stableConnectionMs: 100 };
  const { monitor, state } = createHarness({ timings });
  state.respond = async () => [dockerContainer(APP_ID, 'app', APP_LABELS)];
  state.events = async () => {
    if (state.eventsCalls.length <= 2) throw refusedError();
    return openStream(state);
  };
  t.after(() => monitor.stopWatching());
  const reconnectedLines = () => linesContaining(entries, 'Docker event stream reconnected');
  const attemptDelays = () => linesContaining(entries, 'Docker event stream reconnect attempt')
    .map((entry) => Number(/ in (\d+) ms /.exec(entry.text)[1]));

  await monitor.startWatching();
  await waitFor(() => reconnectedLines().length === 1, 2000, 'the first connection');
  state.streams[0].end();
  await waitFor(() => reconnectedLines().length === 2, 2000, 'the connection after a short-lived one');

  // Holding the connection for longer than stableConnectionMs is the precondition itself.
  await sleep(timings.stableConnectionMs + 50);
  state.streams[1].end();
  await waitFor(() => attemptDelays().length === 4, 2000, 'the reconnect after a stable connection');

  assert.deepEqual(attemptDelays(), [15, 30, 60, 15]);
});

test('a stream that dies during its re-list is not a recovery', async (t) => {
  const { entries } = captureLogs(t);
  const { monitor, state } = createHarness({ timings: FAST_TIMINGS });
  const lists = [];
  state.respond = () => {
    const pending = deferred();
    lists.push(pending);
    return pending.promise;
  };
  t.after(() => monitor.stopWatching());
  const containers = [dockerContainer(APP_ID, 'app', APP_LABELS)];

  const booted = monitor.startWatching();
  for (let cycle = 0; cycle < 3; cycle++) {
    await waitFor(
      () => state.streams.length === cycle + 1 && lists.length === cycle + 1,
      2000,
      `connection ${cycle + 1} and its re-list`
    );
    state.streams[cycle].end();
    await waitFor(
      () => linesContaining(entries, 'reconnect attempt').length === cycle + 1,
      2000,
      `reconnect ${cycle + 1} to be scheduled`
    );
    lists[cycle].resolve(containers);
  }
  await booted;
  await waitFor(() => state.streams.length === 4 && lists.length === 4, 2000, 'the fourth connection and its re-list');

  assert.equal(linesContaining(entries, 'reconnected').length, 0);
  const warns = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warns.length, 1);
  assert.match(warns[0].text, /Docker event stream ended; reconnecting$/);

  lists[3].resolve(containers);
  await waitFor(() => linesContaining(entries, 'reconnected').length === 1, 2000, 'the reconnect INFO line');

  const reconnected = linesContaining(entries, 'Docker event stream reconnected');
  assert.equal(reconnected.length, 1);
  assert.equal(reconnected[0].level, 'INFO');
  assert.match(
    reconnected[0].text,
    /Docker event stream reconnected after 3 attempt\(s\); re-listed 1 running containers \(trigger=reconnect\)$/
  );
  assert.equal(entries.filter((entry) => entry.level === 'WARN').length, 1);
  assert.equal(linesContaining(entries, 'started successfully').length, 0);
});

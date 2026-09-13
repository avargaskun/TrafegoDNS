const { test } = require('node:test');
const assert = require('node:assert/strict');
const Docker = require('dockerode');
const DockerMonitor = require('../../src/services/DockerMonitor');
const TraefikMonitor = require('../../src/services/TraefikMonitor');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');
const { startFakeDockerDaemon } = require('../helpers/fakeDockerDaemon');
const { startFakeTraefik } = require('../helpers/fakeTraefik');

const TIMINGS = {
  reconnectInitialMs: 20,
  reconnectMaxMs: 100,
  stableConnectionMs: 1000,
  connectTimeoutMs: 500,
  refreshTimeoutMs: 500,
  eventDebounceMs: 30,
  eventDebounceMaxMs: 100
};

const PROXY = {
  Id: 'c'.repeat(64),
  Names: ['/proxy'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.proxy.rule': 'Host(`proxy.example.com`)' }
};
const DB = { Id: 'd'.repeat(64), Names: ['/db'], Labels: {} };
const NEWAPP = {
  Id: 'a'.repeat(64),
  Names: ['/newapp'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.newapp.rule': 'Host(`newapp.example.com`)' }
};

const RECONNECTED = /Docker event stream reconnected after (\d+) attempt\(s\); re-listed (\d+) running containers \(trigger=reconnect\)$/;

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

async function setup(t, { containers = [PROXY] } = {}) {
  const daemon = await startFakeDockerDaemon();
  daemon.setContainers(containers);
  daemon.noise(true);
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const monitor = new DockerMonitor(makeConfig(), new EventBus(), {
    docker: daemon.docker,
    timings: TIMINGS,
    random: () => 0.5
  });
  t.after(async () => {
    monitor.stopWatching();
    await daemon.stop();
  });
  return { daemon, logs, faults, monitor };
}

async function startConnected(daemon, monitor) {
  await monitor.startWatching();
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
  assert.equal(monitor.hasLoadedLabels(), true);
}

function warnings(entries) {
  return entries.filter((entry) => entry.level === 'WARN');
}

function reconnectAttempts(entries) {
  return entries.filter((entry) => entry.level === 'DEBUG' && entry.text.includes('Docker event stream reconnect attempt'));
}

function reconnectedLine(entries) {
  return entries.find((entry) => entry.level === 'INFO' && RECONNECTED.test(entry.text));
}

test('(c) a terminated event stream reconnects once, re-lists once and keeps handling events', async (t) => {
  const modes = [
    { mode: 'sever', warn: /Docker event stream error: .+; reconnecting$/ },
    { mode: 'endCleanly', warn: /Docker event stream ended; reconnecting$/ },
    { mode: 'endMidObject', warn: /Docker event stream error: .+; reconnecting$/ }
  ];
  for (const { mode, warn } of modes) {
    await t.test(mode, async (st) => {
      const { daemon, logs, faults, monitor } = await setup(st);
      await startConnected(daemon, monitor);
      const sentBefore = daemon.stats.eventsSent;
      await waitFor(() => daemon.stats.eventsSent >= sentBefore + 18, 2000, 'exec noise on the stream');
      const listBefore = daemon.stats.listRequests;
      const eventsBefore = daemon.stats.eventsConnections;

      daemon[mode]();
      await waitFor(() => reconnectedLine(logs.entries), 3000, 'the reconnect INFO line');

      const warns = warnings(logs.entries);
      assert.equal(warns.length, 1, warns.map((entry) => entry.text).join('\n'));
      assert.match(warns[0].text, warn);
      assert.match(reconnectedLine(logs.entries).text, /after 1 attempt\(s\); re-listed 1 running containers/);
      assert.equal(daemon.stats.listRequests, listBefore + 1);
      assert.equal(daemon.stats.eventsConnections, eventsBefore + 1);
      assert.equal(daemon.openEventStreams(), 1);

      daemon.setContainers([PROXY, NEWAPP]);
      assert.equal(daemon.emit('start', 'newapp', NEWAPP.Id), 1);
      await waitFor(
        () => monitor.getContainers().some((container) => container.name === 'newapp'),
        3000,
        'newapp in the refreshed containers'
      );

      assert.ok(logs.lines.some((line) => line.includes('Docker event start newapp')));
      assert.ok(logs.lines.some((line) => line.includes('Docker labels refreshed (trigger=event)')));
      assert.equal(logs.lines.filter((line) => line.includes('exec_')).length, 0);
      assert.equal(warnings(logs.entries).length, 1);
      assert.equal(daemon.openEventStreams(), 1);
      assert.deepEqual(faults, [], faultSummary(faults));
    });
  }
});

test('(d) an unreachable daemon is retried with backoff, WARNed once, and recovered with a re-list', async (t) => {
  const { daemon, logs, faults, monitor } = await setup(t, { containers: [PROXY, DB] });
  await startConnected(daemon, monitor);

  await daemon.stop();
  await waitFor(() => reconnectAttempts(logs.entries).length >= 3, 3000, 'three reconnect attempts');

  const warns = warnings(logs.entries);
  assert.equal(warns.length, 1, warns.map((entry) => entry.text).join('\n'));
  assert.match(warns[0].text, /Docker event stream error: .+; reconnecting$/);
  const attempts = reconnectAttempts(logs.entries);
  assert.match(attempts[1].text, /ECONNREFUSED/);
  const delays = attempts.map((entry) => Number(/ in (\d+) ms /.exec(entry.text)[1]));
  assert.deepEqual(delays.slice(0, 3), [15, 30, 60]);

  await daemon.restart();
  const recovered = await waitFor(() => reconnectedLine(logs.entries), 3000, 'the reconnect INFO line');

  const [, attemptCount, relisted] = RECONNECTED.exec(recovered.text);
  assert.equal(Number(relisted), 2);
  assert.equal(Number(attemptCount), reconnectAttempts(logs.entries).length);
  assert.ok(Number(attemptCount) >= 3);
  assert.equal(warnings(logs.entries).length, 1);
  assert.equal(daemon.openEventStreams(), 1);
  assert.deepEqual(monitor.getContainers().map((container) => container.name), ['proxy', 'db']);
  assert.deepEqual(faults, [], faultSummary(faults));
});

test('(e) stopWatching never reconnects, even when the stream is severed afterwards', async (t) => {
  const { daemon, logs, faults, monitor } = await setup(t);
  await startConnected(daemon, monitor);

  monitor.stopWatching();
  assert.equal(daemon.openEventStreams(), 1, 'the daemon has not seen the client close yet, so sever() cuts a live stream');
  const eventsBefore = daemon.stats.eventsConnections;
  const listBefore = daemon.stats.listRequests;
  daemon.sever();
  await sleep(3 * TIMINGS.reconnectMaxMs);

  assert.equal(daemon.stats.eventsConnections, eventsBefore);
  assert.equal(daemon.stats.listRequests, listBefore);
  assert.equal(daemon.openEventStreams(), 0);
  assert.equal(reconnectAttempts(logs.entries).length, 0);
  assert.equal(warnings(logs.entries).length, 0);
  assert.deepEqual(faults, [], faultSummary(faults));
});

test('(f) booting while Docker is down gates DNS passes until labels load, then polls publish again', async (t) => {
  const daemon = await startFakeDockerDaemon();
  daemon.setContainers([PROXY]);
  const { port } = daemon;
  await daemon.stop();

  const traefik = await startFakeTraefik({
    routers: [{ name: 'proxy@docker', provider: 'docker', entryPoints: ['https'], service: 'proxy', rule: 'Host(`proxy.example.com`)', status: 'enabled' }]
  });
  const logs = captureLogs(t, 'DEBUG');
  const faults = recordProcessFaults(t);
  const config = makeConfig({ traefikApiUrl: traefik.url });
  const bus = new EventBus();
  const docker = new Docker({ host: '127.0.0.1', port, protocol: 'http' });
  const dockerMonitor = new DockerMonitor(config, bus, { docker, timings: TIMINGS, random: () => 0.5 });
  const traefikMonitor = new TraefikMonitor(config, bus);
  traefikMonitor.dockerMonitor = dockerMonitor;
  const routerUpdates = [];
  bus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, (data) => routerUpdates.push(data));
  t.after(async () => {
    traefikMonitor.stopPolling();
    dockerMonitor.stopWatching();
    await daemon.stop();
    await traefik.stop();
  });

  await dockerMonitor.startWatching();

  const unreachable = () => logs.entries.filter((entry) => entry.level === 'WARN' && entry.text.includes('Docker is unreachable'));
  assert.equal(unreachable().length, 1);
  assert.match(unreachable()[0].text, /ECONNREFUSED/);
  assert.equal(dockerMonitor.hasLoadedLabels(), false);

  await traefikMonitor.pollTraefikAPI();
  await traefikMonitor.pollTraefikAPI();

  const skips = logs.entries.filter((entry) => entry.text.includes('Skipping DNS pass'));
  assert.deepEqual(skips.map((entry) => entry.level), ['WARN', 'DEBUG']);
  assert.equal(routerUpdates.length, 0);
  assert.equal(dockerMonitor.hasLoadedLabels(), false);

  await daemon.restart();
  await waitFor(() => dockerMonitor.hasLoadedLabels(), 3000, 'labels to load after the daemon restarts');
  const recovered = await waitFor(() => reconnectedLine(logs.entries), 3000, 'the reconnect INFO line');
  assert.match(recovered.text, /re-listed 1 running containers/);
  assert.equal(routerUpdates.length, 0, 'without startPolling() the reconnect refresh starts no poll');

  await traefikMonitor.pollTraefikAPI();

  assert.equal(routerUpdates.length, 1);
  assert.deepEqual(routerUpdates[0].hostnames, ['proxy.example.com']);
  assert.equal(routerUpdates[0].containerLabels['proxy.example.com']['dns.manage'], 'true');
  assert.equal(unreachable().length, 1);
  assert.equal(logs.entries.filter((entry) => entry.text.includes('Skipping DNS pass')).length, 2);
  assert.deepEqual(dockerMonitor.getContainers().map((container) => container.name), ['proxy']);
  assert.deepEqual(faults, [], faultSummary(faults));
});

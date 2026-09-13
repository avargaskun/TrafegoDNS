const { test } = require('node:test');
const assert = require('node:assert/strict');
const TraefikMonitor = require('../../src/services/TraefikMonitor');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { waitFor } = require('../helpers/waitFor');

const SKIP_LINE = 'Skipping DNS pass: Docker container labels have not been loaded yet';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function router(name, host, { provider = 'docker', entryPoints = ['https'], service } = {}) {
  return {
    name,
    provider,
    entryPoints,
    service: service ?? name.split('@')[0],
    rule: `Host(\`${host}\`)`,
    status: 'enabled'
  };
}

function container(name, labels) {
  return { id: `${name}-id`, name, labels };
}

function createMonitor(t, configOverrides = {}) {
  const bus = new EventBus();
  const monitor = new TraefikMonitor(makeConfig(configOverrides), bus);
  t.after(() => monitor.stopPolling());
  const routersUpdated = [];
  const pollsCompleted = [];
  const errors = [];
  bus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, (data) => routersUpdated.push(data));
  bus.subscribe(EventTypes.TRAEFIK_POLL_COMPLETED, (data) => pollsCompleted.push(data));
  bus.subscribe(EventTypes.ERROR_OCCURRED, (data) => errors.push(data));
  return { bus, monitor, routersUpdated, pollsCompleted, errors };
}

function setContainers(bus, containers) {
  bus.publish(EventTypes.DOCKER_LABELS_UPDATED, { containers, trigger: 'boot', hasChanges: true });
}

function linesAt(entries, level, text) {
  return entries.filter((entry) => entry.level === level && entry.text.includes(text));
}

function triggersOf(runPoll) {
  return runPoll.mock.calls.map((call) => call.arguments[0]);
}

test('processRouters returns unique hostnames in first-seen order with the routers serving each', (t) => {
  captureLogs(t);
  const { monitor } = createMonitor(t);
  const routers = [
    router('app@docker', 'app.example.com', { entryPoints: ['https'] }),
    { ...router('app-alt@docker', 'app.example.com'), rule: 'Host(`alt.example.com`) || Host(`app.example.com`)', entryPoints: ['web', 'https'] },
    { ...router('twice@docker', 'twice.example.com'), rule: 'Host(`twice.example.com`) || Host(`twice.example.com`)' },
    { ...router('paths@file', 'unused'), provider: 'file', rule: 'PathPrefix(`/api`)' },
    { name: 'norule@internal', provider: 'internal', service: 'api@internal' }
  ];

  const { hostnames, hostnameRouters } = monitor.processRouters(routers);

  assert.deepEqual(hostnames, ['app.example.com', 'alt.example.com', 'twice.example.com']);
  assert.ok(hostnameRouters instanceof Map);
  assert.deepEqual([...hostnameRouters.keys()], hostnames);
  assert.deepEqual(hostnameRouters.get('app.example.com'), [
    { name: 'app@docker', provider: 'docker', entryPoints: ['https'], service: 'app' },
    { name: 'app-alt@docker', provider: 'docker', entryPoints: ['web', 'https'], service: 'app-alt' }
  ]);
  assert.deepEqual(hostnameRouters.get('alt.example.com').map((ref) => ref.name), ['app-alt@docker']);
  assert.deepEqual(hostnameRouters.get('twice.example.com').map((ref) => ref.name), ['twice@docker']);

  const keyed = Object.fromEntries(routers.map((r) => [r.name, r]));
  assert.deepEqual(monitor.processRouters(keyed).hostnames, hostnames);
});

test('requests made during a running poll are served by exactly one trailing poll with the latest trigger', async (t) => {
  captureLogs(t);
  const { monitor, routersUpdated } = createMonitor(t);
  const first = deferred();
  let getRoutersCalls = 0;
  t.mock.method(monitor, 'getRouters', () => {
    getRoutersCalls++;
    return getRoutersCalls === 1 ? first.promise : Promise.resolve([]);
  });
  const runPoll = t.mock.method(monitor, 'runPoll');

  const initial = monitor.requestPoll('first');
  await waitFor(() => getRoutersCalls === 1, 2000, 'the first poll to call getRouters');
  const followers = [monitor.requestPoll('second'), monitor.requestPoll('third'), monitor.pollTraefikAPI('fourth')];
  first.resolve([router('app@docker', 'app.example.com')]);
  await Promise.all([initial, ...followers]);

  assert.equal(getRoutersCalls, 2);
  assert.deepEqual(triggersOf(runPoll), ['first', 'fourth']);
  assert.equal(routersUpdated.length, 2);
});

test('DOCKER_LABELS_UPDATED requests a poll only for event and reconnect triggers once polling has started', async (t) => {
  captureLogs(t);
  const { bus, monitor } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => []);
  const runPoll = t.mock.method(monitor, 'runPoll');
  const labels = async (trigger) => {
    // Lets the runner clear its settled run, so a triggered poll starts at once instead of merging with the probe.
    await new Promise(setImmediate);
    bus.publish(EventTypes.DOCKER_LABELS_UPDATED, { containers: [], trigger, hasChanges: true });
  };

  await labels('event');
  await monitor.pollTraefikAPI('probe-before-start');
  assert.deepEqual(triggersOf(runPoll), ['probe-before-start']);

  await monitor.startPolling();
  assert.deepEqual(triggersOf(runPoll).slice(1), ['startup']);

  await labels('poll');
  await labels('boot');
  await monitor.pollTraefikAPI('probe-after-poll');
  assert.deepEqual(triggersOf(runPoll).slice(2), ['probe-after-poll']);

  await labels('event');
  await monitor.pollTraefikAPI('probe-after-event');
  assert.deepEqual(triggersOf(runPoll).slice(3), ['event', 'probe-after-event']);

  await labels('reconnect');
  await monitor.pollTraefikAPI('probe-after-reconnect');
  assert.deepEqual(triggersOf(runPoll).slice(5), ['reconnect', 'probe-after-reconnect']);

  monitor.stopPolling();
  await labels('event');
  await monitor.pollTraefikAPI('probe-after-stop');
  assert.deepEqual(triggersOf(runPoll).slice(7), ['probe-after-stop']);
});

test('polls refresh Docker labels after listing routers and publish nothing until labels have loaded', async (t) => {
  const logs = captureLogs(t);
  const { bus, monitor, routersUpdated, pollsCompleted } = createMonitor(t);
  const timeline = [];
  t.mock.method(monitor, 'getRouters', async () => {
    timeline.push('getRouters');
    return [router('app@docker', 'app.example.com')];
  });
  let loaded = false;
  monitor.dockerMonitor = {
    refreshLabels: async (trigger) => {
      timeline.push(`refresh:${trigger}`);
      if (loaded) setContainers(bus, [container('app', { 'traefik.enable': 'true', 'traefik.http.routers.app.rule': 'Host(`app.example.com`)', 'dns.manage': 'true' })]);
      return loaded ? { ok: true, containerCount: 1, changed: [] } : { ok: false, error: new Error('unreachable') };
    },
    hasLoadedLabels: () => loaded
  };

  await monitor.pollTraefikAPI();
  await monitor.pollTraefikAPI();

  assert.deepEqual(timeline, ['getRouters', 'refresh:poll', 'getRouters', 'refresh:poll']);
  assert.equal(routersUpdated.length, 0);
  assert.equal(pollsCompleted.length, 0);
  assert.equal(linesAt(logs.entries, 'WARN', SKIP_LINE).length, 1);
  assert.equal(linesAt(logs.entries, 'DEBUG', SKIP_LINE).length, 1);

  loaded = true;
  await monitor.pollTraefikAPI();

  assert.equal(routersUpdated.length, 1);
  assert.deepEqual(routersUpdated[0].hostnames, ['app.example.com']);
  assert.equal(routersUpdated[0].containerLabels['app.example.com']['dns.manage'], 'true');
  assert.equal(linesAt(logs.entries, 'WARN', SKIP_LINE).length, 1);
});

test('without watchDockerEvents a poll neither refreshes labels nor waits for them', async (t) => {
  captureLogs(t);
  const { monitor, routersUpdated } = createMonitor(t, { watchDockerEvents: false });
  t.mock.method(monitor, 'getRouters', async () => [router('app@docker', 'app.example.com')]);
  let refreshes = 0;
  monitor.dockerMonitor = {
    refreshLabels: async () => {
      refreshes++;
      return { ok: false };
    },
    hasLoadedLabels: () => false
  };

  await monitor.pollTraefikAPI();

  assert.equal(refreshes, 0);
  assert.equal(routersUpdated.length, 1);
  assert.deepEqual(routersUpdated[0].hostnames, ['app.example.com']);
  assert.deepEqual(routersUpdated[0].containerLabels['app.example.com'], {
    'traefik.http.routers.app@docker.service': 'app',
    routerName: 'app@docker'
  });
});

test('a poll publishes exactly attributed labels and the router and hostname counts', async (t) => {
  captureLogs(t);
  const { bus, monitor, routersUpdated, pollsCompleted } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => [
    router('app@docker', 'app.example.com'),
    router('app-exporter@docker', 'app-exporter.example.com'),
    router('files@file', 'files.example.com', { provider: 'file' })
  ]);
  setContainers(bus, [
    container('app-exporter', { 'traefik.enable': 'true', 'dns.manage': 'false' }),
    container('app', { 'traefik.enable': 'true', 'traefik.http.routers.app.rule': 'Host(`app.example.com`)', 'dns.manage': 'true', 'dns.cloudflare.proxied': 'false' })
  ]);

  await monitor.pollTraefikAPI();

  assert.equal(routersUpdated.length, 1);
  const { hostnames, containerLabels } = routersUpdated[0];
  assert.deepEqual(hostnames, ['app.example.com', 'app-exporter.example.com', 'files.example.com']);
  assert.deepEqual(containerLabels['app.example.com'], {
    'traefik.http.routers.app@docker.service': 'app',
    routerName: 'app@docker',
    'dns.cloudflare.proxied': 'false',
    'dns.manage': 'true'
  });
  assert.deepEqual(containerLabels['app-exporter.example.com'], {
    'traefik.http.routers.app-exporter@docker.service': 'app-exporter',
    routerName: 'app-exporter@docker',
    'dns.manage': 'false'
  });
  assert.deepEqual(containerLabels['files.example.com'], {
    'traefik.http.routers.files@file.service': 'files',
    routerName: 'files@file'
  });
  assert.deepEqual(pollsCompleted, [{ routerCount: 3, hostnameCount: 3 }]);
});

test('a failed router listing logs the error, publishes its message only and resolves', async (t) => {
  const logs = captureLogs(t);
  const { monitor, routersUpdated, errors } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => {
    throw Object.assign(new Error('Request failed with status code 502'), {
      config: { headers: { Authorization: 'Basic SYNTHETIC-TOKEN' } }
    });
  });

  await monitor.pollTraefikAPI();

  assert.equal(routersUpdated.length, 0);
  assert.deepEqual(errors, [{ source: 'TraefikMonitor.pollTraefikAPI', error: 'Request failed with status code 502' }]);
  assert.equal(linesAt(logs.entries, 'ERROR', 'Error polling Traefik API: Request failed with status code 502').length, 1);
  assert.ok(logs.lines.every((line) => !line.includes('SYNTHETIC-TOKEN')));
});

test('an ambiguous router is excluded and warned about once until it is resolved and reintroduced', async (t) => {
  const logs = captureLogs(t);
  const { bus, monitor, routersUpdated } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => [
    router('shared@docker', 'shared.example.com'),
    router('app@docker', 'app.example.com')
  ]);
  const sharedRule = { 'traefik.enable': 'true', 'traefik.http.routers.shared.rule': 'Host(`shared.example.com`)' };
  const app = container('app', { 'traefik.enable': 'true', 'traefik.http.routers.app.rule': 'Host(`app.example.com`)', 'dns.manage': 'true' });
  const conflicting = [app, container('right', { ...sharedRule, 'dns.skip': 'true' }), container('left', { ...sharedRule, 'dns.manage': 'true' })];
  const agreeing = [app, container('right', { ...sharedRule, 'dns.manage': 'true' }), container('left', { ...sharedRule, 'dns.manage': 'true' })];
  const warning = 'Router shared@docker is claimed by containers left, right with different DNS labels; leaving its hostnames unmanaged';

  setContainers(bus, conflicting);
  await monitor.pollTraefikAPI();
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 1);
  assert.deepEqual(routersUpdated.map((data) => data.hostnames), [['app.example.com'], ['app.example.com']]);
  assert.equal(routersUpdated[1].containerLabels['shared.example.com'], undefined);

  setContainers(bus, agreeing);
  await monitor.pollTraefikAPI();
  assert.deepEqual(routersUpdated[2].hostnames, ['shared.example.com', 'app.example.com']);
  assert.equal(routersUpdated[2].containerLabels['shared.example.com']['dns.manage'], 'true');
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 1);

  setContainers(bus, conflicting);
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 2);
  assert.deepEqual(routersUpdated[3].hostnames, ['app.example.com']);
});

test('an owner conflict is warned about once until it is resolved and reintroduced', async (t) => {
  const logs = captureLogs(t);
  const { bus, monitor, routersUpdated } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => [
    router('web@docker', 'web.example.com'),
    router('web-alt@docker', 'web.example.com')
  ]);
  const web = container('web', { 'traefik.enable': 'true', 'traefik.http.routers.web.rule': 'Host(`web.example.com`)', 'dns.manage': 'true', 'dns.proxied': 'false' });
  const altLabels = { 'traefik.enable': 'true', 'traefik.http.routers.web-alt.rule': 'Host(`web.example.com`)', 'dns.manage': 'true' };
  const warning = 'Hostname web.example.com is managed by containers web, webalt with different DNS labels; using web';

  setContainers(bus, [container('webalt', altLabels), web]);
  await monitor.pollTraefikAPI();
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 1);
  assert.equal(routersUpdated[1].containerLabels['web.example.com']['dns.proxied'], 'false');
  assert.deepEqual(routersUpdated[1].hostnames, ['web.example.com']);

  setContainers(bus, [container('webalt', { ...altLabels, 'dns.proxied': 'false' }), web]);
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 1);

  setContainers(bus, [container('webalt', altLabels), web]);
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'WARN', warning).length, 2);
});

test('proxied label changes are logged at INFO with the owning container name only when they change', async (t) => {
  const logs = captureLogs(t);
  const { bus, monitor } = createMonitor(t);
  t.mock.method(monitor, 'getRouters', async () => [router('app@docker', 'app.example.com')]);
  const appLabels = { 'traefik.enable': 'true', 'traefik.http.routers.app.rule': 'Host(`app.example.com`)', 'dns.manage': 'true' };
  const unproxied = 'Found proxied=false for app.example.com from container app';
  const proxied = 'Found proxied=true for app.example.com from container app';

  setContainers(bus, [container('app', { ...appLabels, 'dns.proxied': 'false' })]);
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'INFO', unproxied).length, 1);
  assert.equal(linesAt(logs.entries, 'INFO', 'DNS label changes detected for 1 hostnames: app.example.com (unproxied)').length, 1);

  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'INFO', unproxied).length, 1);
  assert.equal(linesAt(logs.entries, 'DEBUG', unproxied).length, 1);

  setContainers(bus, [container('app', { ...appLabels, 'dns.proxied': 'true' })]);
  await monitor.pollTraefikAPI();
  assert.equal(linesAt(logs.entries, 'INFO', proxied).length, 1);
  assert.equal(linesAt(logs.entries, 'INFO', 'DNS label changes detected for 1 hostnames: app.example.com (proxied)').length, 1);
});

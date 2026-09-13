const { test } = require('node:test');
const assert = require('node:assert/strict');
const TraefikMonitor = require('../../src/services/TraefikMonitor');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { startFakeTraefik } = require('../helpers/fakeTraefik');

function routers(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `r${i}@docker`,
    provider: 'docker',
    entryPoints: ['https'],
    service: `r${i}`,
    rule: `Host(\`r${i}.example.com\`)`,
    status: 'enabled'
  }));
}

async function setup(t, count) {
  captureLogs(t);
  const traefik = await startFakeTraefik({ routers: routers(count) });
  const bus = new EventBus();
  const monitor = new TraefikMonitor(makeConfig({ traefikApiUrl: traefik.url }), bus);
  t.after(async () => {
    monitor.stopPolling();
    await traefik.stop();
  });
  return { traefik, bus, monitor };
}

test('Traefik routers are read across every page until X-Next-Page wraps to 1', async (t) => {
  const { traefik, monitor } = await setup(t, 250);

  const result = await monitor.getRouters();

  assert.equal(result.length, 250);
  assert.deepEqual(result.map((r) => r.name), routers(250).map((r) => r.name));
  assert.equal(traefik.stats.routerRequests, 3);
});

test('an exact multiple of the page size stops on the wrap without requesting an extra page', async (t) => {
  const { traefik, monitor } = await setup(t, 200);

  const result = await monitor.getRouters();

  assert.equal(result.length, 200);
  assert.equal(traefik.stats.routerRequests, 2);
});

test('an empty router list takes a single request', async (t) => {
  const { traefik, monitor } = await setup(t, 0);

  assert.deepEqual(await monitor.getRouters(), []);
  assert.equal(traefik.stats.routerRequests, 1);
});

test('a poll publishes the hostnames of routers beyond the first page', async (t) => {
  const { bus, monitor } = await setup(t, 250);
  const published = [];
  bus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, (data) => published.push(data));

  await monitor.pollTraefikAPI();

  assert.equal(published.length, 1);
  assert.equal(published[0].hostnames.length, 250);
  assert.equal(published[0].hostnames[249], 'r249.example.com');
  assert.equal(published[0].containerLabels['r249.example.com'].routerName, 'r249@docker');
});

test('a refused connection keeps the Traefik-specific error message', async (t) => {
  captureLogs(t);
  const monitor = new TraefikMonitor(makeConfig({ traefikApiUrl: 'http://127.0.0.1:1/api' }), new EventBus());

  await assert.rejects(monitor.getRouters(), {
    message: 'Connection refused to Traefik API at http://127.0.0.1:1/api. Is Traefik running?'
  });
});

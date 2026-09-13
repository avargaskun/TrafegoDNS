const { test } = require('node:test');
const assert = require('node:assert/strict');
const TraefikMonitor = require('../../src/services/TraefikMonitor');
const CloudflareProvider = require('../../src/providers/cloudflare/provider');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('../helpers/config');
const { captureLogs } = require('../helpers/logCapture');
const { startFakeTraefik } = require('../helpers/fakeTraefik');
const { startFakeCloudflare } = require('../helpers/fakeCloudflare');
const { installExitWatchdog } = require('../helpers/exitWatchdog');

installExitWatchdog();

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

  const error = await rejectionOf(monitor.getRouters());

  assert.ok(error, 'getRouters() should reject');
  assert.equal(error.message, 'Connection refused to Traefik API at http://127.0.0.1:1/api. Is Traefik running?');
});

function dnsRecords(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `rec-${i}`,
    type: 'CNAME',
    name: `r${i}.example.com`,
    content: 'example.com',
    proxied: true,
    ttl: 1
  }));
}

async function setupCloudflare(t, count) {
  captureLogs(t);
  const cloudflare = await startFakeCloudflare({ records: dnsRecords(count) });
  const provider = new CloudflareProvider(makeConfig());
  provider.client.defaults.baseURL = cloudflare.baseURL;
  t.after(() => cloudflare.stop());
  return { cloudflare, provider };
}

function recordPageRequests(cloudflare) {
  return cloudflare.requests
    .filter((request) => request.method === 'GET' && request.path.endsWith('/zones/zone-1/dns_records'))
    .map((request) => request.query);
}

function rejectionOf(promise) {
  return promise.then(() => null, (error) => error);
}

async function cachedRecordIds(provider) {
  return (await provider.getRecordsFromCache()).map((record) => record.id);
}

test('Cloudflare records are cached across every page', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 250);

  await provider.init();

  assert.deepEqual(recordPageRequests(cloudflare), [
    { per_page: '100', page: '1' },
    { per_page: '100', page: '2' },
    { per_page: '100', page: '3' }
  ]);
  assert.deepEqual(await cachedRecordIds(provider), dnsRecords(250).map((r) => r.id));
  assert.equal(recordPageRequests(cloudflare).length, 3, 'the cached records were served without another listing');
});

test('an exact multiple of the Cloudflare page size takes no extra request', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 200);

  await provider.init();

  assert.equal(recordPageRequests(cloudflare).length, 2);
  assert.equal((await cachedRecordIds(provider)).length, 200);
});

test('an empty Cloudflare zone takes a single record request', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 0);

  await provider.init();

  assert.equal(recordPageRequests(cloudflare).length, 1);
  assert.deepEqual(await cachedRecordIds(provider), []);
});

test('a failed Cloudflare page rejects the refresh and keeps the previous cache', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 250);
  await provider.init();
  cloudflare.setRecords(dnsRecords(251));
  cloudflare.failPage(2);

  const error = await rejectionOf(provider.refreshRecordCache());

  assert.ok(error, 'refreshRecordCache() should reject');
  assert.equal(error.response?.status, 500);
  assert.equal(recordPageRequests(cloudflare).length, 5);
  assert.deepEqual(await cachedRecordIds(provider), dnsRecords(250).map((r) => r.id));
  assert.equal(recordPageRequests(cloudflare).length, 5, 'the previous cache was served without another listing');

  cloudflare.failPage(null);
  await provider.refreshRecordCache();

  assert.equal((await cachedRecordIds(provider)).length, 251);
});

test('an empty Cloudflare page ends the listing even when total_pages promises more', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 100);
  cloudflare.setListingQuirks({ totalPages: 5 });

  await provider.init();

  assert.deepEqual(recordPageRequests(cloudflare).map((query) => query.page), ['1', '2']);
  assert.equal((await cachedRecordIds(provider)).length, 100);
});

test('a Cloudflare response without result_info is treated as the only page', async (t) => {
  const { cloudflare, provider } = await setupCloudflare(t, 250);
  cloudflare.setListingQuirks({ omitResultInfo: true });

  await provider.init();

  assert.deepEqual(recordPageRequests(cloudflare).map((query) => query.page), ['1']);
  assert.deepEqual(await cachedRecordIds(provider), dnsRecords(100).map((r) => r.id));
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DockerMonitor = require('../../src/services/DockerMonitor');
const TraefikMonitor = require('../../src/services/TraefikMonitor');
const DNSManager = require('../../src/services/DNSManager');
const { EventBus } = require('../../src/events/EventBus');
const EventTypes = require('../../src/events/EventTypes');
const { makeConfig } = require('./config');
const { startFakeDockerDaemon } = require('./fakeDockerDaemon');
const { startFakeTraefik } = require('./fakeTraefik');
const { createStubDnsProvider } = require('./stubDnsProvider');

/**
 * Timings small enough for tests, with every reconnect and debounce bound in tens of milliseconds.
 * @type {Readonly<Record<string, number>>}
 */
const FAST_TIMINGS = Object.freeze({
  reconnectInitialMs: 20,
  reconnectMaxMs: 100,
  stableConnectionMs: 1000,
  connectTimeoutMs: 500,
  refreshTimeoutMs: 500,
  eventDebounceMs: 30,
  eventDebounceMaxMs: 100
});

/**
 * @typedef {Object} TraefikPipelineOptions
 * @property {number} [apiVersion=1.54] - API version the fake Docker daemon serves.
 * @property {import('./fakeDockerDaemon').FakeContainer[]} [containers=[]] - Running containers at start.
 * @property {import('./fakeTraefik').FakeTraefikRouter[]} [routers=[]] - Traefik routers at start.
 * @property {boolean} [noise=false] - Turns on the fake daemon's `exec_*` noise.
 * @property {Record<string, number>} [timings] - Overrides of `FAST_TIMINGS`.
 * @property {Record<string, unknown>} [config] - `makeConfig` overrides shared by every service.
 * @property {Array<{ type: string, name: string }>} [records=[]] - Records the stub DNS provider already holds.
 */

/**
 * @typedef {Object} TraefikPipeline
 * @property {import('./fakeDockerDaemon').FakeDockerDaemon} daemon
 * @property {import('./fakeTraefik').FakeTraefik} traefik
 * @property {EventBus} bus
 * @property {DockerMonitor} dockerMonitor
 * @property {TraefikMonitor} monitor
 * @property {DNSManager} dnsManager
 * @property {import('./stubDnsProvider').StubDnsProvider} stub
 * @property {string} dataDir - Temporary record-tracker directory, removed on teardown.
 * @property {Array<{ hostnames: string[], containerLabels: Record<string, Record<string, string>> }>} routerUpdates - Every `TRAEFIK_ROUTERS_UPDATED` payload, in order.
 * @property {Array<{ stats: Object, processedHostnames: string[] }>} dnsUpdates - Every `DNS_RECORDS_UPDATED` payload, in order.
 * @property {() => Promise<void>} boot - Starts the services in `src/app.js` order.
 */

/**
 * Wires the fake Docker daemon, the fake Traefik API, DockerMonitor, TraefikMonitor and DNSManager (stub provider)
 * on one EventBus, as `src/app.js` does in traefik mode. Everything is torn down in `t.after`.
 * @param {import('node:test').TestContext} t
 * @param {TraefikPipelineOptions} [options={}]
 * @returns {Promise<TraefikPipeline>}
 */
async function startTraefikPipeline(t, options = {}) {
  const { apiVersion = 1.54, containers = [], routers = [], noise = false, timings = {}, config = {}, records = [] } = options;
  const daemon = await startFakeDockerDaemon({ apiVersion });
  daemon.setContainers(containers);
  daemon.noise(noise);
  const traefik = await startFakeTraefik({ routers });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafegodns-'));
  const serviceConfig = makeConfig({ traefikApiUrl: traefik.url, pollInterval: 3600000, ...config });

  const bus = new EventBus();
  const dockerMonitor = new DockerMonitor(serviceConfig, bus, {
    docker: daemon.docker,
    timings: { ...FAST_TIMINGS, ...timings },
    random: () => 0.5
  });
  const monitor = new TraefikMonitor(serviceConfig, bus);
  monitor.dockerMonitor = dockerMonitor;
  const stub = createStubDnsProvider({ records });
  const dnsManager = new DNSManager(serviceConfig, bus, { dnsProvider: stub, dataDir });

  const routerUpdates = [];
  const dnsUpdates = [];
  bus.subscribe(EventTypes.TRAEFIK_ROUTERS_UPDATED, (data) => routerUpdates.push(data));
  bus.subscribe(EventTypes.DNS_RECORDS_UPDATED, (data) => dnsUpdates.push(data));

  t.after(async () => {
    monitor.stopPolling();
    dockerMonitor.stopWatching();
    await daemon.stop();
    await traefik.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  return {
    daemon,
    traefik,
    bus,
    dockerMonitor,
    monitor,
    dnsManager,
    stub,
    dataDir,
    routerUpdates,
    dnsUpdates,
    async boot() {
      if (serviceConfig.watchDockerEvents) await dockerMonitor.startWatching();
      await dnsManager.init();
      await monitor.init();
      await monitor.startPolling();
    }
  };
}

/**
 * Hostnames the stub DNS provider received in any batch.
 * @param {import('./stubDnsProvider').StubDnsProvider} stub
 * @returns {string[]}
 */
function batchedHostnames(stub) {
  return stub.batches.flatMap((batch) => batch.map((record) => record.name));
}

module.exports = { FAST_TIMINGS, startTraefikPipeline, batchedHostnames };

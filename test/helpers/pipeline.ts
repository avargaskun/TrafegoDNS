import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DockerMonitor from '../../src/services/DockerMonitor';
import TraefikMonitor from '../../src/services/TraefikMonitor';
import DNSManager from '../../src/services/DNSManager';
import { EventBus } from '../../src/events/EventBus';
import EventTypes from '../../src/events/EventTypes';
import { makeConfig } from './config';
import { startFakeDockerDaemon } from './fakeDockerDaemon';
import { startFakeTraefik } from './fakeTraefik';
import { createStubDnsProvider } from './stubDnsProvider';
import type { TestContext } from 'node:test';
import type DNSProvider from '../../src/providers/base';
import type { DockerMonitorTimings } from '../../types/docker';
import type { StubDnsProvider, TraefikPipeline, TraefikPipelineOptions } from '../../types/test';

/**
 * Timings small enough for tests, with every reconnect and debounce bound in tens of milliseconds.
 */
const FAST_TIMINGS: Readonly<DockerMonitorTimings> = Object.freeze({
  reconnectInitialMs: 20,
  reconnectMaxMs: 100,
  stableConnectionMs: 1000,
  connectTimeoutMs: 500,
  refreshTimeoutMs: 500,
  eventDebounceMs: 30,
  eventDebounceMaxMs: 100
});

/**
 * Wires the fake Docker daemon, the fake Traefik API, DockerMonitor, TraefikMonitor and DNSManager (stub provider)
 * on one EventBus, as `src/app.js` does in traefik mode. Everything is torn down in `t.after`.
 * @param {import('node:test').TestContext} t
 * @param {TraefikPipelineOptions} [options={}]
 * @returns {Promise<TraefikPipeline>}
 */
async function startTraefikPipeline(t: TestContext, options: TraefikPipelineOptions = {}): Promise<TraefikPipeline> {
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
  const dnsManager = new DNSManager(serviceConfig, bus, { dnsProvider: stub as unknown as DNSProvider, dataDir });

  const routerUpdates: TraefikPipeline['routerUpdates'] = [];
  const dnsUpdates: TraefikPipeline['dnsUpdates'] = [];
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
function batchedHostnames(stub: StubDnsProvider): string[] {
  return stub.batches.flatMap((batch) => batch.map((record) => record.name));
}

export { FAST_TIMINGS, startTraefikPipeline, batchedHostnames };

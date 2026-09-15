// @ts-nocheck
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLogs } from '../helpers/logCapture';
import { waitFor } from '../helpers/waitFor';
import { startTraefikPipeline, batchedHostnames } from '../helpers/pipeline';
import { installExitWatchdog } from '../helpers/exitWatchdog';

installExitWatchdog();

const PROXY = {
  Id: 'c'.repeat(64),
  Names: ['/proxy'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.proxy.rule': 'Host(`proxy.example.com`)' }
};
const NEWAPP = {
  Id: 'a'.repeat(64),
  Names: ['/newapp'],
  Labels: { 'dns.manage': 'true', 'traefik.enable': 'true', 'traefik.http.routers.newapp.rule': 'Host(`newapp.example.com`)' }
};
const ROUTERS = [
  { name: 'proxy@docker', provider: 'docker', entryPoints: ['https'], service: 'proxy', rule: 'Host(`proxy.example.com`)', status: 'enabled' },
  { name: 'newapp@docker', provider: 'docker', entryPoints: ['https'], service: 'newapp', rule: 'Host(`newapp.example.com`)', status: 'enabled' }
];

const managesNewapp = (update) =>
  update.hostnames.includes('newapp.example.com') && update.containerLabels['newapp.example.com']?.['dns.manage'] === 'true';

for (const [label, apiVersion] of [['(a)', 1.54], ['(b)', 1.47]]) {
  test(`${label} an API ${apiVersion} start event brings the new container's hostname to the DNS provider`, async (t) => {
    const logs = captureLogs(t, 'INFO');
    const pipeline = await startTraefikPipeline(t, { apiVersion, containers: [PROXY], routers: ROUTERS, noise: true });
    const { daemon, dockerMonitor, stub, routerUpdates, dnsUpdates } = pipeline;

    await pipeline.boot();
    await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
    await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
    assert.deepEqual(dnsUpdates[0].processedHostnames, ['proxy.example.com']);
    assert.ok(!batchedHostnames(stub).includes('newapp.example.com'));
    assert.ok(!routerUpdates.some(managesNewapp), 'newapp is not managed before its container runs');

    const eventIndex = routerUpdates.length;
    daemon.setContainers([PROXY, NEWAPP]);
    assert.equal(daemon.emit('start', 'newapp', NEWAPP.Id), 1);

    await waitFor(() => dockerMonitor.getContainers().some((c) => c.name === 'newapp'), 2000, 'newapp in getContainers()');
    const update = await waitFor(() => routerUpdates.slice(eventIndex).find(managesNewapp), 2000, 'a router update with newapp after the event');
    await waitFor(() => batchedHostnames(stub).includes('newapp.example.com'), 2000, 'a stub batch with newapp.example.com');
    await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('newapp.example.com')), 2000, 'the DNS pass with newapp to finish');

    assert.deepEqual(update.hostnames, ['proxy.example.com', 'newapp.example.com']);
    assert.deepEqual(stub.created.map((record) => record.name).sort(), ['newapp.example.com', 'proxy.example.com']);
    assert.ok(logs.entries.some((entry) => entry.level === 'INFO' && entry.text.endsWith('Docker event start newapp')));
    assert.ok(logs.lines.some((line) => line.includes('Docker labels refreshed (trigger=event)')));
    assert.equal(logs.lines.filter((line) => line.includes('exec_')).length, 0);
  });
}

test('a health_status: healthy event brings a running container\'s new router to DNS, and a die event removes it', async (t) => {
  const logs = captureLogs(t, 'INFO');
  const pipeline = await startTraefikPipeline(t, { containers: [PROXY, NEWAPP], routers: [ROUTERS[0]], noise: true });
  const { daemon, traefik, dockerMonitor, routerUpdates, dnsUpdates } = pipeline;
  const infoTexts = () => logs.entries.filter((entry) => entry.level === 'INFO').map((entry) => entry.text);

  await pipeline.boot();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
  assert.deepEqual(dnsUpdates[0].processedHostnames, ['proxy.example.com']);
  assert.ok(dockerMonitor.getContainers().some((c) => c.name === 'newapp'), 'newapp is running from boot');

  const healthyIndex = routerUpdates.length;
  traefik.setRouters(ROUTERS);
  assert.equal(daemon.emit('health_status: healthy', 'newapp', NEWAPP.Id), 1);

  const update = await waitFor(() => routerUpdates.slice(healthyIndex).find(managesNewapp), 2000, 'a router update with newapp after health_status: healthy');
  assert.deepEqual(update.hostnames, ['proxy.example.com', 'newapp.example.com']);
  await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('newapp.example.com')), 2000, 'the DNS pass with newapp to finish');

  daemon.setContainers([PROXY]);
  traefik.setRouters([ROUTERS[0]]);
  assert.equal(daemon.emit('die', 'newapp', NEWAPP.Id), 1);

  await waitFor(() => infoTexts().some((text) => text.endsWith('Managing 1 hostnames (-newapp.example.com)')), 2000, 'the managed-set line without newapp');
  assert.ok(infoTexts().some((text) => text.endsWith('Docker event health_status: healthy newapp')));
  assert.ok(infoTexts().some((text) => text.endsWith('Docker event die newapp')));
  assert.equal(logs.lines.filter((line) => line.includes('exec_')).length, 0);
});

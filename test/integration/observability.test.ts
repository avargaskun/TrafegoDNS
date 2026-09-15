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

const RECONNECTED = /Docker event stream reconnected after \d+ attempt\(s\); re-listed (\d+) running containers \(trigger=reconnect\)$/;

function infoLines(entries) {
  return entries.filter((entry) => entry.level === 'INFO').map((entry) => entry.text);
}

test('(m) at INFO, an event and a reconnect produce the catalogue lines and no exec_ noise', async (t) => {
  const logs = captureLogs(t, 'INFO');
  const pipeline = await startTraefikPipeline(t, { containers: [PROXY], routers: ROUTERS, noise: true });
  const { daemon, stub, dnsUpdates } = pipeline;

  await pipeline.boot();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');
  await waitFor(() => daemon.openEventStreams() === 1, 2000, 'the event stream to open');
  const sentBefore = daemon.stats.eventsSent;
  await waitFor(() => daemon.stats.eventsSent >= sentBefore + 18, 2000, 'exec noise on the stream');

  daemon.setContainers([PROXY, NEWAPP]);
  assert.equal(daemon.emit('start', 'newapp', NEWAPP.Id), 1);
  await waitFor(() => batchedHostnames(stub).includes('newapp.example.com'), 2000, 'the stub pass with newapp.example.com');
  await waitFor(() => dnsUpdates.some((u) => u.processedHostnames.includes('newapp.example.com')), 2000, 'the DNS pass with newapp to finish');

  const passesBeforeSever = dnsUpdates.length;
  daemon.sever();
  await waitFor(() => infoLines(logs.entries).some((text) => RECONNECTED.test(text)), 3000, 'the reconnect INFO line');
  await waitFor(() => dnsUpdates.length > passesBeforeSever, 2000, 'the DNS pass requested by the reconnect');

  const info = infoLines(logs.entries);
  assert.ok(info.some((text) => text.endsWith('Docker event start newapp')), 'Docker event start newapp');
  assert.ok(info.some((text) => text.includes('Docker labels refreshed (trigger=event)')), 'trigger=event');
  assert.equal(Number(RECONNECTED.exec(info.find((text) => RECONNECTED.test(text)))[1]), 2);
  assert.ok(info.some((text) => /Managing \d+ hostnames \(\+newapp\.example\.com\)/.test(text)), 'managed-set line for newapp');
  assert.ok(info.some((text) => /Managing 1 hostnames$/.test(text)), 'managed-set line for the first pass');

  const warns = logs.entries.filter((entry) => entry.level === 'WARN').map((entry) => entry.text);
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.match(warns[0], /Docker event stream (error: .+|ended); reconnecting$/);

  assert.deepEqual(logs.lines.filter((line) => line.includes('exec_')), []);
});

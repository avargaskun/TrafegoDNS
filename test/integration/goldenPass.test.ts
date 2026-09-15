import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as golden from '../fixtures/goldenAttribution';
import { captureLogs } from '../helpers/logCapture';
import { waitFor } from '../helpers/waitFor';
import { startTraefikPipeline, batchedHostnames } from '../helpers/pipeline';
import { installExitWatchdog } from '../helpers/exitWatchdog';
import type { StubDnsRecordConfig } from '../../types/test';

installExitWatchdog();

const PRESEEDED = ['app.example.com', 'watcher.example.com', 'traefik.example.com'];
const SEED_RECORDS = PRESEEDED.map((name) => ({ type: 'CNAME', name, content: 'example.com', proxied: true, ttl: 1 }));
const AMBIGUITY_WARN = 'Router shared@docker is claimed by containers left, right with different DNS labels; leaving its hostnames unmanaged';
const FALLBACK_INFO = 'Router legacy@docker attributed to container legacy (no traefik.enable label)';

const names = (records: StubDnsRecordConfig[]) => records.map((record) => record.name).sort();

test('(i) the golden set runs end to end: exact managed set, no writes for correct records, idempotent re-poll', async (t) => {
  const logs = captureLogs(t, 'INFO');
  const pipeline = await startTraefikPipeline(t, {
    containers: golden.containers,
    routers: golden.routers,
    config: { defaultManage: false },
    records: SEED_RECORDS
  });
  const { monitor, stub, routerUpdates, dnsUpdates } = pipeline;

  await pipeline.boot();
  await waitFor(() => dnsUpdates.length >= 1, 2000, 'the first DNS pass');

  assert.deepEqual([...dnsUpdates[0].processedHostnames].sort(), golden.expectedManagedHostnames);
  assert.equal(routerUpdates.length, 1);
  for (const excluded of golden.expectedExcludedHostnames) {
    assert.ok(!routerUpdates[0].hostnames.includes(excluded), `${excluded} is not published`);
  }
  assert.equal(stub.batches.length, 1);
  assert.deepEqual(names(stub.batches[0]), golden.expectedManagedHostnames);
  assert.deepEqual(names(stub.created), golden.expectedManagedHostnames.filter((name) => !PRESEEDED.includes(name)));
  assert.deepEqual(stub.updated, []);
  assert.deepEqual(names(stub.unchanged), [...PRESEEDED].sort());
  const legacyRecord = stub.created.find((record) => record.name === 'legacy.example.com');
  assert.ok(legacyRecord, 'legacy.example.com is created');
  assert.equal(legacyRecord.proxied, false);

  const batchesBefore = stub.batches.length;
  const createdBefore = stub.created.length;
  const updatedBefore = stub.updated.length;
  await monitor.pollTraefikAPI();
  await waitFor(() => stub.batches.length > batchesBefore, 2000, 'the second DNS pass to reach the stub');
  await waitFor(() => dnsUpdates.length >= 2, 2000, 'the second DNS pass to finish');

  assert.equal(stub.created.length, createdBefore);
  assert.equal(stub.updated.length, updatedBefore);
  assert.deepEqual(names(stub.batches[1]), golden.expectedManagedHostnames);
  assert.deepEqual([...dnsUpdates[1].processedHostnames].sort(), golden.expectedManagedHostnames);
  for (const excluded of golden.expectedExcludedHostnames) {
    assert.ok(!batchedHostnames(stub).includes(excluded), `${excluded} is in no batch`);
  }
  assert.ok(!batchedHostnames(stub).includes('disabled.example.com'), 'disabled.example.com is in no batch');

  const warns = logs.entries.filter((entry) => entry.level === 'WARN').map((entry) => entry.text);
  assert.equal(warns.length, 1, warns.join('\n'));
  assert.ok(warns[0].endsWith(AMBIGUITY_WARN), warns[0]);
  const managing = logs.entries.filter((entry) => entry.level === 'INFO' && /Managing \d+ hostnames/.test(entry.text));
  assert.equal(managing.length, 1, managing.map((entry) => entry.text).join('\n'));
  assert.ok(managing[0].text.endsWith(`Managing ${golden.expectedManagedHostnames.length} hostnames`));
  const fallbackInfos = logs.entries.filter((entry) => entry.level === 'INFO' && entry.text.endsWith(FALLBACK_INFO));
  assert.equal(fallbackInfos.length, 1, fallbackInfos.map((entry) => entry.text).join('\n'));
});

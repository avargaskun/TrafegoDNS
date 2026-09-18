import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import RecordTracker from '../../src/utils/recordTracker';
import { makeConfig } from '../helpers/config';
import { captureLogs } from '../helpers/logCapture';
import { installExitWatchdog } from '../helpers/exitWatchdog';
import type { TestContext } from 'node:test';
import type { TestConfig } from '../../types/test';

installExitWatchdog();

function makeTmpDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trafegodns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createTracker(t: TestContext, config: Partial<TestConfig>): RecordTracker {
  return new RecordTracker(makeConfig({ ...config }), makeTmpDir(t));
}

test('a managed hostname accepts any truthy proxied spelling', (t) => {
  const tracker = createTracker(t, {
    managedHostnames: 'a.example.com:A:192.0.2.1:3600:1',
    defaultProxied: false
  });

  assert.equal(tracker.managedHostnames[0].proxied, true);
});

test('a managed hostname accepts any falsy proxied spelling', (t) => {
  const tracker = createTracker(t, {
    managedHostnames: 'a.example.com:A:192.0.2.1:3600:off',
    defaultProxied: true
  });

  assert.equal(tracker.managedHostnames[0].proxied, false);
});

test('an omitted proxied field inherits the global default', (t) => {
  const tracker = createTracker(t, {
    managedHostnames: 'a.example.com:A:192.0.2.1:3600',
    defaultProxied: true
  });

  assert.equal(tracker.managedHostnames[0].proxied, true);
});

test('an unrecognised proxied field warns and inherits the default', (t) => {
  const { entries } = captureLogs(t);

  const tracker = createTracker(t, {
    managedHostnames: 'a.example.com:A:192.0.2.1:3600:orange',
    defaultProxied: true
  });

  assert.equal(tracker.managedHostnames[0].proxied, true);
  const warnings = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /a\.example\.com/);
});

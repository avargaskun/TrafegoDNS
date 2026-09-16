import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../helpers/env';
import { installExitWatchdog } from '../helpers/exitWatchdog';

installExitWatchdog();

test('the helper constructs the real ConfigManager offline', () => {
  const config = buildConfig();
  assert.equal(config.dnsProvider, 'cloudflare');
  assert.equal(config.ipRefreshInterval, 0);
});

test('an unsupported DNS provider still fails fast', () => {
  assert.throws(() => buildConfig({ DNS_PROVIDER: 'nope' }), /Unsupported DNS provider: nope/);
});

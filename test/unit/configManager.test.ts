import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../helpers/env';
import { installExitWatchdog } from '../helpers/exitWatchdog';
import { captureLogs } from '../helpers/logCapture';

installExitWatchdog();

test('the helper constructs the real ConfigManager offline', () => {
  const config = buildConfig();
  assert.equal(config.dnsProvider, 'cloudflare');
  assert.equal(config.ipRefreshInterval, 0);
});

test('an unsupported DNS provider still fails fast', () => {
  assert.throws(() => buildConfig({ DNS_PROVIDER: 'nope' }), /Unsupported DNS provider: nope/);
});

test('CLEANUP_ORPHANED=0 keeps cleanup off', () => {
  assert.equal(buildConfig({ CLEANUP_ORPHANED: '0' }).cleanupOrphaned, false);
});

test('WATCH_DOCKER_EVENTS=FALSE turns event watching off', () => {
  assert.equal(buildConfig({ WATCH_DOCKER_EVENTS: 'FALSE' }).watchDockerEvents, false);
});

test('DNS_DEFAULT_PROXIED=0 turns proxying off everywhere', () => {
  const config = buildConfig({ DNS_DEFAULT_PROXIED: '0' });
  assert.equal(config.defaultProxied, false);
  assert.equal(config.recordDefaults.A.proxied, false);
  assert.equal(config.recordDefaults.AAAA.proxied, false);
  assert.equal(config.recordDefaults.CNAME.proxied, false);
});

test('a per-type proxied override beats the global default', () => {
  const config = buildConfig({ DNS_DEFAULT_A_PROXIED: 'off' });
  assert.equal(config.recordDefaults.A.proxied, false);
  assert.equal(config.recordDefaults.AAAA.proxied, true);
  assert.equal(config.recordDefaults.CNAME.proxied, true);
});

test('an unrecognised proxied value warns and keeps the default', (t) => {
  const { entries } = captureLogs(t);

  const config = buildConfig({ DNS_DEFAULT_CNAME_PROXIED: 'orange' });

  assert.equal(config.recordDefaults.CNAME.proxied, true);
  const warnings = entries.filter((entry) => entry.level === 'WARN');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /DNS_DEFAULT_CNAME_PROXIED/);
});

test('DNS_PROVIDER is case-insensitive', () => {
  const config = buildConfig({ DNS_PROVIDER: 'Cloudflare' });
  assert.equal(config.dnsProvider, 'cloudflare');
  assert.equal(config.dnsLabelPrefix, 'dns.cloudflare.');
});

test('DNS_PROVIDER tolerates padding and picks the provider defaults', () => {
  const config = buildConfig({
    DNS_PROVIDER: ' RoUte53 ',
    ROUTE53_ACCESS_KEY: 'SYNTHETIC-ACCESS-KEY',
    ROUTE53_SECRET_KEY: 'SYNTHETIC-SECRET-KEY',
    ROUTE53_ZONE: 'example.com'
  });
  assert.equal(config.dnsProvider, 'route53');
  assert.equal(config.dnsLabelPrefix, 'dns.route53.');
  assert.equal(config.defaultTTL, 60);
  assert.equal(config.getProviderDomain(), 'example.com');
});

test('a blank DNS_PROVIDER falls back to Cloudflare', () => {
  assert.equal(buildConfig({ DNS_PROVIDER: '' }).dnsProvider, 'cloudflare');
});

test('OPERATION_MODE tolerates case and padding', () => {
  assert.equal(buildConfig({ OPERATION_MODE: ' Direct ' }).operationMode, 'direct');
});

test('the shipped .env.example starts', () => {
  const config = buildConfig({ DNS_DEFAULT_TTL: '', MANAGED_HOSTNAMES: '' });
  assert.equal(config.defaultTTL, 1);
});

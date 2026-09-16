import { test } from 'node:test';
import assert from 'node:assert/strict';
import DNSProviderFactory from '../../src/providers/factory';
import { makeConfig } from '../helpers/config';
import { captureLogs } from '../helpers/logCapture';

test('the factory looks up the provider by its lower-case name', (t) => {
  const { entries } = captureLogs(t);

  const provider = DNSProviderFactory.createProvider(makeConfig({ dnsProvider: 'Cloudflare' }));

  assert.equal(provider.constructor.name, 'CloudflareProvider');
  assert.ok(entries.some((entry) => entry.text.includes('Creating DNS provider: cloudflare')));
});

test('an unknown provider fails with a message naming it', (t) => {
  captureLogs(t);

  assert.throws(
    () => DNSProviderFactory.createProvider(makeConfig({ dnsProvider: 'nope' })),
    /DNS provider 'nope' not found/
  );
});

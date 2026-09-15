import type ConfigManager from '../../src/config/ConfigManager';
import type { TestConfig } from '../../types/test';

/**
 * Plain config object for tests; stands in for ConfigManager, which must never be constructed in tests.
 * @param {Partial<TestConfig> & Record<string, unknown>} [overrides={}] - Values that replace the defaults.
 * @returns {ConfigManager}
 */
function makeConfig(overrides: Partial<TestConfig> & Record<string, unknown> = {}): ConfigManager {
  return {
    genericLabelPrefix: 'dns.',
    dnsLabelPrefix: 'dns.cloudflare.',
    traefikLabelPrefix: 'traefik.',
    dnsProvider: 'cloudflare',
    defaultManage: false,
    cleanupOrphaned: false,
    cleanupGracePeriod: 15,
    watchDockerEvents: true,
    pollInterval: 3600000,
    apiTimeout: 2000,
    cacheRefreshInterval: 3600000,
    defaultRecordType: 'CNAME',
    managedHostnames: '',
    getProviderDomain: () => 'example.com',
    getDefaultsForType: () => ({ content: 'example.com', proxied: true, ttl: 1 }),
    getPublicIPSync: () => '192.0.2.10',
    getPublicIP: async () => '192.0.2.10',
    dockerSocket: '/var/run/docker.sock',
    operationMode: 'traefik',
    traefikApiUrl: 'http://127.0.0.1:1/api',
    cloudflareToken: 'SYNTHETIC-TOKEN-123',
    cloudflareZone: 'example.com',
    ...overrides
  } as unknown as ConfigManager;
}

export { makeConfig };

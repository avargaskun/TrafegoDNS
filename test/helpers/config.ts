// @ts-nocheck
/**
 * @typedef {Object} TestConfig
 * @property {string} genericLabelPrefix
 * @property {string} dnsLabelPrefix
 * @property {string} traefikLabelPrefix
 * @property {string} dnsProvider
 * @property {boolean} defaultManage
 * @property {boolean} cleanupOrphaned
 * @property {number} cleanupGracePeriod
 * @property {boolean} watchDockerEvents
 * @property {number} pollInterval
 * @property {number} apiTimeout
 * @property {number} cacheRefreshInterval
 * @property {string} defaultRecordType
 * @property {string} managedHostnames
 * @property {string} dockerSocket
 * @property {string} operationMode
 * @property {string} traefikApiUrl
 * @property {string} cloudflareToken
 * @property {string} cloudflareZone
 * @property {() => string} getProviderDomain
 * @property {(type: string) => { content: string, proxied: boolean, ttl: number }} getDefaultsForType
 * @property {() => string} getPublicIPSync
 * @property {() => Promise<string>} getPublicIP
 */

/**
 * Plain config object for tests; stands in for ConfigManager, which must never be constructed in tests.
 * @param {Partial<TestConfig> & Record<string, unknown>} [overrides={}] - Values that replace the defaults.
 * @returns {TestConfig & Record<string, unknown>}
 */
function makeConfig(overrides = {}) {
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
  };
}

export { makeConfig };

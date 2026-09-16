import ConfigManager from '../../src/config/ConfigManager';

const OWNED_PREFIXES = [
  'DNS_', 'CLOUDFLARE_', 'ROUTE53_', 'DO_', 'TRAEFIK_', 'PUBLIC_IP', 'OPERATION_MODE',
  'MANAGED_HOSTNAMES', 'PRESERVED_HOSTNAMES', 'WATCH_DOCKER_EVENTS', 'CLEANUP_', 'POLL_INTERVAL',
  'API_TIMEOUT', 'IP_REFRESH_INTERVAL', 'DOCKER_SOCKET', 'TEST_'
];

/** PUBLIC_IP/PUBLIC_IPV6 keep updatePublicIPs off the network; IP_REFRESH_INTERVAL=0 skips its setInterval. */
const OFFLINE_PINS = { PUBLIC_IP: '192.0.2.10', PUBLIC_IPV6: '2001:db8::10', IP_REFRESH_INTERVAL: '0' };

const CLOUDFLARE_CREDENTIALS = {
  DNS_PROVIDER: 'cloudflare',
  CLOUDFLARE_TOKEN: 'SYNTHETIC-TOKEN-123',
  CLOUDFLARE_ZONE: 'example.com'
};

/**
 * Runs `fn` with a pinned environment: every TráfegoDNS-owned variable is cleared, the offline pins and
 * `vars` are applied, and the original `process.env` is restored afterwards.
 * @param {Record<string, string>} vars - Variables layered over the offline pins.
 * @param {() => T} fn - Callback run with the pinned environment.
 * @returns {T}
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const snapshot = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (OWNED_PREFIXES.some((prefix) => name.startsWith(prefix))) delete process.env[name];
    }
    Object.assign(process.env, OFFLINE_PINS, vars);
    return fn();
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, snapshot);
  }
}

/**
 * Constructs the real ConfigManager offline, with valid Cloudflare credentials layered under `vars`.
 * Never pass a blank `PUBLIC_IP`: it defeats the offline pin and the constructor fetches the public IP for real.
 * @param {Record<string, string>} [vars={}] - Variables that replace the defaults.
 * @returns {ConfigManager}
 */
function buildConfig(vars: Record<string, string> = {}): ConfigManager {
  return withEnv({ ...CLOUDFLARE_CREDENTIALS, ...vars }, () => new ConfigManager());
}

export { withEnv, buildConfig };

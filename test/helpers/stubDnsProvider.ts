import type { StubDnsProvider, StubDnsProviderOptions, StubDnsRecord } from '../../types/test';

const COMPARED_KEYS = ['content', 'ttl', 'proxied'] as const;

/**
 * In-memory DNS provider for DNSManager tests.
 * @param {StubDnsProviderOptions} [options={}]
 * @returns {StubDnsProvider}
 */
function createStubDnsProvider({ records = [] }: StubDnsProviderOptions = {}): StubDnsProvider {
  let nextId = 1;
  const newId = () => `stub-${nextId++}`;
  const snapshot = (record: StubDnsRecord) => ({ ...record });

  const provider: StubDnsProvider = {
    records: records.map((record) => ({ ...record, id: record.id ?? newId() })),
    batches: [],
    created: [],
    updated: [],
    unchanged: [],
    calls: [],

    async init() {
      provider.calls.push('init');
    },

    async batchEnsureRecords(configs) {
      provider.calls.push('batchEnsureRecords');
      provider.batches.push(configs);
      const results = [];
      for (const config of configs) {
        const name = config.name.toLowerCase();
        const existing = provider.records.find((record) => record.type === config.type && record.name.toLowerCase() === name);
        if (!existing) {
          const record: StubDnsRecord = { id: newId(), type: config.type, name: config.name };
          for (const key of COMPARED_KEYS) {
            if (config[key] !== undefined) (record as Record<typeof key, unknown>)[key] = config[key];
          }
          provider.records.push(record);
          provider.created.push(snapshot(record));
          results.push(snapshot(record));
          continue;
        }
        const changedKeys = COMPARED_KEYS.filter((key) => config[key] !== undefined && config[key] !== existing[key]);
        if (changedKeys.length > 0) {
          for (const key of changedKeys) (existing as Record<typeof key, unknown>)[key] = config[key];
          provider.updated.push(snapshot(existing));
        } else {
          provider.unchanged.push(snapshot(existing));
        }
        results.push(snapshot(existing));
      }
      return results;
    },

    async getRecordsFromCache() {
      provider.calls.push('getRecordsFromCache');
      return provider.records.map(snapshot);
    },

    async deleteRecord(id) {
      provider.calls.push('deleteRecord');
      const index = provider.records.findIndex((record) => record.id === id);
      if (index === -1) return false;
      provider.records.splice(index, 1);
      return true;
    }
  };

  return provider;
}

export { createStubDnsProvider };

// @ts-nocheck
/**
 * @typedef {Object} StubDnsRecord
 * @property {string} id
 * @property {string} type
 * @property {string} name
 * @property {string} [content]
 * @property {number} [ttl]
 * @property {boolean} [proxied]
 */

/**
 * @typedef {Object} StubDnsRecordConfig
 * @property {string} type
 * @property {string} name
 * @property {string} [content]
 * @property {number} [ttl]
 * @property {boolean} [proxied]
 */

/**
 * @typedef {Object} StubDnsProviderOptions
 * @property {Array<Partial<StubDnsRecord> & { type: string, name: string }>} [records=[]] - Records the provider already holds; each gets a `stub-N` id unless it has one.
 */

/**
 * @typedef {Object} StubDnsProvider
 * @property {() => Promise<void>} init
 * @property {(configs: StubDnsRecordConfig[]) => Promise<StubDnsRecord[]>} batchEnsureRecords - Creates, updates or leaves each record, matched by `type` and case-insensitive `name`.
 * @property {(forceRefresh?: boolean) => Promise<StubDnsRecord[]>} getRecordsFromCache
 * @property {(id: string) => Promise<boolean>} deleteRecord - Plain method so tests can spy on it with `t.mock.method`.
 * @property {StubDnsRecord[]} records - Live list of the records the provider holds.
 * @property {StubDnsRecordConfig[][]} batches - Every `batchEnsureRecords` argument, in call order.
 * @property {StubDnsRecord[]} created - Snapshots of records created by `batchEnsureRecords`.
 * @property {StubDnsRecord[]} updated - Snapshots of records updated by `batchEnsureRecords`.
 * @property {StubDnsRecord[]} unchanged - Snapshots of records `batchEnsureRecords` found already correct.
 * @property {string[]} calls - Names of the provider methods called, in order.
 */

const COMPARED_KEYS = ['content', 'ttl', 'proxied'];

/**
 * In-memory DNS provider for DNSManager tests.
 * @param {StubDnsProviderOptions} [options={}]
 * @returns {StubDnsProvider}
 */
function createStubDnsProvider({ records = [] } = {}) {
  let nextId = 1;
  const newId = () => `stub-${nextId++}`;
  const snapshot = (record) => ({ ...record });

  const provider = {
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
          const record = { id: newId(), type: config.type, name: config.name };
          for (const key of COMPARED_KEYS) {
            if (config[key] !== undefined) record[key] = config[key];
          }
          provider.records.push(record);
          provider.created.push(snapshot(record));
          results.push(snapshot(record));
          continue;
        }
        const changedKeys = COMPARED_KEYS.filter((key) => config[key] !== undefined && config[key] !== existing[key]);
        if (changedKeys.length > 0) {
          for (const key of changedKeys) existing[key] = config[key];
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

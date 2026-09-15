export interface DnsRecordConfig {
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  weight?: number;
  port?: number;
  flags?: number;
  tag?: string;
  comment?: string;
  needsIpLookup?: boolean;
}

export interface DnsRecord {
  id: string | number;
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  weight?: number;
  port?: number;
  flags?: number;
  tag?: string;
  comment?: string;
}

export interface ListRecordsParams {
  type?: string;
  name?: string;
  [key: string]: unknown;
}

export interface RecordCache {
  records: DnsRecord[];
  lastUpdated: number;
}

export interface DnsStats {
  created: number;
  updated: number;
  upToDate: number;
  errors: number;
  total: number;
}

export interface TrackedRecord {
  id: string | number;
  provider: string;
  domain: string;
  name: string;
  type: string;
  createdAt: string;
  managedBy: string;
  updatedAt?: string;
  orphanedAt?: string;
}

export interface ManagedHostname {
  hostname: string;
  type: string;
  content: string | null;
  ttl: number;
  proxied: boolean;
}

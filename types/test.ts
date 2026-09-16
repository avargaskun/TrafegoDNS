import type Docker from 'dockerode';
import type DockerMonitor from '../src/services/DockerMonitor';
import type TraefikMonitor from '../src/services/TraefikMonitor';
import type DNSManager from '../src/services/DNSManager';
import type { EventBus } from '../src/events/EventBus';
import type { DockerMonitorTimings, LabelMap } from './docker';
import type { EventPayloads } from './events';

export interface TestConfig {
  genericLabelPrefix: string;
  dnsLabelPrefix: string;
  traefikLabelPrefix: string;
  dnsProvider: string;
  defaultManage: boolean;
  cleanupOrphaned: boolean;
  cleanupGracePeriod: number;
  watchDockerEvents: boolean;
  pollInterval: number;
  apiTimeout: number;
  cacheRefreshInterval: number;
  defaultRecordType: string;
  managedHostnames: string;
  dockerSocket: string;
  operationMode: string;
  traefikApiUrl: string;
  cloudflareToken: string;
  cloudflareZone: string;
  getProviderDomain: () => string;
  getDefaultsForType: (type: string) => { content: string; proxied: boolean; ttl: number };
  getPublicIPSync: () => string;
  getPublicIP: () => Promise<string>;
}

export type LogLevelName = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

export interface LogEntry {
  level: LogLevelName | null;
  text: string;
}

export interface CapturedLogs {
  lines: string[];
  entries: LogEntry[];
}

export interface StubDnsRecord {
  id: string;
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

export interface StubDnsRecordConfig {
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

export interface StubDnsProviderOptions {
  records?: Array<Partial<StubDnsRecord> & { type: string; name: string }>;
}

export interface StubDnsProvider {
  init: () => Promise<void>;
  /** Creates, updates or leaves each record, matched by `type` and case-insensitive `name`. */
  batchEnsureRecords: (configs: StubDnsRecordConfig[]) => Promise<StubDnsRecord[]>;
  getRecordsFromCache: (forceRefresh?: boolean) => Promise<StubDnsRecord[]>;
  /** Plain method so tests can spy on it with `t.mock.method`. */
  deleteRecord: (id: string) => Promise<boolean>;
  records: StubDnsRecord[];
  batches: StubDnsRecordConfig[][];
  created: StubDnsRecord[];
  updated: StubDnsRecord[];
  unchanged: StubDnsRecord[];
  calls: string[];
}

export interface FakeCloudflareRecord {
  id?: string;
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  comment?: string;
}

export interface FakeCloudflareOptions {
  zoneName?: string;
  zoneId?: string;
  records?: FakeCloudflareRecord[];
}

export interface FakeCloudflareListingQuirks {
  totalPages?: number;
  omitResultInfo?: boolean;
}

/** A request as received; headers are deliberately never recorded. */
export interface FakeCloudflareRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  body?: any;
}

export interface FakeCloudflare {
  port: number;
  baseURL: string;
  setRecords: (list: FakeCloudflareRecord[]) => void;
  failPage: (page: number | null, status?: number) => void;
  setWriteFailure: (status: number | null) => void;
  setListingQuirks: (quirks: FakeCloudflareListingQuirks) => void;
  requests: FakeCloudflareRequest[];
  stop: () => Promise<void>;
}

export interface FakeContainer {
  Id: string;
  Names: string[];
  Labels?: LabelMap;
}

export type ContainersMode = 'ok' | 'fail' | 'hang';

export type EventsMode = 'ok' | 'refuse' | 'hang';

export interface FakeDockerDaemonOptions {
  apiVersion?: number;
  seed?: number;
}

export interface FakeDockerDaemonStats {
  /** Total `/events` requests received, refused and hanging ones included. */
  eventsConnections: number;
  /** Total `/containers/json` requests received, failed and hanging ones included. */
  listRequests: number;
  /** Total events written, counted once per receiving `/events` response. */
  eventsSent: number;
}

export interface FakeDockerDaemon {
  port: number;
  docker: Docker;
  setContainers: (list: FakeContainer[]) => void;
  emit: (action: string, name: string, id?: string, extraAttrs?: Record<string, string>) => number;
  noise: (on: boolean) => void;
  sever: () => void;
  endCleanly: () => void;
  endMidObject: () => void;
  /** `fail` answers 500; `hang` never answers until `stop()`. */
  setContainersMode: (mode: ContainersMode) => void;
  /** `refuse` answers `/events` with 500; `hang` never sends headers until the client aborts or `stop()`. */
  setEventsMode: (mode: EventsMode) => void;
  stop: () => Promise<void>;
  /** Listens again on the same port. */
  restart: () => Promise<void>;
  openEventStreams: () => number;
  stats: FakeDockerDaemonStats;
}

export interface FakeTraefikRouter {
  name: string;
  provider?: string;
  entryPoints?: string[];
  service?: string;
  rule?: string;
  status?: string;
}

export interface FakeTraefikOptions {
  routers?: FakeTraefikRouter[];
}

export interface FakeTraefikStats {
  routerRequests: number;
}

export interface FakeTraefik {
  port: number;
  url: string;
  setRouters: (list: FakeTraefikRouter[]) => void;
  stats: FakeTraefikStats;
  stop: () => Promise<void>;
}

export interface TraefikPipelineOptions {
  apiVersion?: number;
  containers?: FakeContainer[];
  routers?: FakeTraefikRouter[];
  noise?: boolean;
  timings?: Partial<DockerMonitorTimings>;
  config?: Record<string, unknown>;
  records?: Array<{ type: string; name: string }>;
}

export interface TraefikPipeline {
  daemon: FakeDockerDaemon;
  traefik: FakeTraefik;
  bus: EventBus;
  dockerMonitor: DockerMonitor;
  monitor: TraefikMonitor;
  dnsManager: DNSManager;
  stub: StubDnsProvider;
  dataDir: string;
  routerUpdates: Array<EventPayloads['traefik:routers:updated']>;
  dnsUpdates: Array<EventPayloads['dns:records:updated']>;
  boot: () => Promise<void>;
}

export type ProcessFault = [kind: 'unhandledRejection' | 'uncaughtException', error: any];

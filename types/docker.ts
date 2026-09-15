import type Docker from 'dockerode';

export type LabelMap = Record<string, string>;

export type ContainerLabelsCache = Record<string, LabelMap>;

export interface ContainerSummary {
  id: string;
  name: string;
  labels: LabelMap;
}

export interface DockerEventLike {
  Type?: string;
  Action?: string;
  status?: string;
  id?: string;
  Actor?: {
    ID?: string;
    Attributes?: {
      name?: string;
    };
  };
}

export interface ClassifiedEvent {
  action: string;
  id: string | null;
  name: string;
}

export type RefreshTrigger = 'boot' | 'event' | 'reconnect' | 'poll';

export type RefreshResult =
  | { ok: true; containerCount: number; changed: string[]; error?: never }
  | { ok: false; error: any; containerCount?: never; changed?: never };

export interface DockerMonitorTimings {
  eventDebounceMs: number;
  eventDebounceMaxMs: number;
  reconnectInitialMs: number;
  reconnectMaxMs: number;
  stableConnectionMs: number;
  connectTimeoutMs: number;
  refreshTimeoutMs: number;
}

export interface DockerMonitorOptions {
  docker?: Docker;
  timings?: Partial<DockerMonitorTimings>;
  random?: () => number;
}

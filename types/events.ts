import type EventTypes from '../src/events/EventTypes';
import type { ContainerLabelsCache, ContainerSummary, LabelMap, RefreshTrigger } from './docker';
import type { DnsStats } from './dns';

export type EventName = (typeof EventTypes)[keyof typeof EventTypes];

export interface EventPayloads {
  'config:updated': Record<string, unknown>;
  'ip:updated': Record<string, unknown>;
  'traefik:poll:started': Record<string, never>;
  'traefik:poll:completed': { routerCount?: number; hostnameCount: number };
  'traefik:routers:updated': { hostnames: string[]; containerLabels: Record<string, LabelMap> };
  'docker:container:started': { containerId: string | null; containerName: string; status: string };
  'docker:container:stopped': { containerId: string | null; containerName: string; status: string };
  'docker:labels:updated': {
    containerLabelsCache: ContainerLabelsCache;
    containerIdToName: Map<string, string>;
    containers: ContainerSummary[];
    hasChanges: boolean;
    trigger: RefreshTrigger;
  };
  'dns:records:updated': { stats: DnsStats; processedHostnames: string[] };
  'dns:record:created': { count: number };
  'dns:record:updated': { count: number };
  'dns:record:deleted': { name: string; type: string };
  'dns:cache:refreshed': Record<string, unknown>;
  'status:update': { message: string; type?: 'success' | 'warning' | 'debug' | 'trace' | 'info' };
  'error:occurred': { source: string; error: string };
}

export type EventHandler<K extends keyof EventPayloads> = (data: EventPayloads[K]) => void;

export type EventWithoutPayload = { [K in EventName]: {} extends EventPayloads[K] ? K : never }[EventName];

type Assert<T extends true> = T;

type EventPayloadsMatchEventNames = Assert<[EventName] extends [keyof EventPayloads] ? ([keyof EventPayloads] extends [EventName] ? true : false) : false>;

import type { ContainerSummary, LabelMap } from './docker';

export interface TraefikRouter {
  name: string;
  rule?: string;
  service: string;
  provider?: string;
  entryPoints?: string[];
}

export interface RouterRef {
  name: string;
  provider?: string;
  entryPoints?: string[];
  service: string;
}

export type HostnameRouters = Map<string, RouterRef[]> | Record<string, RouterRef[]>;

export type OwnerReason = 'not-docker' | 'router-labels' | 'entrypoint-split' | 'default-router' | 'no-owner';

export interface OwnerResult {
  owner: ContainerSummary | null;
  ambiguous: boolean;
  owners: ContainerSummary[];
  reason: OwnerReason;
}

export type ResolvedOwner = OwnerResult & { via: 'strict' | 'fallback' | null };

export interface CandidatePools {
  strict: ContainerSummary[];
  fallback: ContainerSummary[];
}

export interface AmbiguousRouter {
  routerName: string;
  ownerNames: string[];
}

export interface OwnerConflict {
  hostname: string;
  ownerNames: string[];
  chosen: string;
}

export interface FallbackRouter {
  routerName: string;
  ownerName: string;
}

export interface HostnameLabelsResult {
  containerLabels: Record<string, LabelMap>;
  excludedHostnames: Set<string>;
  ambiguousRouters: AmbiguousRouter[];
  ownerConflicts: OwnerConflict[];
  owners: Record<string, string | null>;
  fallbackRouters: FallbackRouter[];
}

export type PollTrigger = 'startup' | 'interval' | 'event' | 'reconnect';

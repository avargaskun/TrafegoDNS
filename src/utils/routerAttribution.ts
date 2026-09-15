import { extractDnsLabels, getLabelValue } from './dns';
import type { LabelPrefixes } from '../../types/config';
import type { ContainerSummary, LabelMap } from '../../types/docker';
import type {
  AmbiguousRouter,
  CandidatePools,
  FallbackRouter,
  HostnameLabelsResult,
  HostnameRouters,
  OwnerConflict,
  OwnerReason,
  OwnerResult,
  ResolvedOwner,
  RouterRef
} from '../../types/traefik';

function normalizeTraefikName(name: string): string {
  return String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-');
}

function labelsOf(container: ContainerSummary): LabelMap {
  return container.labels || {};
}

function isCandidate(container: ContainerSummary, cfg: LabelPrefixes): boolean {
  return String(labelsOf(container)[`${cfg.traefikLabelPrefix}enable`]).toLowerCase() === 'true';
}

function isFallbackCandidate(container: ContainerSummary, cfg: LabelPrefixes): boolean {
  return labelsOf(container)[`${cfg.traefikLabelPrefix}enable`] === undefined;
}

function candidatePools(containers: ContainerSummary[], cfg: LabelPrefixes): CandidatePools {
  return {
    strict: containers.filter((c) => isCandidate(c, cfg)),
    fallback: containers.filter((c) => isFallbackCandidate(c, cfg))
  };
}

function hasLabelWithPrefix(container: ContainerSummary, prefix: string): boolean {
  const lowered = prefix.toLowerCase();
  return Object.keys(labelsOf(container)).some((key) => key.toLowerCase().startsWith(lowered));
}

function hasRouterLabels(container: ContainerSummary, routerBase: string, cfg: LabelPrefixes): boolean {
  return hasLabelWithPrefix(container, `${cfg.traefikLabelPrefix}http.routers.${routerBase}.`);
}

function hasAnyHttpRouterLabels(container: ContainerSummary, cfg: LabelPrefixes): boolean {
  return hasLabelWithPrefix(container, `${cfg.traefikLabelPrefix}http.routers.`);
}

// Traefik v3.7 pkg/provider/docker/shared.go:209-217: the default service (and router) is `<service>_<project>` for compose, else the container name, normalized.
function defaultRouterNames(container: ContainerSummary): string[] {
  const labels = labelsOf(container);
  const service = labels['com.docker.compose.service'];
  const project = labels['com.docker.compose.project'];
  const names: string[] = [];
  if (service && project) names.push(normalizeTraefikName(`${service}_${project}`));
  names.push(normalizeTraefikName(container.name));
  return names.map((name) => name.toLowerCase());
}

function dnsLabelsOf(container: ContainerSummary, cfg: LabelPrefixes): LabelMap {
  return extractDnsLabels(labelsOf(container), cfg.genericLabelPrefix, cfg.dnsLabelPrefix);
}

function sameLabelMap(a: LabelMap, b: LabelMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function allSameDnsLabels(containers: ContainerSummary[], cfg: LabelPrefixes): boolean {
  const first = dnsLabelsOf(containers[0], cfg);
  return containers.every((container) => sameLabelMap(first, dnsLabelsOf(container, cfg)));
}

function byName(a: ContainerSummary, b: ContainerSummary): number {
  return a.name.localeCompare(b.name);
}

function decide(owners: ContainerSummary[], reason: OwnerReason, cfg: LabelPrefixes): OwnerResult {
  const sorted = [...owners].sort(byName);
  if (allSameDnsLabels(sorted, cfg)) {
    return { owner: sorted[0], ambiguous: false, owners: sorted, reason };
  }
  return { owner: null, ambiguous: true, owners: sorted, reason };
}

function noOwner(reason: OwnerReason): OwnerResult {
  return { owner: null, ambiguous: false, owners: [], reason };
}

function findRouterOwner(ref: RouterRef, candidates: ContainerSummary[], cfg: LabelPrefixes): OwnerResult {
  const provider = ref.provider ?? String(ref.name).split('@')[1];
  if (provider !== 'docker') return noOwner('not-docker');

  const base = ref.name.replace(/@docker$/i, '');
  const labelOwners = candidates.filter((c) => hasRouterLabels(c, base, cfg));
  if (labelOwners.length > 0) return decide(labelOwners, 'router-labels', cfg);

  let stripped: string | null = null;
  const entryPoint = ref.entryPoints?.length === 1 ? ref.entryPoints[0] : null;
  // Traefik v3.7 pkg/server/aggregator.go:390-392: entrypoint-level HTTP defaults split a router into one `<entrypoint>-<router>` copy per entrypoint.
  if (entryPoint && base.toLowerCase().startsWith(`${entryPoint.toLowerCase()}-`)) {
    stripped = base.slice(entryPoint.length + 1);
    const splitOwners = candidates.filter((c) => hasRouterLabels(c, stripped!, cfg));
    if (splitOwners.length > 0) return decide(splitOwners, 'entrypoint-split', cfg);
  }

  const names = [base, stripped].filter(Boolean).map((name) => name!.toLowerCase());
  const defaultOwners = candidates.filter(
    (c) => !hasAnyHttpRouterLabels(c, cfg) && defaultRouterNames(c).some((name) => names.includes(name))
  );
  if (defaultOwners.length > 0) return decide(defaultOwners, 'default-router', cfg);

  return noOwner('no-owner');
}

// The strict pass runs to completion first, so a later strict step still beats an earlier fallback step.
function resolveRouterOwner(ref: RouterRef, pools: CandidatePools, cfg: LabelPrefixes): ResolvedOwner {
  const strict = findRouterOwner(ref, pools.strict, cfg);
  if (strict.owner || strict.ambiguous) return { ...strict, via: 'strict' };
  const fallback = findRouterOwner(ref, pools.fallback, cfg);
  if (fallback.owner || fallback.ambiguous) return { ...fallback, via: 'fallback' };
  return { ...strict, via: null };
}

function resolveHostnameLabels(hostnameRouters: HostnameRouters, containers: ContainerSummary[], cfg: LabelPrefixes): HostnameLabelsResult {
  const { traefikLabelPrefix: tp, genericLabelPrefix: gp, dnsLabelPrefix: pp } = cfg;
  const pools = candidatePools(containers, cfg);
  const entries = hostnameRouters instanceof Map ? [...hostnameRouters] : Object.entries(hostnameRouters);

  const routerResults = new Map<string, ResolvedOwner>();
  const ownerOf = (ref: RouterRef): ResolvedOwner => {
    if (!routerResults.has(ref.name)) routerResults.set(ref.name, resolveRouterOwner(ref, pools, cfg));
    return routerResults.get(ref.name)!;
  };
  const strictFirst = (a: ContainerSummary, b: ContainerSummary) => Number(!isCandidate(a, cfg)) - Number(!isCandidate(b, cfg)) || byName(a, b);

  const containerLabels: Record<string, LabelMap> = {};
  const excludedHostnames = new Set<string>();
  const ambiguousRouters: AmbiguousRouter[] = [];
  const reportedRouters = new Set<string>();
  const fallbackRouters: FallbackRouter[] = [];
  const seenFallbackRouters = new Set<string>();
  const ownerConflicts: OwnerConflict[] = [];
  const owners: Record<string, string | null> = {};

  for (const [hostname, refs] of entries) {
    const results = refs.map(ownerOf);
    for (const [i, ref] of refs.entries()) {
      const { via, owner } = results[i];
      if (via !== 'fallback' || !owner || seenFallbackRouters.has(ref.name)) continue;
      seenFallbackRouters.add(ref.name);
      if (Object.keys(dnsLabelsOf(owner, cfg)).length > 0) fallbackRouters.push({ routerName: ref.name, ownerName: owner.name });
    }
    const ambiguousRefs = refs.filter((_ref, i) => results[i].ambiguous);
    if (ambiguousRefs.length > 0) {
      excludedHostnames.add(hostname);
      for (const ref of ambiguousRefs) {
        if (reportedRouters.has(ref.name)) continue;
        reportedRouters.add(ref.name);
        ambiguousRouters.push({ routerName: ref.name, ownerNames: ownerOf(ref).owners.map((o) => o.name) });
      }
      continue;
    }

    const hostOwners = [...new Set(results.map((r) => r.owner).filter(Boolean) as ContainerSummary[])].sort(strictFirst);
    const skipOwner = hostOwners.find((o) => getLabelValue(labelsOf(o), gp, pp, 'skip', null) === 'true');
    const managers = hostOwners.filter((o) => getLabelValue(labelsOf(o), gp, pp, 'manage', null) === 'true');
    const chosen = skipOwner ?? managers[0] ?? hostOwners[0] ?? null;

    if (!skipOwner && managers.length > 1 && !allSameDnsLabels(managers, cfg)) {
      ownerConflicts.push({ hostname, ownerNames: managers.map((o) => o.name), chosen: managers[0].name });
    }

    containerLabels[hostname] = {
      [`${tp}http.routers.${refs[0].name}.service`]: refs[0].service,
      routerName: refs[0].name,
      ...(chosen ? dnsLabelsOf(chosen, cfg) : {})
    };
    owners[hostname] = chosen ? chosen.name : null;
  }

  return { containerLabels, excludedHostnames, ambiguousRouters, ownerConflicts, owners, fallbackRouters };
}

export {
  normalizeTraefikName,
  isCandidate,
  isFallbackCandidate,
  candidatePools,
  hasRouterLabels,
  hasAnyHttpRouterLabels,
  defaultRouterNames,
  findRouterOwner,
  resolveRouterOwner,
  resolveHostnameLabels
};

// @ts-nocheck
import { extractDnsLabels, getLabelValue } from './dns';

function normalizeTraefikName(name) {
  return String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean).join('-');
}

function labelsOf(container) {
  return container.labels || {};
}

function isCandidate(container, cfg) {
  return String(labelsOf(container)[`${cfg.traefikLabelPrefix}enable`]).toLowerCase() === 'true';
}

function isFallbackCandidate(container, cfg) {
  return labelsOf(container)[`${cfg.traefikLabelPrefix}enable`] === undefined;
}

function candidatePools(containers, cfg) {
  return {
    strict: containers.filter((c) => isCandidate(c, cfg)),
    fallback: containers.filter((c) => isFallbackCandidate(c, cfg))
  };
}

function hasLabelWithPrefix(container, prefix) {
  const lowered = prefix.toLowerCase();
  return Object.keys(labelsOf(container)).some((key) => key.toLowerCase().startsWith(lowered));
}

function hasRouterLabels(container, routerBase, cfg) {
  return hasLabelWithPrefix(container, `${cfg.traefikLabelPrefix}http.routers.${routerBase}.`);
}

function hasAnyHttpRouterLabels(container, cfg) {
  return hasLabelWithPrefix(container, `${cfg.traefikLabelPrefix}http.routers.`);
}

// Traefik v3.7 pkg/provider/docker/shared.go:209-217: the default service (and router) is `<service>_<project>` for compose, else the container name, normalized.
function defaultRouterNames(container) {
  const labels = labelsOf(container);
  const service = labels['com.docker.compose.service'];
  const project = labels['com.docker.compose.project'];
  const names = [];
  if (service && project) names.push(normalizeTraefikName(`${service}_${project}`));
  names.push(normalizeTraefikName(container.name));
  return names.map((name) => name.toLowerCase());
}

function dnsLabelsOf(container, cfg) {
  return extractDnsLabels(labelsOf(container), cfg.genericLabelPrefix, cfg.dnsLabelPrefix);
}

function sameLabelMap(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function allSameDnsLabels(containers, cfg) {
  const first = dnsLabelsOf(containers[0], cfg);
  return containers.every((container) => sameLabelMap(first, dnsLabelsOf(container, cfg)));
}

function byName(a, b) {
  return a.name.localeCompare(b.name);
}

function decide(owners, reason, cfg) {
  const sorted = [...owners].sort(byName);
  if (allSameDnsLabels(sorted, cfg)) {
    return { owner: sorted[0], ambiguous: false, owners: sorted, reason };
  }
  return { owner: null, ambiguous: true, owners: sorted, reason };
}

function noOwner(reason) {
  return { owner: null, ambiguous: false, owners: [], reason };
}

function findRouterOwner(ref, candidates, cfg) {
  const provider = ref.provider ?? String(ref.name).split('@')[1];
  if (provider !== 'docker') return noOwner('not-docker');

  const base = ref.name.replace(/@docker$/i, '');
  const labelOwners = candidates.filter((c) => hasRouterLabels(c, base, cfg));
  if (labelOwners.length > 0) return decide(labelOwners, 'router-labels', cfg);

  let stripped = null;
  const entryPoint = ref.entryPoints?.length === 1 ? ref.entryPoints[0] : null;
  // Traefik v3.7 pkg/server/aggregator.go:390-392: entrypoint-level HTTP defaults split a router into one `<entrypoint>-<router>` copy per entrypoint.
  if (entryPoint && base.toLowerCase().startsWith(`${entryPoint.toLowerCase()}-`)) {
    stripped = base.slice(entryPoint.length + 1);
    const splitOwners = candidates.filter((c) => hasRouterLabels(c, stripped, cfg));
    if (splitOwners.length > 0) return decide(splitOwners, 'entrypoint-split', cfg);
  }

  const names = [base, stripped].filter(Boolean).map((name) => name.toLowerCase());
  const defaultOwners = candidates.filter(
    (c) => !hasAnyHttpRouterLabels(c, cfg) && defaultRouterNames(c).some((name) => names.includes(name))
  );
  if (defaultOwners.length > 0) return decide(defaultOwners, 'default-router', cfg);

  return noOwner('no-owner');
}

// The strict pass runs to completion first, so a later strict step still beats an earlier fallback step.
function resolveRouterOwner(ref, pools, cfg) {
  const strict = findRouterOwner(ref, pools.strict, cfg);
  if (strict.owner || strict.ambiguous) return { ...strict, via: 'strict' };
  const fallback = findRouterOwner(ref, pools.fallback, cfg);
  if (fallback.owner || fallback.ambiguous) return { ...fallback, via: 'fallback' };
  return { ...strict, via: null };
}

function resolveHostnameLabels(hostnameRouters, containers, cfg) {
  const { traefikLabelPrefix: tp, genericLabelPrefix: gp, dnsLabelPrefix: pp } = cfg;
  const pools = candidatePools(containers, cfg);
  const entries = hostnameRouters instanceof Map ? [...hostnameRouters] : Object.entries(hostnameRouters);

  const routerResults = new Map();
  const ownerOf = (ref) => {
    if (!routerResults.has(ref.name)) routerResults.set(ref.name, resolveRouterOwner(ref, pools, cfg));
    return routerResults.get(ref.name);
  };
  const strictFirst = (a, b) => Number(!isCandidate(a, cfg)) - Number(!isCandidate(b, cfg)) || byName(a, b);

  const containerLabels = {};
  const excludedHostnames = new Set();
  const ambiguousRouters = [];
  const reportedRouters = new Set();
  const fallbackRouters = [];
  const seenFallbackRouters = new Set();
  const ownerConflicts = [];
  const owners = {};

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

    const hostOwners = [...new Set(results.map((r) => r.owner).filter(Boolean))].sort(strictFirst);
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

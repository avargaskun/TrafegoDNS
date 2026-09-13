const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTraefikName,
  isCandidate,
  hasRouterLabels,
  hasAnyHttpRouterLabels,
  defaultRouterNames,
  findRouterOwner,
  resolveHostnameLabels
} = require('../../src/utils/routerAttribution');
const { extractDnsLabels, getLabelValue } = require('../../src/utils/dns');
const { extractHostnamesFromRule } = require('../../src/utils/traefik');
const { makeConfig } = require('../helpers/config');
const golden = require('../fixtures/goldenAttribution');

const cfg = makeConfig();

function toContainer(c) {
  return { id: c.Id, name: c.Names[0].replace(/^\//, ''), labels: c.Labels };
}

function toRef(router) {
  return { name: router.name, provider: router.provider, entryPoints: router.entryPoints, service: router.service };
}

function buildHostnameRouters(routers) {
  const hostnameRouters = new Map();
  for (const router of routers) {
    if (!router.rule || !router.rule.includes('Host')) continue;
    for (const hostname of new Set(extractHostnamesFromRule(router.rule))) {
      if (!hostnameRouters.has(hostname)) hostnameRouters.set(hostname, []);
      hostnameRouters.get(hostname).push(toRef(router));
    }
  }
  return hostnameRouters;
}

function managedHostnames(hostnameRouters, result) {
  const managed = [];
  for (const hostname of hostnameRouters.keys()) {
    if (result.excludedHostnames.has(hostname)) continue;
    const labels = result.containerLabels[hostname] || {};
    const manage = getLabelValue(labels, cfg.genericLabelPrefix, cfg.dnsLabelPrefix, 'manage', null) === 'true';
    const skip = getLabelValue(labels, cfg.genericLabelPrefix, cfg.dnsLabelPrefix, 'skip', null) === 'true';
    if (manage && !skip) managed.push(hostname);
  }
  return managed.sort();
}

function container(name, labels) {
  return { id: `${name}-id`, name, labels };
}

function dockerRef(name, entryPoints = ['https']) {
  return { name, provider: 'docker', entryPoints, service: name.replace(/@docker$/, '') };
}

const goldenContainers = golden.containers.map(toContainer);
const goldenCandidates = goldenContainers.filter((c) => isCandidate(c, cfg));

test('extractDnsLabels returns provider-specific keys first, then generic keys outside the provider prefix', () => {
  const labels = {
    'dns.manage': 'true',
    'traefik.enable': 'true',
    'dns.cloudflare.proxied': 'false',
    'dns.type': 'A'
  };
  const result = extractDnsLabels(labels, cfg.genericLabelPrefix, cfg.dnsLabelPrefix);
  assert.deepEqual(Object.keys(result), ['dns.cloudflare.proxied', 'dns.manage', 'dns.type']);
  assert.deepEqual(result, { 'dns.cloudflare.proxied': 'false', 'dns.manage': 'true', 'dns.type': 'A' });
  assert.notEqual(result, labels);
  assert.deepEqual(extractDnsLabels(undefined, cfg.genericLabelPrefix, cfg.dnsLabelPrefix), {});
});

test('golden set: findRouterOwner attributes every router exactly', () => {
  assert.deepEqual(Object.keys(golden.expectedOwners).sort(), golden.routers.map((r) => r.name).sort());
  for (const router of golden.routers) {
    const result = findRouterOwner(toRef(router), goldenCandidates, cfg);
    assert.equal(result.owner ? result.owner.name : null, golden.expectedOwners[router.name], `owner of ${router.name}`);
    assert.equal(result.ambiguous, golden.expectedAmbiguousRouters.includes(router.name), `ambiguity of ${router.name}`);
  }
  const shared = findRouterOwner(toRef(golden.routers.find((r) => r.name === 'shared@docker')), goldenCandidates, cfg);
  assert.deepEqual(shared.owners.map((o) => o.name), ['left', 'right']);
});

test('golden set: attribution uses the documented step for each owner', () => {
  const reasonOf = (name) => findRouterOwner(toRef(golden.routers.find((r) => r.name === name)), goldenCandidates, cfg).reason;
  assert.equal(reasonOf('app@docker'), 'router-labels');
  assert.equal(reasonOf('blog-admin@docker'), 'router-labels');
  assert.equal(reasonOf('https-foo@docker'), 'entrypoint-split');
  assert.equal(reasonOf('plain-stack@docker'), 'default-router');
  assert.equal(reasonOf('files@file'), 'not-docker');
});

test('golden set: resolveHostnameLabels excludes the ambiguous hostname once and yields the managed set', () => {
  const hostnameRouters = buildHostnameRouters(golden.routers);
  const result = resolveHostnameLabels(hostnameRouters, goldenContainers, cfg);

  assert.deepEqual([...result.excludedHostnames], golden.expectedExcludedHostnames);
  assert.deepEqual(result.ambiguousRouters.map((r) => r.routerName), golden.expectedAmbiguousRouters);
  assert.deepEqual(result.ambiguousRouters[0].ownerNames, ['left', 'right']);
  assert.deepEqual(result.ownerConflicts, []);
  assert.deepEqual(managedHostnames(hostnameRouters, result), golden.expectedManagedHostnames);

  assert.deepEqual(result.containerLabels['app.example.com'], {
    'traefik.http.routers.app@docker.service': 'app',
    routerName: 'app@docker',
    'dns.manage': 'true'
  });
  assert.deepEqual(result.containerLabels['files.example.com'], {
    'traefik.http.routers.internal-api@file.service': 'internal-api',
    routerName: 'internal-api@file'
  });
  assert.equal(result.owners['traefik.example.com'], 'proxy');
  assert.equal(result.owners['cafe.example.com'], 'cafe');
  assert.equal(result.owners['files.example.com'], null);
  assert.equal(result.owners['static-a.example.com'], 'static');
  assert.equal(Object.hasOwn(result.containerLabels, 'shared.example.com'), false);
});

test('resolveHostnameLabels accepts an ordered object as well as a Map', () => {
  const hostnameRouters = Object.fromEntries(buildHostnameRouters(golden.routers));
  const result = resolveHostnameLabels(hostnameRouters, goldenContainers, cfg);
  assert.deepEqual([...result.excludedHostnames], golden.expectedExcludedHostnames);
  assert.equal(result.owners['app-speed.example.com'], 'app');
});

test('normalizeTraefikName follows Traefik provider.Normalize and keeps Unicode letters', () => {
  assert.equal(normalizeTraefikName('plain_stack'), 'plain-stack');
  assert.equal(normalizeTraefikName('café_ünï'), 'café-ünï');
  assert.equal(normalizeTraefikName('__a..b--c__'), 'a-b-c');
  assert.equal(normalizeTraefikName('web2'), 'web2');
});

test('defaultRouterNames lists the compose service name, then the container name, lowercased', () => {
  const compose = container('Stack_Plain_1', { 'com.docker.compose.service': 'Plain', 'com.docker.compose.project': 'stack' });
  assert.deepEqual(defaultRouterNames(compose), ['plain-stack', 'stack-plain-1']);
  assert.deepEqual(defaultRouterNames(container('solo', {})), ['solo']);
});

test('scaled replicas with identical DNS labels are not ambiguous and the first by name wins', () => {
  const labels = { 'traefik.enable': 'true', 'traefik.http.routers.web.rule': 'Host(`web.example.com`)', 'dns.manage': 'true' };
  const replicas = [container('web-2', { ...labels }), container('web-1', { ...labels })];
  const result = findRouterOwner(dockerRef('web@docker'), replicas, cfg);
  assert.equal(result.ambiguous, false);
  assert.equal(result.owner.name, 'web-1');
  assert.deepEqual(result.owners.map((o) => o.name), ['web-1', 'web-2']);

  const resolved = resolveHostnameLabels(new Map([['web.example.com', [dockerRef('web@docker')]]]), replicas, cfg);
  assert.equal(resolved.excludedHostnames.size, 0);
  assert.equal(resolved.owners['web.example.com'], 'web-1');
});

test('a container with router labels but without traefik.enable=true never owns a router', () => {
  const routerLabels = { 'traefik.http.routers.solo.rule': 'Host(`solo.example.com`)', 'dns.manage': 'true' };
  const noEnable = container('solo', { ...routerLabels });
  const disabled = container('solo', { ...routerLabels, 'traefik.enable': 'false' });
  const upperCase = container('solo', { ...routerLabels, 'traefik.enable': 'TRUE' });

  assert.equal(isCandidate(noEnable, cfg), false);
  assert.equal(isCandidate(disabled, cfg), false);
  assert.equal(isCandidate(upperCase, cfg), true);

  const hostnameRouters = new Map([['solo.example.com', [dockerRef('solo@docker')]]]);
  for (const c of [noEnable, disabled]) {
    const result = resolveHostnameLabels(hostnameRouters, [c], cfg);
    assert.equal(result.owners['solo.example.com'], null);
    assert.deepEqual(result.containerLabels['solo.example.com'], {
      'traefik.http.routers.solo@docker.service': 'solo',
      routerName: 'solo@docker'
    });
  }
});

test('@file and @internal routers have no owner, even when a container carries matching labels', () => {
  const lookalike = container('files', {
    'traefik.enable': 'true',
    'traefik.http.routers.files.rule': 'Host(`files.example.com`)',
    'traefik.http.routers.dashboard.rule': 'Host(`dashboard.example.com`)',
    'dns.manage': 'true'
  });
  const fileRef = { name: 'files@file', provider: 'file', entryPoints: ['https'], service: 'files' };
  const internalRef = { name: 'dashboard@internal', provider: 'internal', entryPoints: ['https'], service: 'dashboard@internal' };
  const unnamedProviderRef = { name: 'files@file', entryPoints: ['https'], service: 'files' };

  for (const ref of [fileRef, internalRef, unnamedProviderRef]) {
    const result = findRouterOwner(ref, [lookalike], cfg);
    assert.equal(result.owner, null, ref.name);
    assert.equal(result.ambiguous, false, ref.name);
  }
  const fromName = findRouterOwner({ name: 'files@docker', entryPoints: ['https'], service: 'files' }, [lookalike], cfg);
  assert.equal(fromName.owner.name, 'files');
});

test('router base matching is case-insensitive', () => {
  const app = container('app', { 'traefik.enable': 'true', 'traefik.http.routers.app.rule': 'Host(`app.example.com`)' });
  assert.equal(findRouterOwner(dockerRef('App@docker'), [app], cfg).owner.name, 'app');
  assert.equal(findRouterOwner(dockerRef('app@DOCKER'), [app], cfg).owner.name, 'app');

  const mixed = container('mixed', { 'traefik.enable': 'true', 'traefik.http.routers.MyApp.rule': 'Host(`myapp.example.com`)' });
  assert.equal(hasRouterLabels(mixed, 'myapp', cfg), true);
  assert.equal(findRouterOwner(dockerRef('myapp@docker'), [mixed], cfg).owner.name, 'mixed');
});

test('router base matching is exact, never a substring or a container id', () => {
  const appSpeed = container('app-speed', { 'traefik.enable': 'true', 'traefik.http.routers.app-speed.rule': 'Host(`a.example.com`)' });
  const byId = { id: 'app'.padEnd(64, '0'), name: 'unrelated', labels: { 'traefik.enable': 'true' } };
  assert.equal(hasRouterLabels(appSpeed, 'app', cfg), false);
  assert.equal(findRouterOwner(dockerRef('app@docker'), [appSpeed, byId], cfg).owner, null);
});

test('the entrypoint split applies only to single-entrypoint routers whose own labels are missing', () => {
  const foo = container('foo', { 'traefik.enable': 'true', 'traefik.http.routers.foo.rule': 'Host(`foo.example.com`)' });
  assert.equal(findRouterOwner(dockerRef('https-foo@docker', ['https']), [foo], cfg).owner.name, 'foo');
  assert.equal(findRouterOwner(dockerRef('https-foo@docker', ['http', 'https']), [foo], cfg).owner, null);
  assert.equal(findRouterOwner(dockerRef('https-foo@docker', ['web']), [foo], cfg).owner, null);

  const splitDefault = container('bar', { 'traefik.enable': 'true' });
  const result = findRouterOwner(dockerRef('https-bar@docker', ['https']), [splitDefault], cfg);
  assert.equal(result.owner.name, 'bar');
  assert.equal(result.reason, 'default-router');
});

test('the default router never goes to a container that defines its own HTTP routers', () => {
  const svc = container('svc', { 'traefik.enable': 'true', 'traefik.http.routers.other.rule': 'Host(`other.example.com`)' });
  assert.equal(hasAnyHttpRouterLabels(svc, cfg), true);
  assert.equal(findRouterOwner(dockerRef('svc@docker'), [svc], cfg).owner, null);
});

test('an ambiguous router with several hostnames is reported once and excludes all its hostnames', () => {
  const rule = 'Host(`one.example.com`) || Host(`two.example.com`)';
  const a = container('a', { 'traefik.enable': 'true', 'traefik.http.routers.multi.rule': rule, 'dns.manage': 'true' });
  const b = container('b', { 'traefik.enable': 'true', 'traefik.http.routers.multi.rule': rule, 'dns.proxied': 'false' });
  const other = container('other', { 'traefik.enable': 'true', 'traefik.http.routers.other.rule': 'Host(`two.example.com`)', 'dns.manage': 'true' });
  const hostnameRouters = new Map([
    ['one.example.com', [dockerRef('multi@docker')]],
    ['two.example.com', [dockerRef('multi@docker'), dockerRef('other@docker')]]
  ]);
  const result = resolveHostnameLabels(hostnameRouters, [a, b, other], cfg);
  assert.deepEqual([...result.excludedHostnames], ['one.example.com', 'two.example.com']);
  assert.deepEqual(result.ambiguousRouters, [{ routerName: 'multi@docker', ownerNames: ['a', 'b'] }]);
  assert.deepEqual(result.containerLabels, {});
});

test('two managers with different DNS labels on one hostname are an owner conflict resolved to the first by name', () => {
  const zeta = container('zeta', {
    'traefik.enable': 'true',
    'traefik.http.routers.z.rule': 'Host(`conflict.example.com`)',
    'dns.manage': 'true',
    'dns.content': 'zeta.example.com'
  });
  const alpha = container('alpha', {
    'traefik.enable': 'true',
    'traefik.http.routers.a.rule': 'Host(`conflict.example.com`)',
    'dns.manage': 'true',
    'dns.content': 'alpha.example.com'
  });
  const hostnameRouters = new Map([['conflict.example.com', [dockerRef('z@docker'), dockerRef('a@docker')]]]);
  const result = resolveHostnameLabels(hostnameRouters, [zeta, alpha], cfg);

  assert.deepEqual(result.ownerConflicts, [
    { hostname: 'conflict.example.com', ownerNames: ['alpha', 'zeta'], chosen: 'alpha' }
  ]);
  assert.equal(result.excludedHostnames.size, 0);
  assert.equal(result.owners['conflict.example.com'], 'alpha');
  assert.deepEqual(result.containerLabels['conflict.example.com'], {
    'traefik.http.routers.z@docker.service': 'z',
    routerName: 'z@docker',
    'dns.manage': 'true',
    'dns.content': 'alpha.example.com'
  });
});

test('a skip owner wins over managers on a shared hostname and raises no conflict', () => {
  const manager = container('manager', { 'traefik.enable': 'true', 'traefik.http.routers.m.rule': 'Host(`s.example.com`)', 'dns.manage': 'true' });
  const skipper = container('skipper', { 'traefik.enable': 'true', 'traefik.http.routers.s.rule': 'Host(`s.example.com`)', 'dns.cloudflare.skip': 'true' });
  const hostnameRouters = new Map([['s.example.com', [dockerRef('m@docker'), dockerRef('s@docker')]]]);
  const result = resolveHostnameLabels(hostnameRouters, [manager, skipper], cfg);
  assert.equal(result.owners['s.example.com'], 'skipper');
  assert.deepEqual(result.ownerConflicts, []);
  assert.equal(result.containerLabels['s.example.com']['dns.cloudflare.skip'], 'true');
});

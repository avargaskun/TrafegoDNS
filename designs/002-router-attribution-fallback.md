# 002: Router Attribution Fallback for Containers Without `traefik.enable`

> **Status:** Implemented. Released as `1.10.3`.
> **Date:** 2026-09-13
> **Issue:** #9 (follow-up to #3; see [001](001-docker-29-events-and-release-please.md) §7.6)
> **PRs:** #14 (code fix), #15 (release `1.10.3`)

---

## 1. Goal

Restore `dns.*` overrides for containers that carry router labels but **no** `traefik.enable` label, without changing the owner of any router that a `traefik.enable=true` container owns.

## 2. Problem

`1.10.1` (001 §7.6) made router attribution strict: only a running container with `traefik.enable=true` could own a Traefik router. That is the common case to get wrong under Traefik's default `exposedByDefault=true`. A container with DNS and router labels but no `traefik.enable` lost **all** its DNS overrides, not just its manage/skip decision. Its hostnames were published with only `{ <service key>, routerName }`.

| Configuration | Effect in `1.10.1`/`1.10.2` |
|---|---|
| `DNS_DEFAULT_MANAGE=false` | The hostname became unmanaged, and its record stopped updating. |
| `DNS_DEFAULT_MANAGE=false` + `CLEANUP_ORPHANED=true` | The record was marked orphaned and deleted after `CLEANUP_GRACE_PERIOD`. |
| `DNS_DEFAULT_MANAGE=true` | The hostname was managed with type defaults. For example, a `dns.proxied=false` record was rewritten to proxied. |

Nothing was logged. In `1.10.0` the old substring matcher credited routers to such containers regardless of `traefik.enable`, so the upgrade silently changed behaviour.

## 3. Scope

- **In scope:** `src/utils/routerAttribution.js`, `src/services/TraefikMonitor.js`, and their tests. The PR touched only `src/**` and `test/**`.
- **Out of scope, and unchanged:**
  - DNSManager: the manage/skip logic, `cleanupOrphanedRecords` and its call site, and `CLEANUP_ORPHANED`'s default;
  - DockerMonitor;
  - direct mode;
  - config and env vars;
  - README.

## 4. Design

### 4.1 Candidate pools

Each running container falls into exactly one class, based on the raw value of `labels['<tp>enable']` (`<tp>` = `TRAEFIK_LABEL_PREFIX`, `traefik.` by default):

| `labels['<tp>enable']` | Class | Owns routers |
|---|---|---|
| `'true'`, any case | **strict** (`isCandidate`, unchanged) | In the strict pass |
| key absent | **fallback** (`isFallbackCandidate`) | Only for routers that have no strict owner and no strict ambiguity |
| anything else (`'false'`, `''`, `'1'`, `'yes'`, …) | **never** | Never |

`candidatePools(containers, cfg)` returns disjoint `{ strict, fallback }` pools. The enable-key lookup stays exact-case, the same as `isCandidate`.

### 4.2 Two-pass router lookup

```js
function resolveRouterOwner(ref, pools, cfg) {
  const strict = findRouterOwner(ref, pools.strict, cfg);
  if (strict.owner || strict.ambiguous) return { ...strict, via: 'strict' };
  const fallback = findRouterOwner(ref, pools.fallback, cfg);
  if (fallback.owner || fallback.ambiguous) return { ...fallback, via: 'fallback' };
  return { ...strict, via: null };
}
```

- **The strict pass runs to completion first.** An enabled container that owns a router through a *later* step, such as the Traefik default router, still beats an unlabelled container carrying stale router labels for the same name.
- **Strict ambiguity is final.** Enabled containers that disagree are a configuration conflict; the fallback never breaks the tie.
- **`findRouterOwner` is unmodified.** The fallback pass is the same function on a different pool: router labels, the per-entrypoint split, the default router, and the `decide()` rules. So several fallback owners with different DNS labels make the router ambiguous (hostnames excluded, WARN logged), and replicas with identical labels do not.

### 4.3 Hostname merge: strict owners rank first

`resolveHostnameLabels` sorts each hostname's owners strict-first, then by name. The existing rules then pick one owner: any `skip` owner wins, then the first `manage` owner, then the first owner. Without the strict-first order, name order alone could let a label-less fallback owner displace an enabled owner's overrides:

```yaml
web:  traefik.enable=true, routers.web.rule=Host(`shop.example.com`), dns.proxied=false
api:  (no enable label),   routers.api.rule=Host(`shop.example.com`) && PathPrefix(`/api`)
```

Sorted by name, `api` would be chosen and the record rewritten to proxied. Sorted strict-first, `web` is chosen. A fallback owner still wins by setting `dns.manage` or `dns.skip` explicitly. For every hostname whose owners are all strict, the output is byte-identical to `1.10.2`.

### 4.4 Visibility

`resolveHostnameLabels` returns a new `fallbackRouters` list of `{ routerName, ownerName }`. It holds only fallback owners that carry at least one `dns.*` label; a label-less fallback owner changes no DNS output. `TraefikMonitor.reportFallbackRouters` logs this line at INFO:

```
Router <router> attributed to container <container> (no traefik.enable label)
```

- The line is logged once per router and owner pair, and forgotten when the router is no longer fallback-owned.
- It is logged again if the situation returns or the owner changes.
- A poll that is skipped or fails leaves this state untouched.

## 5. Upgrade behaviour (`1.10.2` → `1.10.3`)

| Container shape | `1.10.2` | `1.10.3` |
|---|---|---|
| `traefik.enable=true` | Strict owner | Unchanged |
| `traefik.enable=false` | Never an owner | Unchanged |
| No `enable` label, router labels plus `dns.*`, no enabled claimant | No owner, `dns.*` dropped | Fallback owner, `dns.*` applied, one INFO line |
| No `enable` label, same router claimed by an enabled container | Not an owner | Not an owner |
| No `enable` label, no router labels, name matches an unowned default router | No owner | Fallback owner |
| No `enable` label, two such containers claim one router with different `dns.*` labels | Managed with defaults, or with an enabled co-owner's labels | Hostnames excluded and a WARN logged, the same rule enabled containers follow |
| `traefik.enable=1` / `yes` / `t` | Never an owner | Unchanged |

No migration is needed. With `CLEANUP_ORPHANED=true`, orphan-marked records are unmarked when their hostname is managed again, and records that were already deleted are recreated.

## 6. Decisions and rejected alternatives

| Decision | Why | Rejected |
|---|---|---|
| Strict pass, then fallback, per router | Enabled containers keep every router they own in `1.10.2`. Stale labels on unlabelled containers cannot cause false ambiguity. | One merged pool (`enable !== 'false'`), or a merged pool preferring strict within each step |
| Fallback never resolves strict ambiguity | It would hide a real configuration conflict. | Letting an unlabelled container break the tie |
| Strict-first hostname ranking | Without it, a label-less fallback owner could rewrite an enabled owner's overrides because of name order alone. | Name-only order |
| INFO only for fallback owners with `dns.*` | These are the only fallback owners that change DNS output. Under `exposedByDefault=true` with a `defaultRule`, logging all of them would print one line per unlabelled container at every start. | Logging every fallback router |
| Any explicit `enable` value other than `true` is in neither pool | This was the maintainer's rule, and it keeps `enable=false` absolute. | Parsing `1`/`t`/`yes` the way Traefik's `ParseBool` does |
| No new env var | The fallback is the chosen default behaviour. | A toggle |

## 7. Tests

- **Suite:** `node:test`, with 113 → 130 tests; CI runs Node 23.11.1.
- **Unit (`test/unit/routerAttribution.test.js`):**
  - the pool predicate and pool disjointness;
  - fallback ownership through router labels, the entrypoint split, and the default router;
  - an enabled claimant beats the fallback;
  - the strict pass finishes first, including its default-router step;
  - strict ambiguity is final;
  - `enable=false` never owns;
  - fallback ambiguity and replicas;
  - strict-first hostname ranking;
  - fallback `skip` and fallback ambiguity on an enabled-owned hostname;
  - `fallbackRouters` scope;
  - non-docker routers.
- **Unit (`test/unit/traefikMonitor.test.js`):** the INFO line's lifecycle, including owner changes and skipped or failed polls.
- **Golden set:** it gains `legacy` (no `enable`, `dns.proxied=false`, owned through the fallback and created with `proxied=false` end to end) and `disabled` (`enable=false`, never owned). The managed set grows from 13 to 14, and every other golden expectation is unchanged.
- **Mutation checks:** 10 mutations, all caught:
  - drop the fallback;
  - admit `enable=false`;
  - run the fallback before strict;
  - merge the pools, strict-preferred per step;
  - let the fallback resolve strict ambiguity;
  - sort hostname owners by name only;
  - key the INFO line by router only;
  - ignore a fallback `skip` next to an enabled owner;
  - ignore fallback ambiguity next to an enabled owner;
  - reset the INFO state on a skipped or failed poll.

## 8. Known limitations

- **`traefik.enable=1` / `t` / `yes`.** Traefik treats these as enabled, but they are in neither pool, so such a container owns nothing. Its router also has no strict owner, so an unlabelled container that carries the same router labels (stale or copied) can own it through the fallback. This is rare. Using `traefik.enable=true` avoids both problems.
- **Exact-case enable key.** A key spelled `Traefik.Enable` counts as absent.

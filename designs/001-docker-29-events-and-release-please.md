# 001: Docker 29 Event Handling and release-please Adoption

> **Status:** Implemented. Released as `1.10.1`, with review follow-ups in `1.10.2`.
> **Date:** 2026-09-13
> **Issue:** #3
> **PRs:** #4 (CI/release), #5 (lockfile parity), #6 (in-range security updates), #7 (code fix), #8 (release `1.10.1`), #10 (CI hardening), #11 (review follow-ups), #12 (release `1.10.2`)
> **Follow-up:** #9 (router attribution fallback for containers without `traefik.enable`)

---

## 1. Goal

1. **Fix Docker Engine 29+ event handling.** Take `OPERATION_MODE=traefik` with `DNS_DEFAULT_MANAGE=false`: a container that starts after TráfegoDNS must get its DNS record within seconds. Before this fix it never did until a restart. The fix also has to:
   - survive socket-proxy and daemon restarts;
   - attribute each router to the right container;
   - never crash, or leak credentials, on a transient API failure.
2. **Give the fork a real release process.** release-please on `dev` publishes semver images to GHCR (`ghcr.io/avargaskun/trafegodns`). Release PRs auto-merge, and no one has to click anything.

## 2. Root cause and co-defects

**Root cause.** Docker Engine API 1.52 (Docker 29) no longer sends the deprecated `status`, `id` and `from` fields on `GET /events`. dockerode never pins or negotiates an API version, so every event arrived in the new shape. `DockerMonitor` filtered on `event.status`, so it dropped every container event without logging anything. In traefik mode, nothing else refreshed the Docker label cache that decides `dns.manage`.

**Co-defects fixed in the same change:**

| # | Defect |
|---|---|
| 1 | When the `/events` stream ended, it neither reconnected nor resynced. A parser error on a partial object crashed the process. |
| 2 | HAProxy socket proxies cut an idle `/events` stream at 600 s. The daemon's replay buffer covers only about 30 s, so a reconnect must re-list containers. |
| 3 | Routers were attributed to containers by substring match, so router `app` could be credited to `app-exporter`. |
| 4 | Unhandled async rejections exited the process and printed `AxiosError` objects, request headers included (`Authorization: Bearer …`). |
| 5 | Traefik routers after page 1 (100) and Cloudflare records after page 1 (100) were ignored. |
| 6 | At `LOG_LEVEL=INFO` the event path was invisible, and the s6 `finish` script always reported exit status 0. |
| 7 | The image build ignored the committed lockfile. |
| 8 | There was no release process, only the manual version-bump and Docker Hub workflows inherited from upstream. |

## 3. Scope

**In scope:**
- CI/release (PR #4);
- build reproducibility (#5, #6);
- the code fix and a first test suite (#7);
- release verification;
- review follow-ups (#10, #11).

**Out of scope:**
- **Orphan cleanup and record deletion.** `CLEANUP_ORPHANED` keeps its default (false), and `DNSManager.cleanupOrphanedRecords` and its call site stay byte-for-byte unchanged.
- **Upstream code.** Upstream v1.11/v2 code, and anything on `elmerfds/TrafegoDNS`.
- **Base image and build inputs.** Bumping the Node base image, and pinning `apk`/s6 inputs.
- **Record tracker.** Its default path, file name and schema.
- **Dependency upgrades** beyond lockfile parity and in-range audit fixes.
- **README/docs.**

## 4. Fork policy and delivery model

- **Branches.** `dev` is the default branch and holds all work. `main` is a fast-forward-only mirror of upstream `main`.
- **PRs.** Code and CI/release changes never share a PR. PR titles are conventional commits, and each squash commit takes the PR title.
- **Releases.** Merging a `fix:`/`feat:` PR into `dev` **is a production release**. `ci:`, `build:`, `test:`, `style:` and `chore:` do not release. After a release, no further releasable merges happen until the maintainer has validated that deployment.
- **Public repo.** Fixtures use synthetic names only (`example.com`, `app`, `proxy`, …). No real hostnames, IPs or tokens appear anywhere.
- **Secrets.** `AxiosError` objects, request configs and headers are never logged: not in code, tests, CI or PR text.

| PR | Type | Content |
|---|---|---|
| #4 | `ci:` | Delete the inherited workflows. Add release-please + GHCR publish. Add a single required `pr-check` job. |
| #5 | `build:` | Lockfile parity with the published image. `npm ci` build. Real s6 exit codes. Report-only `npm audit`. |
| #6 | `build(deps):` | In-range `npm audit fix` (no `--force`). `npm audit` becomes blocking. |
| #7 | `fix:` | The code fix and the test suite. Released as `1.10.1`. |
| #10 | `ci:` | `pr-check` gets a 20-minute job timeout and always runs `npm test`. |
| #11 | `fix:` | Review follow-ups: timeout log text, missing tests, comment cleanup. Released as `1.10.2`. |

## 5. Release pipeline

### 5.1 `.github/workflows/release-please.yml`

- **Triggers:** push to `dev`, plus `workflow_dispatch` with a `tag` input. The dispatch path only exists to retry a failed publish.
- **Permissions:** the top level has `contents: read`. The `release-please` job has no write grants: every write goes through the **Release Bot GitHub App token** from `actions/create-github-app-token`. Only `publish` gets `packages: write`.
- **Auto-merge:** when release-please opens a release PR, the next step runs `gh pr merge --squash --auto <that PR>` with the App token.
- **Publishing:** `publish` is a job **chained** to `release-please` (`needs:`), gated on `release_created` or the dispatch path. There is deliberately no separate tag-triggered workflow, because with the App token it would publish twice.
- **Image build:** `docker/metadata-action` runs with `context: git`, so the OCI `revision` label is the release commit. The tags are `X.Y.Z`, `X.Y` and `X`, plus `latest` on the push path only (`flavor: latest=false` elsewhere). It builds `docker-s6/Dockerfile` for `linux/amd64`.
- **Dispatch safety:** the dispatch path **refuses to overwrite** an image tag that already exists. The base image, `apk` packages and s6 tarballs are unpinned, so a rebuild would silently swap the digest behind a tag.
- **Script injection:** inputs and step outputs reach shell code through `env:`, not `${{ }}` interpolation.

**Why an App token.** A release PR opened with `GITHUB_TOKEN` gets no CI until a human clicks "Approve and run". A merge made with `GITHUB_TOKEN` triggers no workflow, so the release would never be tagged or published. PRs and merges made with an App token trigger workflows normally.

### 5.2 Configuration

- `release-please-config.json`: `release-type: node`, `package-name: trafegodns`, `include-component-in-tag: false`, `include-v-in-tag: true`, `bootstrap-sha: 318cfdf…`.
  - `package-name` and `include-component-in-tag` must live in this file, not in action inputs. Otherwise the tag would be `TráfegoDNS-vX.Y.Z`, which `metadata-action` cannot parse.
- `.release-please-manifest.json` started at `1.10.0`.

### 5.3 `pr-check` and the `dev` ruleset

- **The job.** `pr-check` is one job with a stable name, which serves as the required check context. It runs on pull requests into `dev`:
  - Node 23.11.1, the image runtime;
  - `npm ci`;
  - blocking `npm audit --omit=dev --audit-level=high`;
  - `npm test`;
  - an amd64 image build without push.
- **Timeout and paths.** The job has `timeout-minutes: 20`. It has no `paths-ignore`, so docs-only PRs are not left waiting on a check that never runs.
- **The ruleset on `dev`:** deletion and force-push are blocked, `pr-check` is required, the strict "up to date" policy is **off** so release PRs can auto-merge without being rebased, and there are no bypass actors.
- **Why the required check matters.** It is what makes `--auto` wait for CI. Without it, auto-merge would merge immediately.

## 6. Build reproducibility

- **Lockfile parity (#5).** `package-lock.json` was replaced with the lock from the published `:dev` image. All 174 packages were verified against the image's installed tree.
  - The committed lock had been stale: dockerode 4.0.6 and axios 1.8.4, against 4.0.9 and 1.13.2 in the image.
- **Dockerfile.** Stage 1 copies `package.json` and `package-lock.json`, then runs `npm ci --omit=dev`.
- **s6 `finish`.** It prints `$1` (the exit code), or `terminated by signal $2` when s6 passes `256`. Before, it printed `$?` of an `echo`, which was always 0.
- **Audit decision.**
  - The parity tree failed the audit with 3 high and 2 critical findings. #5 added the audit step as report-only.
  - #6 ran `npm audit fix` without `--force`, which kept dockerode on 4.x and stream-json on 1.x, and made the step blocking.
  - Three moderate findings remain; they need breaking bumps (stream-json, and uuid via dockerode).

## 7. Code design

### 7.1 Architecture

```
DockerMonitor
  connect(gen) ── getEvents(abortSignal) ── pipeline(source, parser, streamValues, sink, onClosed(gen))
       └─ then refreshLabels('boot' | 'reconnect')      sink → classifyEvent → INFO "Docker event <Action> <name>"
                                                               → debounce 3 s (max 10 s) → refreshLabels('event')
  refreshLabels(trigger)  [SingleFlight, 15 s timeout, never rejects]
       → listContainers → diff/log → publish DOCKER_LABELS_UPDATED { containers, …, trigger }
  onClosed(gen, err) → WARN once per outage → backoff 1 s → 30 s (jitter) → connect(++gen)

TraefikMonitor
  requestPoll(trigger)  [SingleFlight with trailing rerun; interval tick, or DOCKER_LABELS_UPDATED with trigger ∈ {event, reconnect}]
       → getRouters (follow X-Next-Page) → dockerMonitor.refreshLabels('poll')
       → gate: labels loaded at least once → resolveHostnameLabels (exact attribution) → publish TRAEFIK_ROUTERS_UPDATED

DNSManager
  TRAEFIK_ROUTERS_UPDATED → dnsPass.run(…)  [SingleFlight: no concurrent passes, latest payload wins]
       → processHostnames (unchanged manage/skip logic) → INFO "Managing N hostnames (+a, -b)" on change

EventBus: every subscriber is wrapped (sync throws and async rejections are caught and logged via describeError)
app.js: installProcessGuards() → Docker first (never exits on Docker failure) → DNS init → monitor init → polling
```

### 7.2 Event classification

```js
const HANDLED_ACTIONS = new Set(['start', 'stop', 'die', 'destroy', 'health_status: healthy']);
// action = event.Action, falling back to event.status for pre-1.52 daemons; exact match only
// id     = event.Actor.ID ?? event.id;  name = event.Actor.Attributes.name
```

- **Exact matching.** `exec_*` actions and the other health states carry suffixes, so exact matching ignores them. A busy host emits several healthcheck `exec_*` events per second.
- **Handled events.** Each one logs INFO `Docker event <Action> <name>`, publishes `DOCKER_CONTAINER_STARTED`/`STOPPED` (with the existing payload) for start/stop actions, and schedules a debounced label refresh.
- **`health_status: healthy`** is handled because Traefik hides the routers of containers that are not yet healthy, so for containers with a healthcheck, the router only appears at that transition. On Docker Engine 29.7.2 (API 1.55) it fires **on transitions only**: a container flapping between healthy and unhealthy produced 4 `health_status` events against about 20 `exec_*` triples.

### 7.3 Event stream lifecycle

- **A single reconnect owner with a generation counter.** Every connect attempt and every `stopWatching()` increments `generation`. A pipeline callback or late `getEvents` result whose captured generation is stale does nothing, so there is never more than one live stream and never a reconnect after a stop.
- **`stream.pipeline(source, parser, streamValues(), sink, cb)`.** Its callback fires exactly once for every way the stream can end: clean end, end mid-object, socket reset, or destroy. That callback is the only reconnect trigger.
- **Subscribe first, then re-list.** Every (re)connect runs `refreshLabels` after the new stream is subscribed, so nothing that happens after the subscription can be missed. No `since=` replay is used; the daemon's ring buffer is too short.
- **Recovery requires a surviving stream.** The recovery INFO line, or the boot success line, is logged and the outage cleared only if the stream is still the current one after the re-list. A proxy that accepts and immediately closes therefore gives one WARN per outage and no false "reconnected" lines.
- **Backoff.** Equal jitter, `delay ∈ [base/2, base]`, with `base = min(30 s, 1 s × 2^attempt)`. The attempt counter resets only after a connection has stayed up for 30 s.
- **Connect timeout.** A per-connection `AbortController` is aborted by a 10 s timer. This bounds `getEvents` against a host that accepts the connection but never answers. The failure is logged as `connect timed out after 10000 ms`.
- **Boot.** `startWatching()` never rejects. If Docker is unreachable, it WARNs once (`Docker is unreachable (…); continuing and retrying in the background`) and keeps retrying. Before, it exited, and every s6 respawn re-ran the DNS provider init.
- **`stopWatching()`.** It increments the generation *before* destroying the stream, then clears and nulls the timers and aborts and destroys the stream.

Timing constants are exported as `DockerMonitor.DEFAULT_TIMINGS` and can be injected in tests. No environment variables were added.

| Constant | Default | Purpose |
|---|---|---|
| `eventDebounceMs` / `eventDebounceMaxMs` | 3000 / 10000 | Trailing debounce, capped so a long burst of events (e.g. `compose up`) still refreshes. |
| `reconnectInitialMs` / `reconnectMaxMs` | 1000 / 30000 | Reconnect backoff. |
| `stableConnectionMs` | 30000 | How long a connection must stay up before the backoff resets. |
| `connectTimeoutMs` | 10000 | Upper bound on `getEvents`. |
| `refreshTimeoutMs` | 15000 | Upper bound on `listContainers`. |

### 7.4 One label-refresh path

`refreshLabels(trigger)`, where `trigger` is `boot`, `event`, `reconnect` or `poll`, is the only path that refreshes labels.

- **Concurrency.** It runs through a `SingleFlight`: at most one run at a time, and at most one queued rerun. A call made during a run is served by a run that **starts after** the call.
- **Timeout.** It uses `listContainers({ all: false, abortSignal: AbortSignal.timeout(15 s) })`.
- **Failure handling.** It never rejects. On error or timeout it keeps the last good cache and publishes nothing. The first failure of an outage WARNs (`Could not refresh Docker labels (trigger=…): <reason>; keeping last good cache (N containers)`); later failures log at DEBUG. A timeout's reason reads `timed out after 15000 ms`. The first success afterwards logs INFO `Docker label refresh recovered`.
- **On success.** It rebuilds the container list and the legacy caches, logs `Docker labels refreshed (trigger=…): N running containers; …`, and publishes exactly one `DOCKER_LABELS_UPDATED`. The summary is logged at INFO, except that polls with no changes log it at DEBUG.
- **Every Traefik poll re-lists containers**, so a missed event is bounded by one poll interval.

### 7.5 Polls and DNS passes

- **`SingleFlight`** (`src/utils/singleFlight.js`) has four properties:
  - no concurrent executions;
  - the queued rerun uses the latest arguments;
  - a rejection reaches only that run's callers;
  - a call that arrives between the end of a run and the start of its queued rerun joins the rerun instead of starting a second execution.
- **Traefik polls** go through `pollRunner`. A request made during a poll queues one trailing poll instead of being dropped. `DOCKER_LABELS_UPDATED` with trigger `event` or `reconnect` requests a poll, but only once polling has started (`pollTimer` is set).
- **Labels-loaded gate.** In traefik mode, with Docker events on, no DNS pass runs until labels have loaded once; the skip is logged at WARN once, then at DEBUG. This keeps the old behaviour where a Docker outage at boot ran no pass, and prevents a default-config rewrite with `DNS_DEFAULT_MANAGE=true`. After labels have loaded once, a Docker outage no longer stops DNS passes: they run on the last good cache.
- **Direct mode.** `pollContainers()` refreshes labels first. Its `DOCKER_LABELS_UPDATED` subscriber polls only when `hasChanges && pollTimer`. Because Docker starts first at boot, this guard is what keeps a DNS pass from starting before the provider has initialised.
- **DNS passes** are serialized through a `SingleFlight` in DNSManager, so two passes can never both create the same missing record. At the end of each pass an INFO line reports changes to the managed set: `Managing N hostnames` on the first pass, then `Managing N hostnames (+a.example.com, -b.example.com)`, sorted and capped at 10 entries. Nothing is logged when the set is unchanged.

### 7.6 Exact router attribution (`src/utils/routerAttribution.js`)

Pure functions with no substring matching and no container-id matching. For a router `ref`:

1. If its provider is not `docker` (`@file`, `@internal`, …), it has no owner.
2. `base` is the router name without `@docker`.
3. **Label owners:** candidate containers with a label key starting with `traefik.http.routers.<base>.`, compared case-insensitively.
4. **Per-entrypoint split.** This step runs only if step 3 found no owner, the router has exactly one entrypoint `ep`, and `base` starts with `ep-`. It retries step 3 with the prefix stripped. A router genuinely named `blog-admin` is caught by step 3 first and never stripped. (Traefik v3.7 `pkg/server/aggregator.go`.)
5. **Default router:** candidates with no HTTP router labels whose `normalize(<compose service>_<compose project>)` or `normalize(<container name>)` equals the base, with the stripped name also accepted when step 4 applied. (Traefik v3.7 `pkg/provider/docker/shared.go`.)
6. If several containers qualify, the one with the first name wins when their DNS labels are identical (for example `--scale` replicas). Otherwise the router is **ambiguous**: its hostnames are excluded and a WARN is logged.

**Candidates** are running containers with `traefik.enable=true`, which assumes Traefik runs with `exposedByDefault=false`.
- A container without that label never owns a router. Its hostnames are unowned, so `DNS_DEFAULT_MANAGE` decides, and its `dns.*` overrides are not applied.
- #9 tracks changing this to "strict, then fall back to containers with **no** `traefik.enable` label, never `false`".

A hostname is managed if any of its routers' owners has `dns.manage=true` and none has `dns.skip=true`. This goes through DNSManager's unchanged decision logic:

| Owner labels | DNSManager receives |
|---|---|
| Any owner has `skip` | `skip=true`: unmanaged even with `DNS_DEFAULT_MANAGE=true` |
| Otherwise, any owner has `manage` | `manage=true` |
| Otherwise | The first owner's labels (or none); `DNS_DEFAULT_MANAGE` decides |

`api@docker` (service `api@internal`) is owned by the Traefik container through step 3.

### 7.7 Pagination

- **Traefik:** `GET /api/http/routers?page=N&per_page=100`. The loop runs while `X-Next-Page > page`, because Traefik wraps the header back to `1` on the last page. It is capped at 100 pages.
- **Cloudflare:** the record cache loops over `page=1..result_info.total_pages` (100 per page). It stops early on an empty page and is capped at 1000 pages. The cache is assigned **once, after every page succeeds**, so a failure part-way through keeps the old cache and rethrows.

### 7.8 Error containment (`src/utils/errors.js`, `src/utils/processGuards.js`)

- **`describeError`** is the only renderer on background paths. It outputs the message, `code=` and `status=`, and never reads config, headers, request or `response.data`.
- **`runGuarded(context, fn)`** catches sync throws and async rejections, logs them through `describeError`, and never rethrows. Every EventBus subscriber is wrapped this way, and the unsubscribe function removes the wrapper, so one failing subscriber no longer stops the others. The debounce and reconnect timers are also guarded.
- **Process backstop:** on `unhandledRejection` or `uncaughtException`, the process logs a sanitised ERROR and exits 1, and s6 restarts it. This is installed at the top of `app.js`, so a site that was missed can never print a credential.

### 7.9 Boot sequence (`src/app.js`)

```
installProcessGuards()
displaySettings()
if (watchDockerEvents) await dockerMonitor.startWatching()   // Docker first; never throws; retries in the background
await dnsManager.init()
await monitor.init()
await monitor.startPolling()
```

### 7.10 Concurrency summary

Node is single-threaded, so the "races" are interleavings of async continuations. `SingleFlight` and the generation checks enforce ordering; no lock library is needed.

| Shared state | Protection |
|---|---|
| Container list and label caches | Written only by `refreshLabels` (a `SingleFlight`) and replaced atomically after the await. |
| Stream fields and timers | The generation captured per connection; `stopWatching` increments it before destroying the stream. |
| Traefik poll | `pollRunner`: a `SingleFlight` with a trailing rerun. |
| DNS pass, provider record cache, tracker file | `dnsPass`: a `SingleFlight`. No pass starts before `dnsManager.init()` in either mode. |

A poll awaits `refreshLabels`, and a DNS pass is started by a poll's publish without being awaited. No runner waits on a runner that waits on it, so the design cannot deadlock.

### 7.11 Constraints kept

- The tracker's default path, file name and schema are unchanged. The only addition is an optional `dataDir` constructor parameter, used by tests.
- `cleanupOrphanedRecords` and its call site are byte-for-byte unchanged.
- There are no new env vars and no config changes.
- There is no server-side `event=` filter on `/events`, and no API-version pin.

## 8. Decisions and rejected alternatives

| Decision | Why | Rejected |
|---|---|---|
| No no-data watchdog on the event stream | The per-poll re-list already bounds staleness. On quiet hosts a watchdog would add a steady stream of reconnect WARNs. | A 60–120 s watchdog |
| No server-side `event=` filter | The stream would sit idle long enough for a socket proxy to cut it at 600 s. | Filtering `/events` down to handled actions |
| No `since=` replay | The daemon's ring buffer covers only about 30 s. | Resuming from the last event time |
| No API-version pin | A pin works only while the daemon's minimum API is ≤ 1.51. | `new Docker({ version: 'v1.51' })` |
| Debounce of 3 s (capped at 10 s) | Traefik's provider throttle (2 s default) can delay applying a change, and upstream had chosen 3 s from experience. | About 2 s |
| Strict `traefik.enable=true` candidates | The issue specified it, and it avoids false ambiguity from stale labels. The side effect is covered by #9. | Any container not set to `false` |
| Audit fixes in their own PR | Keeps the security bump reviewable, and ships it inside `1.10.1`. | Shipping on the unpatched tree; no audit step |
| Tests in plain JavaScript (`node:test`) | No new dependencies and no lockfile changes. They were written so a later TypeScript migration can convert them mechanically. | TypeScript tests |
| Exit watchdog in the tests instead of `--test-force-exit` | `--test-force-exit` would hide leaked timers and sockets. | `--test-force-exit`, `--test-timeout` |

## 9. Tests

- **Setup.** The runner is `node:test` with `node:assert/strict`; `npm test` runs `node --test "test/**/*.test.js"`, with no test dependencies. CI runs it on Node 23.11.1 against the locked dependencies. There are 113 tests as of `1.10.2`.
- **Integration fakes.** Integration tests run real dockerode and axios against in-process HTTP fakes:
  - a Docker daemon (`test/helpers/fakeDockerDaemon.js`) serving events in the API 1.54 shape or the legacy 1.47 shape, written in random slices so JSON objects straddle chunk boundaries;
  - `exec_*` noise;
  - sever, clean-end and mid-object-end modes, plus refuse and hang;
  - Traefik, with `X-Next-Page` wraparound;
  - Cloudflare, with `result_info`, per-page failures and write failures.
- **Other helpers:**
  - `makeConfig` (never `new ConfigManager()`);
  - an in-memory stub DNS provider;
  - level-aware log capture;
  - `waitFor`;
  - a shared pipeline builder;
  - an exit watchdog that fails a test file whose handles outlive its tests.
- **Cases:**

| Case | Checks |
|---|---|
| a, b | API 1.54 and API 1.47 events drive a label refresh and a poll through to the DNS provider. |
| c | A severed stream, a clean end and an end mid-object each lead to one WARN, one reconnect and one re-list, with exactly one live stream. |
| d | A daemon outage gives backoff, one WARN, and a recovery INFO with the re-listed count. |
| e | `stopWatching()` never reconnects. |
| f | Booting while Docker is down, and the labels-loaded gate. |
| g, h | A failing or hanging container listing keeps the last good cache. A container started while the stream is dead is picked up by the next poll. |
| i | The golden attribution set, at unit level and end to end. Its 13 managed hostnames reproduce real-world shapes: exporter and socket-proxy siblings, network-namespace sidecars, a per-entrypoint split, a `blog-admin` router that must not be stripped, compose default routers, and an all-hex name. Already-correct records are not rewritten. |
| j | Traefik and Cloudflare pagination. |
| k | A rejected Cloudflare call never logs the token or headers and never crashes, on both the listing (rejection) path and the write path. |
| l | With cleanup off, `cleanupOrphanedRecords` and `deleteRecord` are never called, and tracker entries change only `id`/`updatedAt`. |
| m | The INFO observability lines appear, and no `exec_` line does. |
| — | Every handled action (`health_status: healthy`, `stop`, `die`, `destroy`) drives a refresh; the events connect timeout works against a daemon that never answers; direct-mode boot order; `SingleFlight` hand-off; secret-safe error rendering; the process guards. |

- **Mutation checks.** Each behaviour was checked by breaking the source on purpose and confirming a test fails. Examples: the original `event.status` filter, removing the connect timer, removing the boot-order guard, and the old substring matching.

## 10. Known limitations and follow-ups

- **#9: containers without `traefik.enable`.** Such containers lose their `dns.*` overrides under strict attribution. With `DNS_DEFAULT_MANAGE=true` their records are rewritten to defaults; with `DNS_DEFAULT_MANAGE=false` they become unmanaged, and are deleted by cleanup when `CLEANUP_ORPHANED=true`. The fix is a strict-then-fallback rule.
- **Wider cleanup scope.** With `CLEANUP_ORPHANED=true`, the Cloudflare pagination fix means orphan cleanup now evaluates every record in the zone, not just the first 100. The behaviour is correct, but it is new after upgrading.
- **Stack traces.** Guarded background paths log only the sanitised error summary.
- **Moderate audit findings.** Three remain and need breaking upgrades: stream-json 1.x → 2.x, and uuid via dockerode.
- **Base image and build inputs.** `node:23-alpine` is end-of-life, and the `apk`/s6 inputs are unpinned. These are future `build:` changes.
- **Frozen `dev` tag.** The legacy `dev` image tag stays at its pre-release digest. Consumers adopt releases by pinning `X.Y.Z` or `latest`.

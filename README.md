# TrafegoDNS

<div align="center">
  <img src="https://raw.githubusercontent.com/avargaskun/TrafegoDNS/dev/logo/logo.png" alt="TrafegoDNS Logo" width="200" height="200">
</div>

TrafegoDNS watches your Docker containers and keeps your public DNS records in sync with them. Start a container with a hostname, and its DNS record appears at Cloudflare, DigitalOcean or Route53. Stop it, and the record can be cleaned up.

It reads hostnames either from your Traefik routers or straight from container labels, so it works with Traefik, NGINX, Caddy, HAProxy, or no reverse proxy at all.

> This is a fork of [elmerfds/TrafegoDNS](https://github.com/elmerfds/TrafegoDNS). It fixes Docker Engine 29+ support and Traefik router matching, and publishes its own image at `ghcr.io/avargaskun/trafegodns`. Already running upstream? See [Migrating from Upstream](#migrating-from-upstream).

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
  - [1. Run TrafegoDNS](#1-run-trafegodns)
  - [2. Label a container](#2-label-a-container)
  - [3. Check the logs](#3-check-the-logs)
  - [Image tags](#image-tags)
- [Operation Modes](#operation-modes)
  - [Traefik Mode (default)](#traefik-mode-default)
  - [Direct Mode](#direct-mode)
- [DNS Providers](#dns-providers)
  - [Cloudflare](#cloudflare)
  - [DigitalOcean](#digitalocean)
  - [Route53](#route53)
- [Service Labels](#service-labels)
  - [Basic Labels](#basic-labels)
  - [Provider-Specific Labels](#provider-specific-labels)
  - [Type-Specific Labels](#type-specific-labels)
  - [Label Precedence](#label-precedence)
  - [Opt-out vs Opt-in](#opt-out-vs-opt-in)
  - [TTL Limits by Provider](#ttl-limits-by-provider)
- [Usage Examples](#usage-examples)
- [Cleaning Up Orphaned Records](#cleaning-up-orphaned-records)
  - [Preserving Specific DNS Records](#preserving-specific-dns-records)
- [Manual Hostname Management](#manual-hostname-management)
- [Environment Variables](#environment-variables)
- [Deployment Notes](#deployment-notes)
  - [Configuration Storage](#configuration-storage)
  - [User/Group Permissions](#usergroup-permissions)
  - [Using Docker Secrets](#using-docker-secrets)
- [How It Works](#how-it-works)
  - [Matching Traefik Routers to Containers](#matching-traefik-routers-to-containers)
  - [Docker Event Monitoring](#docker-event-monitoring)
  - [DNS Caching and Batching](#dns-caching-and-batching)
  - [Apex Domains](#apex-domains)
  - [Logging](#logging)
- [Migrating from Upstream](#migrating-from-upstream)
  - [What changed](#what-changed)
  - [Upgrade steps](#upgrade-steps)
- [Building from Source](#building-from-source)
- [Development](#development)
- [Licence](#licence)

## Features

- 🔄 Creates and updates DNS records automatically from container configuration
- 🔀 Works with Traefik, or with any other reverse proxy through container labels
- 👀 Reacts to Docker container events in real time, on Docker Engine 29+ and older
- 🔌 Supports Cloudflare, DigitalOcean and AWS Route53
- 🏷️ Supports A, AAAA, CNAME, MX, TXT, SRV and CAA records
- 🌐 Detects your public IP for apex domains and A records
- 🎛️ Per-container control with `dns.*` labels (record type, TTL, Cloudflare proxy, skip, …)
- 🧹 Optional cleanup of orphaned records, with a grace period and a preserve list
- 🔒 Only touches records it created itself; your manually created records are left alone
- 📝 Manages static hostnames that don't belong to any container
- 💪 Keeps running through Docker, Traefik and DNS provider outages
- 🔐 PUID/PGID support and Docker secrets for tokens

## Quick Start

This gets you running in the most common homelab setup: Traefik as the reverse proxy and Cloudflare as the DNS provider. For other providers see [DNS Providers](#dns-providers); for running without Traefik see [Direct Mode](#direct-mode).

You need:

- A Cloudflare API token with **Zone → DNS → Edit** permission for your zone.
- Traefik with its [API enabled](https://doc.traefik.io/traefik/operations/api/) (for example `--api.insecure=true` in a homelab), reachable from the TrafegoDNS container.

### 1. Run TrafegoDNS

```yaml
services:
  trafegodns:
    image: ghcr.io/avargaskun/trafegodns:latest
    container_name: trafegodns
    restart: unless-stopped
    environment:
      - DNS_PROVIDER=cloudflare
      - CLOUDFLARE_TOKEN=your_cloudflare_api_token
      - CLOUDFLARE_ZONE=example.com
      - TRAEFIK_API_URL=http://traefik:8080/api
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./config:/config
    networks:
      - proxy   # the network Traefik is on

networks:
  proxy:
    external: true
```

By default, every hostname that Traefik knows about gets a DNS record. Set `DNS_DEFAULT_MANAGE=false` if you'd rather opt containers in one by one (see [Opt-out vs Opt-in](#opt-out-vs-opt-in)).

### 2. Label a container

Use your normal Traefik labels. Add `dns.*` labels only when you want to change the defaults; here we turn off the Cloudflare proxy:

```yaml
services:
  whoami:
    image: traefik/whoami
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.whoami.rule=Host(`whoami.example.com`)"
      - "dns.proxied=false"
    networks:
      - proxy
```

Without any `dns.*` labels, TrafegoDNS creates a proxied CNAME record pointing at your zone (`whoami.example.com → example.com`). Apex hostnames (`example.com` itself) get an A record with your public IP instead. See [Service Labels](#service-labels) for everything you can change.

### 3. Check the logs

```bash
docker logs -f trafegodns
```

You should see the container being picked up and the record created:

```
ℹ️ Docker event start whoami
ℹ️ Docker labels refreshed (trigger=event): 3 running containers; DNS label changes: whoami
ℹ️ Processing 1 hostnames for DNS management
✅ Created CNAME record for whoami.example.com
ℹ️ Managing 1 hostnames
```

If nothing happens, check that TrafegoDNS can reach the Traefik API (`docker exec trafegodns wget -qO- http://traefik:8080/api/http/routers`) and set `LOG_LEVEL=DEBUG` for more detail.

### Image tags

Images are published to GitHub Container Registry for **linux/amd64**. For arm64 or armv7, [build from source](#building-from-source).

| Tag | Example | Tracks |
|-----|---------|--------|
| `latest` | `latest` | The latest release |
| `X.Y.Z` | `1.10.3` | That exact release |
| `X.Y` | `1.10` | The latest patch release of `1.10` |
| `X` | `1` | The latest release of major version `1` |

Release notes are in the [CHANGELOG](CHANGELOG.md). The old `dev` tag is no longer updated. Upstream's images (`eafxx/trafegodns` on Docker Hub and `ghcr.io/elmerfds/trafegodns`) don't include this fork's changes.

## Operation Modes

`OPERATION_MODE` picks where hostnames come from.

### Traefik Mode (default)

```yaml
environment:
  - OPERATION_MODE=traefik
  - TRAEFIK_API_URL=http://traefik:8080/api
```

TrafegoDNS reads hostnames from the `Host(...)` rules of your Traefik routers, then looks up which container defines each router and applies that container's `dns.*` labels. In practice: keep `traefik.enable=true`, the router labels and the `dns.*` labels on the same container and it just works. The details are in [Matching Traefik Routers to Containers](#matching-traefik-routers-to-containers).

If the Traefik API needs basic auth, set `TRAEFIK_API_USERNAME` and `TRAEFIK_API_PASSWORD`.

### Direct Mode

```yaml
environment:
  - OPERATION_MODE=direct
```

TrafegoDNS reads hostnames straight from container labels, so it doesn't need Traefik or any reverse proxy. Use whichever label style you prefer:

```yaml
labels:
  # A list of full hostnames
  - "dns.hostname=app.example.com,api.example.com"

  # Or a domain plus subdomains
  - "dns.domain=example.com"
  - "dns.subdomain=app,api,admin"

  # Or the apex domain itself
  - "dns.domain=example.com"
  - "dns.use_apex=true"

  # Or numbered hostnames
  - "dns.host.1=app.example.com"
  - "dns.host.2=api.example.com"
```

All other `dns.*` labels work the same in both modes.

## DNS Providers

| Provider | Status | Notes |
|:--------:|:------:|:------|
| ![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white) | ![Stable](https://img.shields.io/badge/✓-Stable-success) | All record types. Proxy (orange cloud) support. TTL down to 1 second (Auto). |
| ![DigitalOcean](https://img.shields.io/badge/DigitalOcean-0080FF?style=flat&logo=digitalocean&logoColor=white) | ![Stable](https://img.shields.io/badge/✓-Stable-success) | All record types. Minimum TTL 30 seconds. `proxied` labels are ignored. |
| ![AWS](https://img.shields.io/badge/Route53-FF9900?style=flat&logo=amazonaws&logoColor=white) | ![Stable](https://img.shields.io/badge/✓-Stable-success) | All record types. Minimum TTL 60 seconds. `proxied` labels are ignored. |

### Cloudflare

Create an API token with **Zone → DNS → Edit** permission for your zone.

```yaml
environment:
  - DNS_PROVIDER=cloudflare
  - CLOUDFLARE_TOKEN=your_cloudflare_api_token
  - CLOUDFLARE_ZONE=example.com
```

Records are proxied (orange cloud) by default. Turn that off per container with `dns.proxied=false`, or globally with `DNS_DEFAULT_PROXIED=false`.

### DigitalOcean

Create an API token with write access.

```yaml
environment:
  - DNS_PROVIDER=digitalocean
  - DO_TOKEN=your_digitalocean_api_token
  - DO_DOMAIN=example.com
```

### Route53

Create an IAM user with these permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "route53:ListHostedZones",
                "route53:ListHostedZonesByName",
                "route53:GetHostedZone",
                "route53:ListResourceRecordSets",
                "route53:ChangeResourceRecordSets"
            ],
            "Resource": "*"
        }
    ]
}
```

```yaml
environment:
  - DNS_PROVIDER=route53
  - ROUTE53_ACCESS_KEY=your_aws_access_key
  - ROUTE53_SECRET_KEY=your_aws_secret_key
  - ROUTE53_ZONE=example.com
  # - ROUTE53_ZONE_ID=Z1234567890ABC  # Alternative to ROUTE53_ZONE
  # - ROUTE53_REGION=eu-west-2        # Optional, defaults to eu-west-2 (London)
```

## Service Labels

Add these labels to a container to control the DNS records created for its hostnames.

### Basic Labels

| Label | Description | Default |
|-------|-------------|---------|
| `dns.skip` | Skip DNS management for this container | `false` |
| `dns.manage` | Enable DNS management for this container (see [Opt-out vs Opt-in](#opt-out-vs-opt-in)) | Depends on `DNS_DEFAULT_MANAGE` |
| `dns.type` | Record type (A, AAAA, CNAME, MX, TXT, SRV, CAA) | `CNAME`, or `A` for apex domains |
| `dns.content` | Record value | Your zone for CNAME, your public IP for A |
| `dns.proxied` | Cloudflare proxy (orange cloud) | `true` |
| `dns.ttl` | TTL in seconds | `1` (Auto) for Cloudflare, `30` for DigitalOcean, `60` for Route53 |
| `dns.hostname` | Comma-separated hostnames (direct mode) | None |
| `dns.domain` | Domain (direct mode) | None |
| `dns.subdomain` | Comma-separated subdomains (direct mode) | None |
| `dns.use_apex` | Also use the apex domain (direct mode) | `false` |
| `dns.host.X` | Numbered hostnames (direct mode) | None |

### Provider-Specific Labels

Every basic label also exists in a provider-specific form, which overrides the generic one. Use these if you run more than one TrafegoDNS instance with different providers against the same containers.

| Label | Description | Providers |
|-------|-------------|-----------|
| `dns.cloudflare.skip`, `dns.cloudflare.manage`, `dns.cloudflare.type`, `dns.cloudflare.content`, `dns.cloudflare.ttl` | Same as the basic labels, Cloudflare only | Cloudflare |
| `dns.cloudflare.proxied` | Cloudflare proxy (orange cloud) | Cloudflare |
| `dns.digitalocean.skip`, `dns.digitalocean.manage`, `dns.digitalocean.type`, `dns.digitalocean.content`, `dns.digitalocean.ttl` | Same as the basic labels, DigitalOcean only | DigitalOcean |
| `dns.route53.skip`, `dns.route53.manage`, `dns.route53.type`, `dns.route53.content`, `dns.route53.ttl` | Same as the basic labels, Route53 only | Route53 |

### Type-Specific Labels

| Label | Record types | Description |
|-------|--------------|-------------|
| `dns.priority` or `dns.<provider>.priority` | MX, SRV | Priority |
| `dns.weight` or `dns.<provider>.weight` | SRV | Weight |
| `dns.port` or `dns.<provider>.port` | SRV | Port |
| `dns.flags` or `dns.<provider>.flags` | CAA | Flags |
| `dns.tag` or `dns.<provider>.tag` | CAA | Tag |

### Label Precedence

1. Provider-specific labels (`dns.cloudflare.type`)
2. Generic labels (`dns.type`)
3. Defaults from environment variables (`DNS_DEFAULT_TYPE`, …)

### Opt-out vs Opt-in

- **Opt-out (default).** `DNS_DEFAULT_MANAGE=true`: every hostname gets a record unless its container has `dns.skip=true`.
- **Opt-in.** `DNS_DEFAULT_MANAGE=false`: only containers with `dns.manage=true` get records. `dns.skip=true` still wins.

### TTL Limits by Provider

| Provider | Minimum TTL | Default TTL | Notes |
|----------|-------------|-------------|-------|
| Cloudflare | 1 second | 1 second (Auto) | TTL is ignored for proxied records (always Auto) |
| DigitalOcean | 30 seconds | 30 seconds | Lower values are raised to 30 |
| Route53 | 60 seconds | 60 seconds | Lower values are raised to 60 |

`DNS_DEFAULT_TTL` is only used when it is at or above the provider's minimum.

## Usage Examples

Each example shows the Traefik-mode labels and the direct-mode labels; use the ones for your mode. The `dns.*` labels are the same in both.

### Turn off the Cloudflare proxy

Useful for media servers and anything that isn't plain HTTP.

```yaml
services:
  jellyfin:
    image: jellyfin/jellyfin
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.jellyfin.rule=Host(`jellyfin.example.com`)"
      # Direct mode
      - "dns.hostname=jellyfin.example.com"

      - "dns.proxied=false"
```

### A record with a specific IP

```yaml
services:
  my-app:
    image: my-image
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      # Direct mode
      - "dns.hostname=app.example.com"

      - "dns.type=A"
      - "dns.content=203.0.113.10"
```

### Custom TTL

```yaml
services:
  my-app:
    image: my-image
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      # Direct mode
      - "dns.hostname=app.example.com"

      - "dns.ttl=3600"
```

### Skip DNS for a container

```yaml
services:
  internal-app:
    image: internal-image
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.internal.rule=Host(`internal.example.com`)"
      # Direct mode
      - "dns.hostname=internal.example.com"

      - "dns.skip=true"
```

### Opt a container in (when `DNS_DEFAULT_MANAGE=false`)

```yaml
services:
  public-app:
    image: public-image
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.public.rule=Host(`public.example.com`)"
      # Direct mode
      - "dns.hostname=public.example.com"

      - "dns.manage=true"
```

### MX record

```yaml
services:
  mail:
    image: mail-image
    labels:
      # Traefik mode
      - "traefik.enable=true"
      - "traefik.http.routers.mail.rule=Host(`example.com`)"
      # Direct mode
      - "dns.hostname=example.com"

      - "dns.type=MX"
      - "dns.content=mail.example.com"
      - "dns.priority=10"
```

## Cleaning Up Orphaned Records

Cleanup is **off by default**. Turn it on to delete records whose container has gone away:

```yaml
environment:
  - CLEANUP_ORPHANED=true
  - CLEANUP_GRACE_PERIOD=15  # minutes, default 15
```

Only records TrafegoDNS created itself are ever deleted; it keeps a list of them in `/config/data/dns-records.json` (see [Configuration Storage](#configuration-storage)). Records you made by hand are never touched.

A record isn't deleted the moment its container stops. It is first marked as orphaned, and only deleted once it has been orphaned for the whole grace period. If the container comes back in the meantime, the mark is removed. This keeps records stable across restarts, image updates and short maintenance windows. You'll see it in the logs:

```
🕒 Marking DNS record as orphaned (will be deleted after 15 minutes): app.example.com (A)
✅ DNS record is active again, removing orphaned mark: app.example.com (A)
🗑️ Grace period elapsed (16 minutes), removing orphaned DNS record: app.example.com (A)
Orphaned records: 3 newly marked, 2 deleted after grace period, 1 reactivated
```

### Preserving Specific DNS Records

Hostnames listed here are never deleted, even if orphaned. Wildcards are supported:

```yaml
environment:
  - PRESERVED_HOSTNAMES=static.example.com,api.example.com,*.admin.example.com
```

Hostnames from `MANAGED_HOSTNAMES` (below) are preserved automatically.

## Manual Hostname Management

To keep a few static records for things that don't run in containers (a NAS, a printer, an external host), list them in `MANAGED_HOSTNAMES`. TrafegoDNS creates them at startup, keeps them in sync, and never deletes them.

```yaml
environment:
  - MANAGED_HOSTNAMES=nas.example.com:A:192.168.1.10:3600:false,mail.example.com:MX:mail.example.com:3600:false
```

Each entry is `hostname:type:content:ttl:proxied`:

- `hostname`: the full hostname
- `type`: A, AAAA, CNAME, MX, TXT, …
- `content`: the record value (IP for A, target for CNAME, …)
- `ttl`: seconds
- `proxied`: `true` or `false` (Cloudflare only)

## Environment Variables

### Mode and provider

| Variable | Description | Default |
|----------|-------------|---------|
| `OPERATION_MODE` | `traefik` or `direct` | `traefik` |
| `DNS_PROVIDER` | `cloudflare`, `digitalocean` or `route53` | `cloudflare` |

### Provider credentials

| Variable | Description | Required |
|----------|-------------|----------|
| `CLOUDFLARE_TOKEN` | Cloudflare API token with DNS edit permission | With Cloudflare |
| `CLOUDFLARE_ZONE` | Your domain (e.g. `example.com`) | With Cloudflare |
| `DO_TOKEN` | DigitalOcean API token with write access | With DigitalOcean |
| `DO_DOMAIN` | Your domain | With DigitalOcean |
| `ROUTE53_ACCESS_KEY` | AWS IAM access key | With Route53 |
| `ROUTE53_SECRET_KEY` | AWS IAM secret key | With Route53 |
| `ROUTE53_ZONE` | Your domain | With Route53 (or `ROUTE53_ZONE_ID`) |
| `ROUTE53_ZONE_ID` | Your Route53 hosted zone ID | With Route53 (or `ROUTE53_ZONE`) |
| `ROUTE53_REGION` | AWS region for API calls (default `eu-west-2`) | No |

Any of the `_TOKEN` and `_KEY` variables can be read from a file instead; see [Using Docker Secrets](#using-docker-secrets).

### Traefik

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAEFIK_API_URL` | Traefik API URL | `http://traefik:8080/api` |
| `TRAEFIK_API_USERNAME` | Basic auth username for the Traefik API | - |
| `TRAEFIK_API_PASSWORD` | Basic auth password for the Traefik API | - |
| `TRAEFIK_LABEL_PREFIX` | Prefix of Traefik's container labels | `traefik.` |

### DNS defaults

These apply when a container doesn't set the matching `dns.*` label.

| Variable | Description | Default |
|----------|-------------|---------|
| `DNS_DEFAULT_MANAGE` | `true` = opt-out, `false` = opt-in (see [Opt-out vs Opt-in](#opt-out-vs-opt-in)) | `true` |
| `DNS_DEFAULT_TYPE` | Record type | `CNAME` |
| `DNS_DEFAULT_CONTENT` | Record value | Your zone (`CLOUDFLARE_ZONE`, `DO_DOMAIN` or `ROUTE53_ZONE`) |
| `DNS_DEFAULT_PROXIED` | Cloudflare proxy | `true` |
| `DNS_DEFAULT_TTL` | TTL in seconds | Cloudflare `1` (Auto), DigitalOcean `30`, Route53 `60` |
| `DNS_LABEL_PREFIX` | Prefix of the `dns.*` labels | `dns.` |
| `PUBLIC_IP` | Public IPv4 to use for A records instead of auto-detecting it | Auto-detected |
| `PUBLIC_IPV6` | Public IPv6 to use for AAAA records instead of auto-detecting it | Auto-detected |
| `IP_REFRESH_INTERVAL` | How often to re-detect the public IP (ms) | `3600000` (1 hour) |

### Cleanup and static hostnames

| Variable | Description | Default |
|----------|-------------|---------|
| `CLEANUP_ORPHANED` | Delete records whose container has gone away | `false` |
| `CLEANUP_GRACE_PERIOD` | Minutes a record stays orphaned before it is deleted | `15` |
| `PRESERVED_HOSTNAMES` | Hostnames never to delete (comma-separated, `*.` wildcards allowed) | - |
| `MANAGED_HOSTNAMES` | Static hostnames to create and keep (see [Manual Hostname Management](#manual-hostname-management)) | - |

### Behaviour

| Variable | Description | Default |
|----------|-------------|---------|
| `POLL_INTERVAL` | How often to poll Traefik or the container list (ms) | `60000` (1 minute) |
| `WATCH_DOCKER_EVENTS` | React to Docker events between polls | `true` |
| `DOCKER_SOCKET` | Path to the Docker socket | `/var/run/docker.sock` |
| `DNS_CACHE_REFRESH_INTERVAL` | How often to re-fetch all records from the provider (ms) | `3600000` (1 hour) |
| `API_TIMEOUT` | Timeout for Traefik and provider API calls (ms) | `60000` (1 minute) |
| `LOG_LEVEL` | `ERROR`, `WARN`, `INFO`, `DEBUG` or `TRACE` | `INFO` |
| `PUID` / `PGID` | User and group to run as | `1001` / `1001` |

## Deployment Notes

### Configuration Storage

Mount `/config` so TrafegoDNS remembers which records it created across restarts and updates:

```yaml
volumes:
  - ./config:/config
```

The only file in it is `/config/data/dns-records.json`, the list of records TrafegoDNS manages. Back it up along with the rest of your compose setup; if you lose it, TrafegoDNS will still update records but won't know it is allowed to delete the ones it created earlier.

### User/Group Permissions

The container runs as user `abc` (UID 1001, GID 1001). Set `PUID` and `PGID` to make the files in `/config` owned by your user:

```yaml
environment:
  - PUID=1000
  - PGID=1000
```

The container also needs to read the Docker socket. On most hosts mounting it read-only is enough, because the container adds its user to the socket's group at startup:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

If you get permission errors on the socket, either run the container as root (`user: "0:0"`) or point `DOCKER_SOCKET` at a Docker socket proxy.

### Using Docker Secrets

Every credential variable (`CLOUDFLARE_TOKEN`, `DO_TOKEN`, `ROUTE53_ACCESS_KEY`, `ROUTE53_SECRET_KEY`, `TRAEFIK_API_PASSWORD`) can be read from a file by adding `_FILE` to its name:

```yaml
secrets:
  cloudflare_token:
    file: ./secrets/cloudflare_token

services:
  trafegodns:
    image: ghcr.io/avargaskun/trafegodns:latest
    container_name: trafegodns
    restart: unless-stopped
    secrets:
      - cloudflare_token
    environment:
      - DNS_PROVIDER=cloudflare
      - CLOUDFLARE_TOKEN_FILE=/run/secrets/cloudflare_token
      - CLOUDFLARE_ZONE=example.com
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./config:/config
```

## How It Works

You don't need this section to use TrafegoDNS. It explains the behaviour behind the scenes, which helps when something looks off in the logs.

### Matching Traefik Routers to Containers

In Traefik mode, hostnames come from Traefik routers but `dns.*` labels live on containers, so each router has to be matched to the container that defines it. A container is the owner of a router when it has labels starting with `traefik.http.routers.<router name>.`, or when it has no router labels and Traefik generated a default router for it (named after the Compose service, or the container name).

Which containers are considered depends on their `traefik.enable` label:

| `traefik.enable` | Can own routers |
|------------------|-----------------|
| `true` | Yes |
| Not set | Yes, but only for routers no `traefik.enable=true` container claims. When that happens, an INFO line is logged: `Router <router> attributed to container <container> (no traefik.enable label)` |
| Anything else (`false`, `1`, `yes`, …) | No |

Edge cases:

- Routers that don't come from Docker (`@file`, `@internal`, …) have no owner. Their hostnames follow `DNS_DEFAULT_MANAGE` with the default record settings.
- If several containers define the same router with different `dns.*` labels, its hostnames are left unmanaged and a warning is logged. Replicas with identical labels (for example from `--scale`) are fine.
- If several routers serve the same hostname, `dns.skip=true` on any owner wins, then `dns.manage=true`; otherwise the first owner's labels are used, preferring `traefik.enable=true` containers.

### Docker Event Monitoring

With `WATCH_DOCKER_EVENTS=true` (the default), TrafegoDNS reacts within a few seconds when a container starts, stops, is destroyed or becomes healthy. Without it, changes are picked up on the next `POLL_INTERVAL`.

Containers with a healthcheck are handled when they turn healthy, because Traefik only exposes their routers from that point. Events are debounced for 3 seconds (at most 10 seconds during a burst like `docker compose up`).

If the event stream drops, for example when the Docker daemon restarts or a socket proxy closes an idle connection, TrafegoDNS logs one warning, reconnects with backoff (at most 30 seconds between attempts) and re-lists running containers after reconnecting. Every poll re-lists them too, so a missed event is caught within one `POLL_INTERVAL`. If Docker is unreachable at startup, TrafegoDNS keeps running and retries in the background.

In Traefik mode, no DNS changes are made until container labels have been read at least once. After that, if Docker becomes unreachable, TrafegoDNS keeps working from the last known labels.

Log lines you may see:

| Level | Message | Meaning |
|-------|---------|---------|
| INFO | `Docker event start my-app` | A handled container event arrived |
| WARN | `Docker event stream ended; reconnecting` | The stream dropped; reconnecting (logged once per outage) |
| INFO | `Docker event stream reconnected after 3 attempt(s); re-listed 12 running containers (trigger=reconnect)` | Back to normal |
| WARN | `Docker is unreachable (…); continuing and retrying in the background` | Docker was down at startup |
| WARN | `Could not refresh Docker labels (trigger=poll): …; keeping last good cache (12 containers)` | Listing containers failed; last known labels in use |
| INFO | `Docker label refresh recovered (trigger=poll)` | Listing containers works again |
| WARN | `Skipping DNS pass: Docker container labels have not been loaded yet` | Waiting for the first successful container listing |

### DNS Caching and Batching

At startup, and every `DNS_CACHE_REFRESH_INTERVAL`, TrafegoDNS fetches all records in your zone (reading every page) and keeps them in memory. Each pass compares the wanted records against that cache and only calls the provider for records that actually need creating or updating, so even large deployments make very few API calls.

### Apex Domains

CNAME records aren't allowed at the apex of a zone (`example.com` itself), so TrafegoDNS creates an A record with your public IP there instead. The IP is detected automatically and re-checked every `IP_REFRESH_INTERVAL`; set `PUBLIC_IP` to override it.

### Logging

`LOG_LEVEL=INFO` (the default) shows startup, each handled Docker event, and record changes:

```
ℹ️ 🚀 Starting in TRAEFIK mode
✅ DNS Manager initialised successfully
✅ Docker event monitoring started successfully
ℹ️ Processing 30 hostnames for DNS management
✅ Created A record for example.com
ℹ️ 29 DNS records are up to date
ℹ️ Managing 30 hostnames
```

When the set of managed hostnames changes, one line lists what was added and removed:

```
ℹ️ Managing 30 hostnames (+app.example.com, -old.example.com)
```

Use `DEBUG` to see every poll and every record comparison, and `TRACE` to also dump the full record payloads. API errors are logged as a one-line summary (message, error code, HTTP status); request headers and tokens are never logged.

## Migrating from Upstream

If you were running `eafxx/trafegodns` or `ghcr.io/elmerfds/trafegodns`, this section is for you.

### What changed

Compared with upstream `1.10.0`:

- **Docker Engine 29+ works.** Docker 29 changed the format of container events, and upstream silently ignored all of them, so a container started after TrafegoDNS never got a DNS record until a restart. Both formats are now handled.
- **Survives Docker outages.** If the event stream drops (daemon restart, socket proxy closing an idle connection), TrafegoDNS reconnects and resyncs instead of waiting forever. If Docker is down at startup, it retries in the background instead of exiting into a restart loop.
- **Routers are matched to containers exactly.** Upstream matched by substring, so router `app` could pick up the `dns.*` labels of `app-exporter`. See [Matching Traefik Routers to Containers](#matching-traefik-routers-to-containers).
- **More than 100 routers or records.** Traefik routers and Cloudflare records beyond the first page are now read.
- **Safer failures.** Errors from background work are logged without request headers or tokens and no longer crash the process.
- **Versioned releases.** Each release is tagged on GHCR and listed in the [CHANGELOG](CHANGELOG.md).

No environment variables were added, removed or renamed. Your existing `dns.*` labels and `/config` directory work as they are.

### Upgrade steps

1. Change the image to `ghcr.io/avargaskun/trafegodns:latest` and pull.
2. If any container has `traefik.enable` set to something other than `true` (for example `false`, `1` or `yes`), it can no longer own a router, so its `dns.*` labels won't apply. Use `traefik.enable=true`, or remove the label.
3. Watch the first few minutes of logs for `Router … is claimed by containers … with different DNS labels`. That means two containers define the same router with conflicting `dns.*` labels; upstream would pick one silently, this fork leaves the hostname alone until you fix the labels.
4. If you use `CLEANUP_ORPHANED=true` with Cloudflare, cleanup now sees your whole zone rather than the first 100 records. As before, it only ever deletes records listed in `/config/data/dns-records.json`.

## Building from Source

```bash
git clone https://github.com/avargaskun/TrafegoDNS.git
cd TrafegoDNS
docker build -f docker-s6/Dockerfile -t trafegodns .
```

Then use `image: trafegodns` in your compose file. This is also how to run on arm64 or armv7, which the published image doesn't cover.

## Development

TrafegoDNS is a Node.js application. It talks to Docker through [dockerode](https://github.com/apocas/dockerode), to Traefik and Cloudflare/DigitalOcean over their HTTP APIs, and to Route53 through the AWS SDK.

```bash
npm ci
npm test
```

The test suite uses Node's built-in test runner and runs against in-process fakes of Docker, Traefik and Cloudflare; no external services are needed. CI runs it on Node 23.

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/). Merging a `fix:` or `feat:` PR into `dev` triggers [release-please](https://github.com/googleapis/release-please), which updates the [CHANGELOG](CHANGELOG.md), tags the release and publishes the image. Design records for larger changes live in [`designs/`](designs/).

### Credits

- Original project by [elmerfds](https://github.com/elmerfds/TrafegoDNS), with implementation assistance from Claude AI
- Inspired by [cloudflare-dns-swarm](https://github.com/MarlBurroW/cloudflare-dns-swarm) and [docker-traefik-cloudflare-companion](https://github.com/tiredofit/docker-traefik-cloudflare-companion/)

## Licence

MIT

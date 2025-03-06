# Traefik DNS Manager

A service that automatically manages DNS records based on Traefik routing configuration.

## Features

- 🔄 Automatic DNS record management based on Traefik Host rules
- 👀 Real-time monitoring of Docker container events
- 🏷️ Support for multiple DNS record types (A, AAAA, CNAME, MX, TXT, SRV, CAA)
- 🌐 Automatic public IP detection for apex domains
- 🎛️ Fine-grained control with service-specific labels
- 💪 Fault-tolerant design with retry mechanisms
- 🧹 Optional cleanup of orphaned DNS records
- 📊 Optimized performance with DNS caching and batch processing
- 🖨️ Configurable logging levels for better troubleshooting
- 🔌 Multi-provider support with provider-agnostic label system

## Supported DNS Providers

| Provider | Status | Implementation Details |
|:--------:|:------:|:----------------------:|
| ![Cloudflare](https://img.shields.io/badge/Cloudflare-F38020?style=flat&logo=cloudflare&logoColor=white) | ![Stable](https://img.shields.io/badge/✓-Stable-success) | Full support for all record types and features |
| ![DigitalOcean](https://img.shields.io/badge/DigitalOcean-0080FF?style=flat&logo=digitalocean&logoColor=white) | ![Stable](https://img.shields.io/badge/✓-Stable-success) | Full support for all record types and features |
| ![AWS](https://img.shields.io/badge/Route53-FF9900?style=flat&logo=amazonaws&logoColor=white) | ![Planned](https://img.shields.io/badge/⟳-Planned-blue) | Coming soon |

## Quick Start

### Docker Compose

```yaml
version: '3'

services:
  traefik-dns-manager:
    image: eafxx/traefik-dns-manager:latest
    container_name: traefik-dns-manager
    restart: unless-stopped
    user: "0:0"  # Required for Docker socket access
    environment:
      # DNS Provider (choose one)
      - DNS_PROVIDER=cloudflare  # Options: cloudflare, digitalocean
      
      # Cloudflare settings (if using Cloudflare)
      - CLOUDFLARE_TOKEN=your_cloudflare_api_token
      - CLOUDFLARE_ZONE=example.com
      
      # DigitalOcean settings (if using DigitalOcean)
      - DO_TOKEN=your_digitalocean_api_token
      - DO_DOMAIN=example.com
      
      # Traefik API settings
      - TRAEFIK_API_URL=http://traefik:8080/api
      - LOG_LEVEL=INFO
      
      # DNS record management
      - CLEANUP_ORPHANED=true  # Set to true to automatically remove DNS records when containers are removed
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik-network
```

## DNS Provider Configuration

### Cloudflare

Cloudflare requires an API token with DNS edit permissions for your zone:

```yaml
environment:
  - DNS_PROVIDER=cloudflare
  - CLOUDFLARE_TOKEN=your_cloudflare_api_token
  - CLOUDFLARE_ZONE=example.com
```

Cloudflare-specific features:
- Proxying (orange cloud) through `dns.proxied` or `dns.cloudflare.proxied` labels
- Ultra-low TTL support (as low as 1 second)
- Automatic handling of apex domains

### DigitalOcean

DigitalOcean requires an API token with write access to your domain:

```yaml
environment:
  - DNS_PROVIDER=digitalocean
  - DO_TOKEN=your_digitalocean_api_token
  - DO_DOMAIN=example.com
```

DigitalOcean-specific notes:
- Minimum TTL of 30 seconds (enforced by provider)
- No proxying support (all `proxied` labels are ignored)
- Automatically adds trailing dots for domain names as required by DigitalOcean

## Service Labels

The DNS Manager supports the following labels for customizing DNS record creation:

### Basic Labels (Provider-Agnostic)

| Label | Description | Default |
|-------|-------------|---------|
| `dns.skip` | Skip DNS management for this service | `false` |
| `dns.manage` | Enable DNS management for this service | Depends on `DNS_DEFAULT_MANAGE` |
| `dns.type` | DNS record type (A, AAAA, CNAME, etc.) | `CNAME` or `A` for apex domains |
| `dns.content` | Record content/value | Domain for CNAME, Public IP for A |
| `dns.ttl` | Record TTL in seconds | `1` (Auto) for Cloudflare, `30` for DigitalOcean |

### Provider-Specific Labels (Override Provider-Agnostic Labels)

| Label | Description | Default | Supported Providers |
|-------|-------------|---------|---------------------|
| `dns.cloudflare.skip` | Skip Cloudflare DNS management for this service | `false` | Cloudflare |
| `dns.cloudflare.manage` | Enable Cloudflare DNS management for this service | Depends on `DNS_DEFAULT_MANAGE` | Cloudflare |
| `dns.cloudflare.type` | DNS record type for Cloudflare | `CNAME` or `A` for apex domains | Cloudflare |
| `dns.cloudflare.content` | Record content for Cloudflare | Domain for CNAME, Public IP for A | Cloudflare |
| `dns.cloudflare.proxied` | Enable Cloudflare proxy (orange cloud) | `true` | Cloudflare |
| `dns.cloudflare.ttl` | Record TTL for Cloudflare in seconds | `1` (Auto) | Cloudflare |
| `dns.digitalocean.skip` | Skip DigitalOcean DNS management for this service | `false` | DigitalOcean |
| `dns.digitalocean.manage` | Enable DigitalOcean DNS management for this service | Depends on `DNS_DEFAULT_MANAGE` | DigitalOcean |
| `dns.digitalocean.type` | DNS record type for DigitalOcean | `CNAME` or `A` for apex domains | DigitalOcean |
| `dns.digitalocean.content` | Record content for DigitalOcean | Domain for CNAME, Public IP for A | DigitalOcean |
| `dns.digitalocean.ttl` | Record TTL for DigitalOcean in seconds | `30` (Minimum) | DigitalOcean |

### Type-Specific Labels

| Label | Applicable Types | Description |
|-------|------------------|-------------|
| `dns.priority` or `dns.<provider>.priority` | MX, SRV | Priority value |
| `dns.weight` or `dns.<provider>.weight` | SRV | Weight value |
| `dns.port` or `dns.<provider>.port` | SRV | Port value |
| `dns.flags` or `dns.<provider>.flags` | CAA | Flags value |
| `dns.tag` or `dns.<provider>.tag` | CAA | Tag value |

## Label Precedence

The system uses the following precedence order when reading labels:

1. Provider-specific labels (e.g., `dns.cloudflare.type`)
2. Generic DNS labels (e.g., `dns.type`)
3. Default values from configuration

This allows you to set global defaults, override them with generic DNS settings, and further override with provider-specific settings when needed.

## Provider-Specific TTL Requirements

Different DNS providers have different requirements for TTL values:

| Provider | Minimum TTL | Default TTL | Notes |
|----------|-------------|-------------|-------|
| Cloudflare | 1 second | 1 second (Auto) | TTL is ignored for proxied records (always Auto) |
| DigitalOcean | 30 seconds | 30 seconds | Values below 30 are automatically adjusted to 30 |

## Usage Examples

### Basic Service with Default Settings

Just use standard Traefik labels, and DNS records are automatically created:

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "traefik.http.routers.my-app.entrypoints=https"
```

This will create a CNAME record for `app.example.com` pointing to your domain.

### Disable Cloudflare Proxy for Media Servers

```yaml
services:
  my-service:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-service.rule=Host(`service.example.com`)"
      - "dns.proxied=false"  # Use generic label
      # OR "dns.cloudflare.proxied=false"  # Use provider-specific label
```

### Use A Record with Custom IP

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "dns.type=A"
      - "dns.content=203.0.113.10"  # Custom IP address
```

### Set Custom TTL for DigitalOcean DNS

```yaml
services:
  my-app:
    image: my-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-app.rule=Host(`app.example.com`)"
      - "dns.digitalocean.ttl=3600"  # Set TTL to 1 hour (3600 seconds)
```

### Skip DNS Management for a Service

```yaml
services:
  internal-app:
    image: internal-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.internal.rule=Host(`internal.example.com`)"
      - "dns.skip=true"  # Skip DNS management for all providers
      # OR "dns.cloudflare.skip=true"  # Skip just Cloudflare DNS management
```

### Opt-in DNS Management (when DNS_DEFAULT_MANAGE=false)

```yaml
services:
  public-app:
    image: public-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.public.rule=Host(`public.example.com`)"
      - "dns.manage=true"  # Explicitly enable DNS management for all providers
      # OR "dns.cloudflare.manage=true"  # Enable just for Cloudflare
```

### Create MX Record

```yaml
services:
  mail-service:
    image: mail-image
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mail.rule=Host(`example.com`)"
      - "dns.type=MX"
      - "dns.content=mail.example.com"
      - "dns.priority=10"
```

## Environment Variables

### DNS Provider Selection
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DNS_PROVIDER` | DNS provider to use | `cloudflare` | No |

### Cloudflare Settings
| Variable | Description | Default | Required if using Cloudflare |
|----------|-------------|---------|----------|
| `CLOUDFLARE_TOKEN` | Cloudflare API token with DNS edit permissions | - | Yes |
| `CLOUDFLARE_ZONE` | Your domain name (e.g., example.com) | - | Yes |

### DigitalOcean Settings
| Variable | Description | Default | Required if using DigitalOcean |
|----------|-------------|---------|----------|
| `DO_TOKEN` | DigitalOcean API token with write access | - | Yes |
| `DO_DOMAIN` | Your domain name (e.g., example.com) | - | Yes |

### Traefik API Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `TRAEFIK_API_URL` | URL to Traefik API | `http://traefik:8080/api` | No |
| `TRAEFIK_API_USERNAME` | Username for Traefik API basic auth | - | No |
| `TRAEFIK_API_PASSWORD` | Password for Traefik API basic auth | - | No |

### DNS Default Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `DNS_LABEL_PREFIX` | Base prefix for DNS labels | `dns.` | No |
| `DNS_DEFAULT_TYPE` | Default DNS record type | `CNAME` | No |
| `DNS_DEFAULT_CONTENT` | Default record content | Value of `CLOUDFLARE_ZONE` or `DO_DOMAIN` | No |
| `DNS_DEFAULT_PROXIED` | Default Cloudflare proxy status | `true` | No |
| `DNS_DEFAULT_TTL` | Default TTL in seconds | `1` (Auto for Cloudflare) or minimum TTL for provider | No |
| `DNS_DEFAULT_MANAGE` | Global DNS management mode | `true` | No |

### IP Address Settings
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PUBLIC_IP` | Manual override for public IPv4 | Auto-detected | No |
| `PUBLIC_IPV6` | Manual override for public IPv6 | Auto-detected | No |
| `IP_REFRESH_INTERVAL` | How often to refresh IP (ms) | `3600000` (1 hour) | No |

### Application Behavior
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `POLL_INTERVAL` | How often to poll Traefik API (ms) | `60000` (1 min) | No |
| `WATCH_DOCKER_EVENTS` | Whether to watch Docker events | `true` | No |
| `CLEANUP_ORPHANED` | Whether to remove orphaned DNS records | `false` | No |
| `DOCKER_SOCKET` | Path to Docker socket | `/var/run/docker.sock` | No |
| `LOG_LEVEL` | Logging verbosity (ERROR, WARN, INFO, DEBUG, TRACE) | `INFO` | No |
| `DNS_CACHE_REFRESH_INTERVAL` | How often to refresh DNS cache (ms) | `3600000` (1 hour) | No |

## Automated Cleanup of Orphaned Records

When containers are removed, their DNS records can be automatically cleaned up by enabling the `CLEANUP_ORPHANED` setting:

```yaml
environment:
  - CLEANUP_ORPHANED=true
```

This will:
- Track all active hostnames being managed
- Compare them with existing DNS records
- Remove any records that no longer match active hostnames
- Skip system records (NS, SOA, CAA) and apex domain records

To avoid premature deletion, the system will:
- Perform hostname normalization to ensure case-insensitive comparison
- Skip records that don't match the managed domain pattern
- Log all orphaned records before deletion for verification

## DNS Management Modes

Traefik DNS Manager supports two operational modes for DNS management:

### Opt-out Mode (Default)
- Set `DNS_DEFAULT_MANAGE=true` or leave it unset
- All services automatically get DNS records created
- Services can opt-out with `dns.skip=true` or `dns.<provider>.skip=true` label

### Opt-in Mode
- Set `DNS_DEFAULT_MANAGE=false`
- Services need to explicitly opt-in with `dns.manage=true` or `dns.<provider>.manage=true` label
- Services can still use skip labels to ensure no DNS management

## Logging System

The application includes a configurable logging system to help with monitoring and troubleshooting:

### Log Levels

- `ERROR` - Only critical errors that break functionality
- `WARN` - Important warnings that don't break functionality
- `INFO` - Key operational information (default)
- `DEBUG` - Detailed information for troubleshooting
- `TRACE` - Extremely detailed information for deep troubleshooting

The default level is `INFO`, which provides a clean, readable output with important operational information. Set the `LOG_LEVEL` environment variable to change the logging verbosity.

### INFO Level Format

```
✅ Starting Traefik DNS Manager
ℹ️ Cloudflare Zone: example.com
ℹ️ Processing 30 hostnames for DNS management
✅ Created A record for example.com
ℹ️ 29 DNS records are up to date
✅ Traefik DNS Manager running successfully
```

## Performance Optimization

The application includes built-in performance optimizations to reduce API calls and improve efficiency:

### DNS Caching

DNS records from providers are cached in memory to reduce API calls:

- All records are fetched in a single API call
- The cache is refreshed periodically (default: every hour)
- The refresh interval can be adjusted with the `DNS_CACHE_REFRESH_INTERVAL` variable

### Batch Processing

DNS record updates are processed in batches:

- All hostname configurations are collected first
- Records are compared against the cache in memory
- Only records that need changes receive API calls
- All other records use cached data

This significantly reduces API calls to DNS providers, especially for deployments with many hostnames.

## Automatic Apex Domain Handling

The DNS Manager automatically detects apex domains (e.g., `example.com`) and uses A records with your public IP instead of CNAME records, which are not allowed at the apex domain level.

## Building from Source

```bash
# Clone the repository
git clone https://github.com/elmerfds/traefik-dns-manager.git
cd traefik-dns-manager

# Build the Docker image
docker build -t traefik-dns-manager .

# Run the container
docker run -d \
  --name traefik-dns-manager \
  --user 0:0 \
  -e CLOUDFLARE_TOKEN=your_token \
  -e CLOUDFLARE_ZONE=example.com \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  traefik-dns-manager
```

## License

MIT
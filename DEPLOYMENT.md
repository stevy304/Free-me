# Deployment (Hetzner, four servers)

Nothing here has been provisioned yet. Buying servers, pointing a domain and opening the platform to the public each need the owner's explicit go-ahead. This is the plan the files in `deploy/` implement; it is validated in a staging environment before production.

## Servers and private network

All four servers join one Hetzner private network (vSwitch or Cloud Network), e.g. `10.0.1.0/24`.

| Server | Private IP | Runs | Files |
| --- | --- | --- | --- |
| 1. App node A | 10.0.1.10 | Caddy edge, API, web | `deploy/edge/Caddyfile`, `deploy/app-node/docker-compose.yml` |
| 2. App node B | 10.0.1.11 | API, web | `deploy/app-node/docker-compose.yml` |
| 3. Database node | 10.0.1.20 | PostgreSQL 16, Redis 7, backups | `deploy/db-node/` |
| 4. Media node | 10.0.1.30 | FFmpeg workers (phase 2) | `deploy/media-node/` |

A Hetzner Load Balancer can replace Caddy-on-server-1 as the entry point later; the app nodes do not change.

## Firewall rules

Default deny incoming on every server (Hetzner Cloud Firewall and `ufw`). Allow only:

| Server | From | Port | Why |
| --- | --- | --- | --- |
| 1 | Internet | 80, 443/tcp, 443/udp | HTTPS (HTTP redirects; UDP for HTTP/3) |
| 1, 2 | 10.0.1.10 | 3000, 4000 | Edge to web and API |
| 3 | 10.0.1.10, 10.0.1.11, 10.0.1.30 | 5432, 6379 | Database and Redis from app and media nodes |
| all | Admin IPs only | 22 | SSH with keys; password login disabled |
| all | Monitoring host | 9100 | Node exporter (phase 6) |

```bash
# Example for server 3
ufw default deny incoming && ufw default allow outgoing
for ip in 10.0.1.10 10.0.1.11 10.0.1.30; do ufw allow from $ip to any port 5432 proto tcp; ufw allow from $ip to any port 6379 proto tcp; done
ufw allow from <admin-ip> to any port 22 proto tcp
ufw enable
```

PostgreSQL and Redis bind to the private address only (`PRIVATE_IP` in the compose file) and Redis requires a password, so neither is reachable from the internet even if a firewall rule is wrong.

## Images

Built from the repository root (CI or a build host), pushed to a private registry:

```bash
docker build -f apps/api/Dockerfile --target runtime -t <registry>/freeme/api:<version> .
docker build -f apps/api/Dockerfile --target migrate -t <registry>/freeme/api-migrate:<version> .
docker build -f apps/web/Dockerfile -t <registry>/freeme/web:<version> .
```

Containers run as the unprivileged `node` user with `no-new-privileges`; the API container's filesystem is read-only.

## First installation

1. **Server 3:** install Docker; copy `deploy/db-node/`; `PRIVATE_IP=10.0.1.20 POSTGRES_PASSWORD=… REDIS_PASSWORD=… docker compose up -d`; install the backup cron (see [BACKUP-AND-RECOVERY.md](BACKUP-AND-RECOVERY.md)).
2. **Migrations:** from server 1, `docker run --rm --env-file api.env <registry>/freeme/api-migrate:<version>`. It applies migrations and upserts the video categories (safe to repeat).
3. **Servers 1 and 2:** write `api.env` (see [ENVIRONMENT.md](ENVIRONMENT.md); `chmod 600`); `PRIVATE_IP=<own ip> FREEME_API_IMAGE=… FREEME_WEB_IMAGE=… docker compose up -d`.
4. **Server 1 edge:** run Caddy with `deploy/edge/Caddyfile` and `FREEME_DOMAIN`, `ACME_EMAIL`, `APP_NODE_A=10.0.1.10`, `APP_NODE_B=10.0.1.11`. Caddy obtains the TLS certificate.
5. **Google sign-in:** in Google Cloud Console, add `https://<domain>/api/auth/google/callback` as an authorised redirect URI.
6. **Check:** `https://<domain>/api/health` returns `ok` with `database: ok, redis: ok`; sign in with an email code; confirm the admin account from `ADMIN_EMAILS`.

## Releasing a new version

1. CI green on `main`.
2. Build and push images tagged with the commit.
3. Run the migrate image (migrations are additive and backward-compatible with the running version).
4. Update server 2, wait for `/api/health`, then server 1. Caddy's health checks keep traffic on the healthy node during each restart.
5. Roll back by redeploying the previous tags (and only rolling back a migration with a written down-migration).

## Not yet covered (phase 6)

Monitoring (Prometheus, Grafana, alerting), centralised logs and error tracking, CDN configuration, object storage buckets, staged load tests at 100, 500 and 1,000 concurrent viewers, and a recorded restore drill. Capacity for 50,000 users is not claimed until those measurements exist.

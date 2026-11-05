# Deployment (Ubuntu 24.04, no containers)

Going live for the first time? Follow [LAUNCH.md](LAUNCH.md), which links back here.

Free Me runs as plain systemd services on Ubuntu servers. Nothing here has been provisioned yet. Buying servers or storage, pointing a domain and opening the platform to the public each need the owner's go-ahead.

## Servers

All servers join one private network (Hetzner vSwitch or Cloud Network), e.g. `10.0.1.0/24`.

| Server | Private IP | Runs | Install |
| --- | --- | --- | --- |
| 1. App node A | 10.0.1.10 | Caddy (HTTPS, load balancing), API, web | `ROLE=edge` |
| 2. App node B | 10.0.1.11 | API, web | `ROLE=app` |
| 3. Database node | 10.0.1.20 | PostgreSQL 16, Redis 7, nightly backups | `ROLE=db` |
| 4. Media node | 10.0.1.30 | FFmpeg workers (`freeme-worker@N`), local scratch disk | `ROLE=media` |
| Object storage | (service) | Video sources, renditions, thumbnails | `storage-setup.sh` |
| CDN | (service) | Serves the bucket's `pub/` prefix worldwide | provider console |

### Why object storage and a CDN for "big video storage"

Videos never sit on the application servers. An S3-compatible bucket grows without limits or disk planning, keeps three copies, and costs far less per terabyte than server disks. Hetzner Object Storage is the default choice next to Hetzner servers; MinIO on your own storage servers, Wasabi, Backblaze B2 or AWS S3 also work, because the code only speaks S3. A CDN (for example Bunny CDN or Cloudflare) in front of the bucket's `pub/` prefix caches segments close to viewers everywhere, so playback starts fast in Kigali and in Tokyo, and the servers carry almost no video traffic.

Rough storage per hour of 1080p video: about 3.5 GB of renditions plus the source.

## Firewall

`install.sh` enables `ufw` with default deny on every server and opens only:

| Server | From | Port |
| --- | --- | --- |
| 1 | internet | 80, 443/tcp, 443/udp |
| 1, 2 | app nodes | 3000 (web), 4000 (API) |
| 3 | app nodes and media node | 5432 (PostgreSQL), 6379 (Redis) |
| all | `ADMIN_SSH_FROM` (or anywhere, with a warning) | 22 |

PostgreSQL and Redis also bind only to localhost and the private address, require passwords (SCRAM for PostgreSQL), and the PostgreSQL account is limited to the private subnet in `pg_hba.conf`.

## First installation

Copy the repository's `deploy/ubuntu` folder to each server (or clone the repository), then:

1. **Server 3 (database):**
   `sudo ROLE=db PRIVATE_IP=10.0.1.20 DB_PASSWORD=… REDIS_PASSWORD=… ./install.sh`
   It installs and tunes PostgreSQL 16 (memory-based settings) and Redis (append-only, password, no eviction), creates the `freeme` database and role, and installs the nightly backup cron (fill `/etc/freeme/backup.env`).
2. **Object storage:** create a bucket and keys at your provider, then run
   `S3_ENDPOINT=… S3_BUCKET=freeme-media APP_URL=https://freeme.example AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… ./storage-setup.sh`
   It sets CORS (direct browser uploads, reading `ETag`), public read for `pub/` only, and cleans abandoned uploads after 7 days.
3. **CDN:** create a pull zone whose origin is the bucket's `pub/` prefix (`https://<endpoint>/<bucket>/pub`). Use its address as `MEDIA_PUBLIC_BASE_URL`.
4. **Configuration:** the first run of `ROLE=app|edge|media` creates `/etc/freeme/freeme.env` from `freeme.env.example` and stops. Fill it in (see [ENVIRONMENT.md](ENVIRONMENT.md)); the same file is used on servers 1, 2 and 4.
5. **Server 2:** `sudo ROLE=app PRIVATE_IP=10.0.1.11 ./install.sh`
6. **Database schema** (once, from server 2): `cd /opt/freeme/app && sudo -u freeme bash -c 'set -a; . /etc/freeme/freeme.env; set +a; npx prisma migrate deploy && npm run db:seed'`
7. **Server 1:** `sudo ROLE=edge PRIVATE_IP=10.0.1.10 FREEME_DOMAIN=freeme.example ACME_EMAIL=ops@freeme.example ./install.sh`. Caddy gets the TLS certificate once DNS points at server 1.
8. **Server 4:** `sudo ROLE=media PRIVATE_IP=10.0.1.30 WORKERS=2 ./install.sh`. Each worker instance transcodes `WORKER_CONCURRENCY` videos at once; about one instance per 8 CPU cores is a good start.
9. **Google sign-in:** add `https://freeme.example/api/auth/google/callback` as an authorised redirect URI.
10. **Check:** `https://freeme.example/api/health` shows `database: ok, redis: ok`; sign in, create a channel, upload a video, publish it, play it.

## Services

| Unit | Server | Logs |
| --- | --- | --- |
| `freeme-api` | 1, 2 | `journalctl -u freeme-api -f` |
| `freeme-web` | 1, 2 | `journalctl -u freeme-web -f` |
| `freeme-worker@1..N` | 4 | `journalctl -u 'freeme-worker@*' -f` |
| `caddy` | 1 | `journalctl -u caddy -f` |
| `postgresql`, `redis-server` | 3 | `journalctl -u postgresql -f` |

Services run as the unprivileged `freeme` user with systemd hardening (read-only system, private `/tmp`, no privilege escalation) and restart automatically.

## Releasing a new version

1. CI green on `main`; tag the release (`v0.2.0`).
2. Server 2: `sudo FREEME_REF=v0.2.0 MIGRATE=1 ./release.sh` (migrations are additive and work with the version still running on server 1).
3. Server 1: `sudo FREEME_REF=v0.2.0 ./release.sh`. Caddy's health checks keep traffic on server 2 while server 1 restarts.
4. Server 4: `sudo FREEME_REF=v0.2.0 ./release.sh`. Interrupted transcodes are retried automatically.
5. Roll back by releasing the previous tag (and a written down-migration if the schema changed).

## Scaling

- **More uploads at once:** add media servers (`ROLE=media`), all pulling from the same queue.
- **Faster processing per video:** `TRANSCODE_PRESET=veryfast` (default) favours speed; `faster` or `medium` give smaller files at more CPU. A 20-second 1080p clip took 8 s to become playable (SD) and 20 s for every quality on 4 cores in testing.
- **More viewers:** almost all traffic is segments from the CDN; add application nodes behind Caddy for API and page load.
- Capacity numbers for 50,000 users are only claimed after the load tests of phase 6.

## Not yet covered (phase 6)

Monitoring and alerts (Prometheus, Grafana) and a central log store (logs are already JSON lines with request ids, and `/api/admin/system` reports health, queue and failures), staged load tests at 100, 500 and 1,000 concurrent viewers, and a recorded restore drill.

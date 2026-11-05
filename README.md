# Free Me

> **Your content. Your freedom. Your opportunity.**

Free Me is an independent video-sharing platform where creators publish videos, grow audiences and earn a transparent share of advertising revenue. It launches first in Rwanda and is built for viewers, creators and advertisers in every country: countries, languages, time zones and currencies are data, not assumptions.

## Status

Phases 1 (foundation) and 2 (video upload and playback) are built and tested. Later phases follow [ROADMAP.md](ROADMAP.md).

| Works today | Arrives later |
| --- | --- |
| Sign-in with Google or a one-time email code (no passwords), sessions, signing out other devices | Comments, likes, watch history, playlists, captions (phase 3) |
| Profiles with country, language and time zone for anyone in the world; channels with @handles; subscriptions | Creator Studio analytics, advertiser studio, revenue ledger (phase 4) |
| **Video upload**: resumable multipart uploads straight to object storage, up to 20 GB per file by default | Payouts, moderation queues (phase 5) |
| **Processing**: FFmpeg worker turns every upload into adaptive HLS from 144p up to 4K (never upscaled), SD playable first, HD follows; thumbnails; Shorts detected automatically | Monitoring, load tests, production rollout (phase 6) |
| **Playback**: YouTube-style player (quality and speed menus, theater, picture-in-picture, keyboard shortcuts), Shorts feed, home feed, search, Studio to manage videos | |
| Public and unlisted videos from the CDN; private videos only through short-lived signed links; views counted in Redis and written in batches | |
| Administration: roles, suspension, audit log | |

Nothing in the app is sample data: an empty platform shows empty states until people sign up and publish.

## Repository

```
apps/api         NestJS REST API (OpenAPI at /api/docs) and the media worker (dist/worker.js)
apps/web         Next.js web app (App Router, Tailwind CSS)
packages/shared  Rules shared by both: handles, countries, languages, revenue maths
prisma           PostgreSQL schema, migrations and reference-data seed
deploy/ubuntu    Server installer, systemd services, Caddy edge, release, storage and backup scripts
```

## Run it locally (Ubuntu, no containers)

```bash
sudo apt install -y postgresql redis-server ffmpeg          # Node.js 22.12+ is also required
sudo -u postgres createuser -P freeme && sudo -u postgres createdb -O freeme freeme   # password: freeme
cp .env.example .env                                         # fill SESSION_SECRET (and Google keys if you have them)
npm ci                                                       # also generates the Prisma client and builds packages/shared
set -a; . ./.env; set +a
npm run db:migrate && npm run db:seed                        # schema + video categories
npm run dev:api                                              # API on http://localhost:4000 (docs: /api/docs)
npm run dev:worker                                           # media worker (needs REDIS_URL)
npm run dev:web                                              # web app on http://localhost:3000
```

Videos are stored in `./.data/storage` (`STORAGE_DRIVER=local`). With `MAIL_TRANSPORT=console`, sign-in codes are printed in the API log. Put your address in `ADMIN_EMAILS` to become an administrator. Without `REDIS_URL` the API processes uploads itself (one machine, development only).

## Checks

```bash
npm run lint    # TypeScript in every workspace
npm test        # unit and API tests (needs DATABASE_URL to a migrated test database; ffmpeg; Redis and S3_TEST_ENDPOINT optional)
npm run build   # API, worker and web production builds
cd apps/web && E2E_API_LOG=/path/to/api.log npx playwright test   # browser tests against running servers
```

CI runs all of these on every pull request ([.github/workflows/verify.yml](.github/workflows/verify.yml)).

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, request flow, four-server topology |
| [DATABASE.md](DATABASE.md) | Schema, migrations, indexes, data rules |
| [API.md](API.md) | Endpoints and conventions |
| [SECURITY.md](SECURITY.md) | Authentication, sessions, CSRF, rate limits, audit |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Hetzner servers, firewall rules, release steps |
| [BACKUP-AND-RECOVERY.md](BACKUP-AND-RECOVERY.md) | Backups, restore drill, recovery targets |
| [ROADMAP.md](ROADMAP.md) | Phases and their exit criteria |

## License

Proprietary. All rights reserved.

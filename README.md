# Free Me

> **Your content. Your freedom. Your opportunity.**

Free Me is an independent video-sharing platform where creators publish videos, grow audiences and earn a transparent share of advertising revenue. It launches first in Rwanda and is built for viewers, creators and advertisers in every country: countries, languages, time zones and currencies are data, not assumptions.

## Status

Phase 1 (foundation) is built and tested. Later phases follow [ROADMAP.md](ROADMAP.md).

| Works today | Arrives later |
| --- | --- |
| Sign-in with Google or a one-time email code (no passwords), server-side sessions, signing out other devices | Video upload and transcoding (phase 2) |
| Profiles with country, language and time zone for anyone in the world | Comments, likes, watch history, playlists (phase 3) |
| Channels with unique @handles, subscriptions, subscription feed | Creator Studio, advertiser studio, revenue ledger (phase 4) |
| Home feed, categories, search with suggestions, watch page with adaptive (HLS) playback, Shorts feed, all reading real data | Payouts, moderation queues, analytics (phase 5) |
| Administration: roles, suspension, audit log | Hetzner rollout, monitoring, load tests (phase 6) |

Nothing in the app is sample data: an empty platform shows empty states until people sign up and publish.

## Repository

```
apps/api         NestJS REST API (OpenAPI at /api/docs)
apps/web         Next.js web app (App Router, Tailwind CSS)
packages/shared  Rules shared by both: handles, countries, languages, revenue maths
prisma           PostgreSQL schema, migrations and reference-data seed
deploy           Per-server Docker Compose files, Caddy edge, backup script
```

## Run it locally

Requirements: Node.js 22.12+ and Docker (for PostgreSQL and Redis), or your own PostgreSQL 16 and Redis 7.

```bash
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + Redis on localhost
cp .env.example .env                             # then fill SESSION_SECRET (and Google keys if you have them)
npm ci                                           # also generates the Prisma client and builds packages/shared
set -a; . ./.env; set +a
npm run db:migrate && npm run db:seed            # schema + video categories
npm run dev:api                                  # API on http://localhost:4000 (docs: /api/docs)
npm run dev:web                                  # web app on http://localhost:3000
```

With `MAIL_TRANSPORT=console`, sign-in codes are printed in the API log instead of being emailed. Put your address in `ADMIN_EMAILS` to become an administrator when you sign in.

## Checks

```bash
npm run lint    # TypeScript in every workspace
npm test        # shared unit tests and API tests (needs DATABASE_URL to a migrated test database)
npm run build   # API and web production builds
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

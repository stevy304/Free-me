# Free Me

> **Your content. Your freedom. Your opportunity.**

Free Me is an independent video-sharing platform where creators publish videos, grow audiences and earn a transparent share of advertising revenue. It launches first in Rwanda and is built for viewers, creators and advertisers in every country: countries, languages, time zones and currencies are data, not assumptions.

## Status

Phases 1 (foundation) and 2 (video upload and playback) are built and tested. Later phases follow [ROADMAP.md](ROADMAP.md).

| Works today | Arrives later |
| --- | --- |
| Sign-in with Google or a one-time email code (no passwords), sessions, signing out other devices | Captions, notifications (phase 3) |
| Profiles with country, language and time zone for anyone in the world; channels with @handles; following | Creator Hub analytics, advertiser studio, revenue ledger (phase 4) |
| **Video upload**: resumable multipart uploads straight to object storage, up to 20 GB per file by default | Payouts (phase 5) |
| **Processing**: FFmpeg worker turns every upload into adaptive HLS from 144p up to 4K (never upscaled), SD playable first, HD follows; thumbnails; Moments (short vertical videos) detected automatically | Monitoring, load tests, production rollout (phase 6) |
| **Playback**: adaptive player (quality and speed menus, theater, picture-in-picture, keyboard shortcuts, resume where you stopped), Moments feed, home feed, search, Creator Hub to manage videos | |
| **Community**: Spark (public) and Not for me (private, seen only by the creator), Conversation with replies and pinning, Trail (watch history with resume), Kept and shareable Collections, Tune in to Spaces | |
| **Own identity**: header tabs (For you, Following, Moments, Explore), Find panel (press `/`), interest-based For you home with no behaviour tracking, stage-style watch page with a floating player capsule, Free Me icon set, Plus Jakarta Sans + Inter, lagoon/saffron/paper palette | |
| **Trust and safety**: reports, copyright notices and counter-notices, a moderation queue with removal and restore, strikes, decision emails; Terms, Privacy Policy, Community Guidelines and Copyright pages | |
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

## Run it locally (Ubuntu or GitHub Codespaces, no containers)

Node.js 22.12+ is required. Then one command starts everything:

```bash
npm install
npm run dev
```

`npm run dev` ([scripts/dev.mjs](scripts/dev.mjs)):

1. creates `.env` from `.env.example` on the first run (with a random `SESSION_SECRET`);
2. installs PostgreSQL, Redis and FFmpeg with apt if they are missing (first run only; `npm run setup` does just this), and starts them if they are stopped;
3. creates the database user and database from `DATABASE_URL`, refreshes the database client for the current code, applies the migrations and seeds the video categories (so after `git pull`, just run `npm run dev` again);
4. runs the **API** (http://localhost:4000, docs at `/api/docs`, rebuilt when you edit it), the **media worker** and the **web app** (http://localhost:3000), with labelled logs in one terminal. Ctrl+C stops all of them.

In GitHub Codespaces it uses the forwarded https address of port 3000 automatically (open it from the Ports tab).

Videos are stored in `./.data/storage` (`STORAGE_DRIVER=local`). With `MAIL_TRANSPORT=console`, sign-in codes are printed in the `[api]` lines. Put your address in `ADMIN_EMAILS` in `.env` to become an administrator (and moderator).

The parts can also be started separately, each in its own terminal: `npm run dev:api`, `npm run dev:worker`, `npm run dev:web` (PostgreSQL and Redis must already be running and migrated: `npm run db:generate && npm run db:migrate && npm run db:seed`; after a `git pull`, run these again or the API answers 500 with "Unknown field …").

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
| [LAUNCH.md](LAUNCH.md) | Go-live checklist: accounts, email DNS, Google, checks, monitoring, legal |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Hetzner servers, firewall rules, release steps |
| [BACKUP-AND-RECOVERY.md](BACKUP-AND-RECOVERY.md) | Backups, restore drill, recovery targets |
| [ROADMAP.md](ROADMAP.md) | Phases and their exit criteria |

## License

Proprietary. All rights reserved.

# Architecture

## Components

```
Browser ──HTTPS──> Caddy (edge, TLS, load balancing)
                     ├── /api/*  → NestJS API   (apps/api, port 4000)  ──> PostgreSQL 16 (Prisma)
                     │                                                 └─> Redis 7 (shared rate limits; queues from phase 2)
                     └── /*      → Next.js web  (apps/web, port 3000)  ──> API over the private network
```

- **One origin for the browser.** The web app and the API share the public domain. The browser calls `/api/*`; Caddy (production) or the Next.js rewrite (development) forwards it to the API. Session cookies therefore stay first-party, `SameSite=Lax` works, and no CORS is needed.
- **Server rendering with the visitor's session.** Next.js server components call the API on the private network (`API_INTERNAL_URL`), forwarding the visitor's cookie and language, so pages arrive complete. Interactive parts (sign-in, subscribe, settings, admin) call `/api/*` from the browser.
- **Stateless application nodes.** Sessions live in PostgreSQL; rate-limit counters in Redis. Any API instance can serve any request, so nodes can be added behind the load balancer.
- **Shared rules.** `packages/shared` holds the rules both sides must agree on (handle format, reserved names, country and language lists, revenue maths). The API enforces them; the web app uses them for instant form feedback.

## API structure (apps/api/src)

| Module | Responsibility |
| --- | --- |
| `config` | Reads and checks every environment variable at start-up; refuses unsafe production settings |
| `database` | Prisma client; Redis client with an in-process fallback for single-instance development |
| `common` | CSRF origin guard, authentication and role guard, rate limiter, audit log, error filter |
| `auth` | Email one-time codes, Google OpenID Connect, sessions, account creation and linking |
| `users` | The signed-in account: profile, devices |
| `channels` | Channels, handles, subscriptions |
| `catalog` | Categories, feeds, watch page data, search and suggestions |
| `admin` | Accounts, roles, suspension, audit log (administrators only) |
| `health` | Liveness and dependency status for the load balancer |

Request pipeline: Helmet headers → cookie parser → session middleware (attaches the account) → origin guard (state-changing requests must come from the web app) → auth/role guard (routes marked `@RequireAuth`) → validation pipe (unknown fields rejected) → controller → error filter (known errors keep their message; anything else is logged and answered with a generic 500).

## Web structure (apps/web/src)

- `components/shell`: top bar with search and suggestions, sidebar (full on wide screens, narrow rail on tablets, drawer on phones), bottom bar on phones, account menu with theme choice.
- `components/video`: cards, rows, the infinite grid, category chips.
- `app/*`: pages: home, Shorts, subscriptions, search results, watch, channel (`/@handle`), create channel, settings, sign-in, You, administration.
- Design tokens (light and dark) are CSS variables in `globals.css`; components never hard-code colours.

## Worldwide by design

Countries are ISO 3166-1 codes, languages BCP 47 tags, time zones IANA names, currencies ISO 4217 codes; names come from the runtime's Unicode data in the reader's language. Money is stored as integers in each currency's minor unit, and revenue maths never uses floating point. Nothing defaults to one country.

## Four-server topology (proposal to validate in staging)

| Server | Runs | Reachable from |
| --- | --- | --- |
| 1. Application node A | Caddy edge, API, web | Internet: 80/443 only |
| 2. Application node B | API, web | Private network only (from the edge) |
| 3. Database node | PostgreSQL, Redis, backups | Private network only (from servers 1, 2, 4) |
| 4. Media node | FFmpeg workers (phase 2) | Private network only |

Video files go to S3-compatible object storage and are delivered through a CDN; application disks never hold media. Firewall rules and private networking are in [DEPLOYMENT.md](DEPLOYMENT.md). Capacity claims (users, concurrent viewers) are made only after the load tests of phase 6.

## Coming in later phases

- **Phase 2:** resumable uploads straight to object storage (signed URLs), BullMQ queues in Redis, FFmpeg workers on the media node producing an HLS ladder and thumbnails, private-video access checks on manifests.
- **Phase 3:** comments, likes, watch history and playlists. Views and watch time are counted through Redis and aggregated into PostgreSQL in batches, not one row per view.

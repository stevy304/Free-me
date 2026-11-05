# Database

PostgreSQL 16 through Prisma 6. The schema is `prisma/schema.prisma`; every change ships as a migration in `prisma/migrations` and is applied with `npx prisma migrate deploy` (never `db push` against a real database). CI checks that the migrations rebuild exactly the schema (`prisma migrate diff --exit-code`).

## Migrations

| Migration | What it does |
| --- | --- |
| `20261104000000_initial` | All platform tables: users, profiles, channels, videos, renditions, files, categories, tags, subscriptions, likes, comments, playlists, watch history, advertisers, campaigns, ad impressions and events, creator eligibility, balances, revenue ledger, payouts, reports, moderation actions, audit log |
| `20261105000000_passwordless_auth_worldwide` | Sign-in without passwords (`OAuthAccount`, `EmailOtp`, `Session`), roles as a set, account status; removes market-specific defaults (country, city, currency, payout methods); adds currency to every money table and the split in force to each ledger entry |

The second migration adds required columns without defaults (currency, advertiser country, payout provider). That is safe because no production data existed yet; from now on, required columns on non-empty tables get a default or a backfill step.

Reference data: `npm run db:seed` upserts the video categories. Nothing else is seeded: users, channels and videos only come from real use.

## Identity and sessions

| Table | Purpose | Notes |
| --- | --- | --- |
| `User` | One account per email | `roles` is a set (`VIEWER` always; `CREATOR` with a channel; `ADVERTISER`, `MODERATOR`, `ADMIN` granted). `status`: active, suspended, deleted |
| `OAuthAccount` | Linked Google identities | Unique on (`provider`, `providerAccountId`); linked by Google's stable id, so a changed Gmail address keeps the same account |
| `EmailOtp` | One-time sign-in codes | Stores an HMAC of the code, never the code; expiry, attempts and use time |
| `Session` | Signed-in devices | Stores SHA-256 of the cookie token; `expiresAt` slides with use; `revokedAt` ends it everywhere |
| `Profile` | Name, picture, bio, country, city, language, time zone | All optional except the display name |
| `AuditLog` | Security and admin actions | Who, what, which record, IP, user agent, details; written by the API, never edited |

## Content

`Channel` (unique `handle`, one per user), `Video` (status, visibility, publish time, counters), `VideoRendition` and `VideoFile` (phase 2), `Category`, `Tag`/`VideoTag`, `Subscription` (unique per user and channel), `Like`, `Comment` (threaded), `Playlist`/`PlaylistItem`, `WatchHistory`.

Only videos with `status = READY`, `visibility = PUBLIC` and a `publishedAt` appear in feeds and search. Unlisted videos open by link; private ones only for their owner.

## Advertising and money (phases 4 and 5)

`Advertiser`, `Campaign` (budget, currency, target countries as a GIN-indexed array, empty meaning worldwide), `CampaignCategory`, `AdImpression`, `AdEvent`, `CreatorEligibility`, `CreatorBalance`, `RevenueLedger`, `Payout`.

Rules the code will enforce:
- Amounts are integers in the currency's minor unit (`BigInt`), never floats.
- A balance changes only through a ledger entry tied to verified revenue or a recorded, audited adjustment.
- Each ledger entry stores the split in force (`splitBps`, e.g. `6000/3000/1000`), so changing the split never rewrites history.
- `packages/shared/src/revenue.ts` holds the split and pool-allocation maths (parts always sum to the whole; tested).

## Indexes and pagination

- Feeds use keyset pagination on (`publishedAt`, `id`) with the existing `Video` indexes; there is no `OFFSET` on large tables.
- Lookups by unique keys: `User.email`, `Channel.handle`, `Session.tokenHash`, `OAuthAccount (provider, providerAccountId)`.
- `EmailOtp (email, createdAt)` finds the latest code; `Session (userId, revokedAt)` lists a user's devices.
- Views and watch time (phase 3) will be counted in Redis and written to PostgreSQL in batches, so a popular video does not mean one database write per view.

## Expired rows

Expired sign-in codes and sessions stay until a cleanup job removes them (phase 2 adds scheduled jobs). They are already ignored by every query.

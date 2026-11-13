# Database

PostgreSQL 16 through Prisma 6. The schema is `prisma/schema.prisma`; every change ships as a migration in `prisma/migrations` and is applied with `npx prisma migrate deploy` (never `db push` against a real database). CI checks that the migrations rebuild exactly the schema (`prisma migrate diff --exit-code`).

## Migrations

| Migration | What it does |
| --- | --- |
| `20261104000000_initial` | All platform tables: users, profiles, channels, videos, renditions, files, categories, tags, subscriptions, likes, comments, playlists, watch history, advertisers, campaigns, ad impressions and events, creator eligibility, balances, revenue ledger, payouts, reports, moderation actions, audit log |
| `20261106000000_video_pipeline` | Storage keys instead of URLs (`hlsMasterKey`, `thumbnailKey`, rendition `playlistKey`), processing progress, stage and error, media location (public or private prefix), thumbnail choices, size and dimensions, audience flag (`madeForKids`), upload id; feed and channel indexes |
| `20261108000000_user_interests` | `UserInterest`: the topics a person picked for their For you home |
| `20261107000000_engagement_and_trust` | Dislike count (private to the creator), comments switch, removal fields on videos; comment reply counts, edits and soft removal; collection kind (`SAVED` or `CUSTOM`, private by default); copyright notice and counter-notice fields, timestamp and decision on reports; video on moderation actions and the `VIDEO_RESTORED` action |
| `20261210000000_ai_moderation` | `Video.safetyDecision` (publish, limit or reject), `safetyReason` (shown to the creator), `safetyModel`, `safetyLimitedAt` (by link only, out of feeds and search; indexed), `appealedAt` (one appeal per video). Keys from Administration → Secrets are stored encrypted in `AppSetting` (`secrets`) |
| `20261209000000_safety_check` | `Video.safetyCheckedAt` (empty until the automatic safety check passes; existing videos count as checked), `Report.priority` (queue order), `SafetyTerm` (words moderators add per language and category) |
| `20261208000000_per_title` | `Video.encodeCrf` (the per-title CRF), `VideoRendition.peakKbps` and `averageKbps` (measured, declared in the master playlist) |
| `20261207000000_qoe_hourly` | `QoeHourly`: playback quality counted per hour, country, codec, device and connection (no viewer or video) |
| `20261206000000_search_fulltext` | A GIN index on the full-text expression search matches (title and description), so a search never reads every video (Prisma does not model expression indexes; `migrate diff` ignores it) |
| `20261205000000_recommendations_setting` | `Profile.personalizedRecommendations` (default on): whether For you may use what the person watches and likes |
| `20261204000000_counter_flush` | `CounterFlush`: batches of counted views and watch time already written, recorded in the same transaction, so a batch retried after a worker crash is never added twice (rows older than a week are deleted) |
| `20261203000000_av1_renditions` | `VideoRendition` unique on (`videoId`, `resolution`, `codec`) instead of (`videoId`, `resolution`), so a quality can exist in H.264 and AV1; `Video.av1QueuedAt` (when its AV1 renditions were queued) with an index on (`av1QueuedAt`, `viewCount`). Existing rows are all `h264` (the column's default), so nothing needs a backfill |
| `20261130000000_live_settings` | `LiveStream` description, visibility, planned start, chat mode and slow mode, live captions switch, and replay settings (keep it, and its first visibility) |
| `20261129000000_business_verification` | `BusinessVerification` (a business's checked details, status and badge end date) and payment purpose `VERIFICATION` |
| `20261128000000_plans` | Payment purposes `PLUS` and `FAMILY`; `User.plusUntil`, `familyUntil`, `familyOwnerId` (Family & TV members); `VideoDailyStat.plusWatchSeconds`; subscription pool columns on `AdDaySettlement` |
| `20261127000000_creator_pass` | `User.creatorPassUntil`, `Channel.uploadCount` (uploads ever started, filled for existing channels), payment purpose `CREATOR_PASS` |
| `20261126000000_review_hold` | `Video.reviewHoldAt`: hidden until a moderator reviews it, after reports from several established accounts |
| `20261125000000_recommendations` | Index on `WatchHistory` (`videoId`, `lastWatchedAt`): the latest viewers of a video, for "people who watched this also watched" |
| `20261124000000_cost_controls` | `Video.hdPending` (1080p and above wait for viewers) with an index on (`hdPending`, `viewCount`), `Video.hlsFullMasterKey` (every quality, for Premium viewers and owners), `Campaign.deliverUntil` (make-good period of campaigns priced per 1,000 views) |
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

`Channel` (unique `handle`, one per user), `Video` (status, visibility, publish time, counters, processing state, media location), `VideoRendition` (one per quality and codec, H.264 or AV1: size, bitrate, codecs, playlist key), `VideoFile` (the uploaded source), `Category`, `Tag`/`VideoTag`, `Subscription` (unique per user and channel), `Like`, `Comment` (threaded), `Playlist`/`PlaylistItem`, `WatchHistory`.

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
- Views and watch time are counted in Redis and written to PostgreSQL in batches every 15 seconds, so a popular video does not mean one database write per view.
- Media files are not in the database: rows store storage keys; links (CDN or signed) are made when serving.

## Expired rows

Expired sign-in codes and sessions stay until a cleanup job removes them (phase 2 adds scheduled jobs). They are already ignored by every query.

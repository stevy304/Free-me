# Free Me production roadmap

Initial market: Rwanda. The product will give viewers an easy path from discovery to playback on mobile and desktop, and give creators a reliable path from upload to earnings. The target of 50,000 registered users is a planning assumption. Concurrent capacity must be measured separately.

## Current repository

| Area | What exists | Production gap |
| --- | --- | --- |
| Web | Vite and React with viewer, channel, Shorts, studio and admin screens | Shared backend state, real identity, responsive and accessibility verification |
| Data | Prisma schema and browser-side fixtures | PostgreSQL migrations, deployed database and persistent API |
| Video | Sample MP4 playback, upload UI and FFmpeg shell script | Durable uploads, worker orchestration, adaptive playback and access control |
| Finance | Revenue arithmetic and demo balances, campaigns and payout controls | Verified events, ledger persistence, payment provider integration and reconciliation |
| Operations | Caddy example and architecture documents | Reproducible staging, telemetry, restoration drills, load tests and rollout |

Keep the existing UI as the product reference. Use the proposed Next.js web app and NestJS REST API for the production path. PostgreSQL and Prisma own account and business state. Redis and BullMQ coordinate background media jobs. S3-compatible storage holds uploads and renditions, and a CDN serves approved HLS assets. Treat the current four-server design as a deployment proposal to validate against staging measurements.

## Milestones and exit criteria

| Phase | Work | Evidence required to close |
| --- | --- | --- |
| 1. Foundation | Reproducible build and tests, migrations, API, registration, verification, login, reset, secure sessions, profiles and shared design components | Fresh database bootstraps from migrations. Two browsers share persisted profiles. Expired or revoked sessions and unauthorized role access fail server-side. Build and auth tests pass. |
| 2. Upload and playback | Signed multipart uploads, private source storage, queue, FFmpeg renditions and thumbnails, watch page, captions and low-bandwidth playback | A real upload survives interrupted transfer and worker retry, becomes playable via adaptive HLS on Safari and Chromium, and honors private access across manifests and segments. |
| 3. Discovery and community | Channels, subscriptions, threaded comments, search and autocomplete, Shorts, themes and responsive navigation | Two accounts can interact across sessions. Search respects visibility. Core viewer flows pass on small phones and desktops with keyboard and screen reader coverage. |
| 4. Creator and advertiser studios | Video management, campaign review, targeting, verified impression ingestion and revenue ledger | Replayed events cannot credit twice. Spend respects budgets. Revenue balances reconcile to the configured split and are visible to authorized users only. |
| 5. Trust, payouts and analytics | Report queues, moderation, audit trails, analytics, sandbox payout adapters and reconciliation | Duplicate or reordered callbacks preserve ledger consistency. Payout failures recover cleanly. Moderation actions are traceable and restricted. |
| 6. Staging and release | Hetzner deployment, CDN, dashboards and alerts, backups, restore and rollback drills, load tests and rollout | Record API latency, playback startup and buffering, upload and transcode throughput, and resource use at 100, 500 and 1,000 concurrent viewers. Document target thresholds, restoration results and rollback evidence before public launch. |

Phase 1 is in progress. Later phases have prototype screens or design documents where indicated above. Each milestone closes only after its exit criteria have been exercised and recorded. Paid infrastructure, live payout credentials and public deployment require separate authorization.

## Configuration inventory

The current prototype starts without backend secrets. Phase 1 needs a PostgreSQL connection string, session configuration, allowed web origin and email delivery configuration. Phase 2 adds Redis, object storage endpoint, region, bucket and credentials, plus the CDN base URL and media worker limits. Keep production values in the deployment secret store. Track exact variable names as services consume them, with examples in [ENVIRONMENT.md](ENVIRONMENT.md).

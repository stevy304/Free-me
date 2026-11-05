# Roadmap

Initial market: Rwanda; the platform serves every country from day one (languages, countries, currencies, time zones are data). The target of 50,000 registered users is a planning figure; concurrent capacity is measured, not assumed.

| Phase | Work | Evidence required to close | State |
| --- | --- | --- | --- |
| 1. Foundation | Monorepo, schema and migrations, sign-in with Google and email codes, sessions, roles, profiles, channels, design system, home page | Fresh database bootstraps from migrations; two browsers share persisted profiles; revoked sessions and wrong roles fail server-side; build, API and browser tests pass in CI | **Done** |
| 2. Upload and playback | Resumable uploads to object storage (the earlier local prototype, `prototypes/video-backend.mjs` in commit fa7e647, is the starting reference), BullMQ queue, FFmpeg renditions and thumbnails on the media node, watch page, captions, private-media access | An upload survives an interrupted transfer and a worker retry, plays via adaptive HLS on Safari and Chromium, and private manifests and segments refuse other viewers | **Done**, except captions (moved to phase 3) and playback checks in real Safari and Chrome (the test browser has no H.264; the stream is verified with FFmpeg) |
| 3. Discovery and community | Comments, likes, watch history, playlists, captions, recommendations, better search | Two accounts interact across sessions; search respects visibility; core flows pass on small phones and desktops with keyboard and screen reader | |
| 4. Creator and advertiser studios | Creator Studio, advertiser accounts and campaigns, verified impression ingestion, revenue ledger | Replayed events cannot credit twice; spend respects budgets; balances reconcile to the configured split | |
| 5. Trust, payouts and analytics | Reports and moderation, copyright workflow, age-appropriate controls, payout adapters per country, analytics | Duplicate or reordered payment callbacks keep the ledger consistent; moderation actions are traceable | |
| 6. Staging and release | Hetzner rollout, CDN, monitoring and alerts, backups and restore drill, load tests at 100/500/1,000 concurrent viewers | Recorded latency, playback start, upload and transcode throughput and resource use; restore and rollback evidence | |

Paid infrastructure, live payment credentials and public deployment each need explicit authorization.

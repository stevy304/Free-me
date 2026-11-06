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
| `channels` | Channels, handles, following |
| `engagement` | Likes, comments, watch history and resume, collections |
| `trust` | Reports, copyright notices, counter-notices, the moderation queue, strikes |
| `catalog` | Categories, feeds, watch page data, search and suggestions |
| `admin` | Accounts, roles, suspension, audit log (administrators only) |
| `videos` | Uploads, Creator Hub (my videos), playback playlists for private media, view reporting, local storage stand-in |
| `media` | Storage drivers (S3 and local), rendition ladder, FFmpeg processing, jobs, view counting; shared with the worker |
| `health` | Liveness and dependency status for the load balancer |

Request pipeline: Helmet headers → cookie parser → session middleware (attaches the account) → origin guard (state-changing requests must come from the web app) → auth/role guard (routes marked `@RequireAuth`) → validation pipe (unknown fields rejected) → controller → error filter (known errors keep their message; anything else is logged and answered with a generic 500).

## Web structure (apps/web/src)

- `components/shell`: top bar with search and suggestions, sidebar (full on wide screens, narrow rail on tablets, drawer on phones), bottom bar on phones, account menu with theme choice.
- `components/video`: cards, rows, the infinite grid, category chips.
- `app/*`: pages: home, Moments, Following, search results, watch (likes, save, share, report, comments, resume), channel (`/@handle`), create channel, Creator Hub (videos, removals and notices), History, Collections, Saved, Your reports, Moderation, legal pages (Terms, Privacy, Community Guidelines, Copyright and the notice form), settings, sign-in, You, administration.
- Navigation: no sidebar. A header with four tabs (For you, Following, Moments, Explore), the Find panel (`/` or Ctrl/Cmd+K) and the account menu; a floating dock on phones.
- Words: Space (channel), Tune in / Tuned in (follow), Spark (public like), Not for me (private dislike), Keep / Kept (save), Pass along (share), Conversation (comments), Trail (history), Keep watching (next videos).
- `components/icons`: the Free Me icon set, drawn for this app (24 px grid, 1.75 px rounded stroke; filled variants mark the current page). No third-party icon library.
- Old addresses redirect: `/shorts` → `/moments`, `/studio` → `/hub`, `/feed/subscriptions` → `/following`.
- Design tokens (light and dark) are CSS variables in `globals.css`; components never hard-code colours.

## Worldwide by design

Countries are ISO 3166-1 codes, languages BCP 47 tags, time zones IANA names, currencies ISO 4217 codes; names come from the runtime's Unicode data in the reader's language. Money is stored as integers in each currency's minor unit, and revenue maths never uses floating point. Nothing defaults to one country.

## Four-server topology (proposal to validate in staging)

| Server | Runs | Reachable from |
| --- | --- | --- |
| 1. Application node A | Caddy edge, API, web | Internet: 80/443 only |
| 2. Application node B | API, web | Private network only (from the edge) |
| 3. Database node | PostgreSQL, Redis, backups | Private network only (from servers 1, 2, 4) |
| 4. Media node | FFmpeg workers | Private network only |

Video files go to S3-compatible object storage and are delivered through a CDN; application disks never hold media. Firewall rules and private networking are in [DEPLOYMENT.md](DEPLOYMENT.md). Capacity claims (users, concurrent viewers) are made only after the load tests of phase 6.

## Video pipeline

```
Browser ──1. POST /api/uploads──────────────> API: creates a private draft video and an S3 multipart upload
        ──2. PUT parts (4 at a time) ───────> Object storage (presigned links; resumes after a lost connection)
        ──3. POST /api/uploads/:id/complete─> API: checks size, queues "transcode" (BullMQ on Redis)
Media worker: download source → ffprobe (rejects non-video) → 3 thumbnail frames
            → fast pass 144p/240p/360p → upload → video READY, playable ("SD ready")
            → full pass 480p…2160p (up to the source) → upload → master playlist rewritten ("Ready")
Viewer: CDN serves pub/<id>/hls/master.m3u8 and its fMP4 segments; private videos go through the API, which
        returns playlists whose segment links are signed for 4 hours.
```

- **One upload path for any size.** Parts of 16 MB go straight from the browser to storage, never through the API, so a 20 GB file costs the API a few small requests. Parts retry with backoff; choosing the same file after a closed tab continues where it stopped.
- **Fast first, then complete.** One FFmpeg decode feeds all rungs of a pass (split filter). The low pass finishes quickly, so viewers can watch while HD is still encoding; players pick up new renditions on their next playlist load.
- **Rendition ladder.** H.264 High (video only), 4-second fMP4 segments, keyframes every 2 seconds, capped CRF 21 (quality first, with a bitrate ceiling per rung), named by the short side so vertical video gets proper ladders. Never upscaled; 60 fps sources keep 60 fps with 1.5× bitrate.
- **One shared audio rendition.** AAC stereo 128 kb/s, encoded once with the first pass and referenced by every rung (`EXT-X-MEDIA`), so audio is stored once and more languages can be added later.
- **Same loudness everywhere.** Two-pass EBU R128 (`loudnorm`): measure, then one linear gain to −14 LUFS integrated, −1.5 dBTP, so viewers do not reach for the volume between videos.
- **HDR to normal colour.** Phone videos in HLG or PQ (BT.2020, 10-bit) are tone mapped once per pass (zscale + Hable) to BT.709 8-bit and tagged as such; thumbnails and previews too. Without this they play washed out and grey.
- **Safety check before publishing.** Every upload's SHA-256 and MD5 are recorded and compared with blocked fingerprints: those of videos moderators removed (added automatically on removal, so the same file cannot simply be uploaded again) and imported lists (`tools/import-hashes`). An optional outside scanner (`SAFETY_SCAN_URL`) receives sample frames for perceptual matching. A match stops processing: the video is `FLAGGED` ("being reviewed"), never public, and an automatic report opens in the moderation queue, where a moderator removes it or releases it (processing resumes, and it is not checked again). Accounts in their first week have a smaller daily upload limit.
- **Captions.** Creators upload WebVTT or SRT per language (cleaned to WebVTT, stored as `captions/<lang>.vtt` with the media, moved with it). With whisper.cpp configured, the worker also writes automatic captions after the video is ready (outside the video lock, so publishing never waits): speech is extracted at 16 kHz, Whisper uses the video's language or detects it, and the result is stored as `captions/<lang>.auto.vtt`. Uploaded captions always win. The player draws captions itself, above its controls.
- **Seek-bar previews.** Up to 100 small frames on one sprite sheet (`thumbs/storyboard.jpg`, keyframes only for videos over 10 minutes); the API serves the layout as WebVTT and the player shows the frame above the pointer.
- **Moments.** Vertical or square videos up to 3 minutes are marked as Moments automatically and appear in the Moments feed.
- **Removals.** A removed video gets `takenDownAt` and status `SUSPENDED`; feeds, search, playback and every interaction refuse it, the watch page answers 410 with the reason, and its media moves to the private prefix (also when it was still processing).
- **Visibility follows media.** Public and unlisted media live under `pub/` (CDN, cacheable for a year); private media under `prv/`. Changing visibility queues a `relocate` job that copies, switches, then deletes the old copy, so playback never breaks. Jobs on one video never overlap (Redis lock).
- **Deleting** removes the database row at once and queues a `purge` of every file. Uploads left unfinished for 3 days are cancelled hourly, and videos whose processing was interrupted (a restarted server) are queued again after 30 minutes.
- **Views.** The player reports a view after real watching (30 s, or half of a short video). The API de-duplicates per viewer for 6 hours in Redis and adds up views and watch time; the worker writes the totals to PostgreSQL every 15 seconds.
- **Processes.** The worker (`apps/api/src/worker.ts`) shares code with the API but runs on the media node. Several instances can run on several servers; failed jobs retry (transcode 3 times, others with backoff), and a file that is not a video fails at once with a clear reason shown in Studio.

## Coming in later phases

- **Phase 3:** comments, likes, watch history, playlists, captions (WebVTT), recommendations beyond "latest".
- Optional AV1/VP9 renditions for smaller files on modern devices, once the extra encoding time is worth it.

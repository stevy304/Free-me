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
        ──2. PUT parts (adaptive parallelism) ───────> Object storage (presigned links; resumes after a lost connection)
        ──3. POST /api/uploads/:id/complete─> API: checks size, queues "transcode" (BullMQ on Redis)
Media worker: download source → ffprobe (rejects non-video) → 3 thumbnail frames
            → first rendition (up to 360p) → upload → video READY, playable
            → remaining rungs through 720p → 1080p and above → seek previews
Viewer: CDN serves pub/<id>/hls/master.m3u8 and its fMP4 segments; private videos go through the API, which
        returns playlists whose segment links are signed for 4 hours.
```

- **One upload path for any size.** Parts go directly to object storage. The default is 16 MiB and new uploads of at least 4 GiB use at least 64 MiB per part. Parts retry with backoff; choosing the same file after a closed tab continues where it stopped.
- **Fast first, then complete.** One FFmpeg decode feeds all rungs of a pass (split filter). The low pass finishes quickly, so viewers can watch while HD is still encoding; players pick up new renditions on their next playlist load.
- **Popularity-based encoding.** 1080p and above are left out until a video has `HD_MIN_VIEWS` views (default 100) or its creator is a Premium member; the video is marked `hdPending`, and the worker's `hd-upgrades` check (every minute) queues an `upgrade` job that encodes only the rungs not yet published. Most uploads are rarely watched, so their most expensive encodes and storage are never paid for.
- **Per-title encoding.** Before the higher qualities are encoded (in the background job, so the first playable version is not delayed), three 2-second samples at the 720p rung are encoded at CRF 21, 23 and 25 and compared with the original (SSIM). The highest CRF within 0.004 of CRF 21 is kept for the whole video (`Video.encodeCrf`), every rung and later passes (HD, AV1 with the same offset). Grainy or noisy videos, where SSIM cannot tell quality apart (under 0.95 at CRF 21), and videos under 6 seconds keep CRF 21. On the test pattern: CRF 25, 36% fewer bits at an SSIM change of 0.002; about 10 s of work per video (4 s when the first sample is grainy). `PER_TITLE_ENCODING=false` turns it off.
- **Honest bitrates in playlists.** Each rendition's busiest segment and average bitrate are measured from its files (`peakKbps`, `averageKbps`) and declared as `BANDWIDTH` and `AVERAGE-BANDWIDTH`, so players choose from what this video really needs rather than from the rung's ceiling.
- **AV1 for popular videos.** A ready video with a complete H.264 ladder that reaches `AV1_MIN_VIEWS` (default 500) gets an AV1 version of every rung (`av1` job, lowest priority in the background queue; the worker's `av1-upgrades` check every 5 minutes claims each video once with `av1QueuedAt`). SVT-AV1, capped CRF, a fixed 2-second keyframe interval with scene cuts off, `fast-decode` for phones that decode in software; files in `hls/av1-<rung>/` with the same segments and the same shared audio. Encoded from the original when it is kept, else from the best H.264 rendition; long videos in pieces on every worker like H.264. Encoding runs without the video's lock (making a video private never waits for it); only publishing takes it. The master playlists list both codecs under the same free-quality limit. Delivery is the largest cost at scale, so encoding a watched video once more pays for itself many times over: roughly a third fewer bytes per view for viewers who get AV1.
- **Which codec a viewer gets.** hls.js keeps to one codec per playback (it never switches mid-video) and drops renditions the browser cannot decode. The player asks the browser once (MediaCapabilities, 720p AV1) and prefers AV1 when it is decoded smoothly in hardware, or smoothly in software while data saver is on (a phone asking to save data, a slow connection, or the viewer's choice): the data matters more than the battery there. Everyone else stays on H.264. The quality menu and data saver only list the chosen codec's renditions. Safari plays HLS itself and picks AV1 only on devices that decode it in hardware.
- **Free and full playlists.** When a video has qualities above `FREE_MAX_QUALITY` (default 720p), `hls/master.m3u8` lists only those up to it and `hls/master-full.m3u8` (`hlsFullMasterKey`) lists every one. The watch page gives Premium members and the owner the full playlist; the API's private playlist route refuses it to everyone else.
- **Rendition ladder.** H.264 High (video only), 4-second fMP4 segments, keyframes every 2 seconds, capped CRF 21 (quality first, with a bitrate ceiling per rung), named by the short side so vertical video gets proper ladders. Never upscaled; 60 fps sources keep 60 fps with 1.5× bitrate.
- **One shared audio rendition.** AAC stereo 128 kb/s, encoded once with the first pass and referenced by every rung (`EXT-X-MEDIA`), so audio is stored once and more languages can be added later.
- **Same loudness everywhere.** Two-pass EBU R128 (`loudnorm`): measure, then one linear gain to −14 LUFS integrated, −1.5 dBTP, so viewers do not reach for the volume between videos.
- **HDR to normal colour.** Phone videos in HLG or PQ (BT.2020, 10-bit) are tone mapped once per pass (zscale + Hable) to BT.709 8-bit and tagged as such; thumbnails and previews too. Without this they play washed out and grey.
- **Safety check before publishing.** Every upload's SHA-256 and MD5 are recorded and compared with blocked fingerprints: those of videos moderators removed (added automatically on removal, so the same file cannot simply be uploaded again) and imported lists (`tools/import-hashes`). An optional outside scanner (`SAFETY_SCAN_URL`) receives sample frames for perceptual matching. A match stops processing: the video is `FLAGGED` ("being reviewed"), never public, and an automatic report opens in the moderation queue, where a moderator removes it or releases it (processing resumes, and it is not checked again). Accounts in their first week have a smaller daily upload limit.
- **Captions.** Creators upload WebVTT or SRT per language (cleaned to WebVTT, stored as `captions/<lang>.vtt` with the media, moved with it). With whisper.cpp configured, the worker also writes automatic captions after the video is ready (outside the video lock, so publishing never waits): speech is extracted at 16 kHz, Whisper uses the video's language or detects it, and the result is stored as `captions/<lang>.auto.vtt`. When the speech is not English, Whisper also translates it into English captions (`captions/en.auto.vtt`, `AUTO_CAPTIONS_ENGLISH`), so every video can be followed in English, live recordings included. Uploaded captions always win. The player draws captions itself, above its controls, in the size, background and colour the viewer chose (Subtitles → Caption style, remembered on the device).
- **Live settings and captions.** The host sets a description, who can find the stream (public: on Live and Upcoming; unlisted), a planned start, chat (everyone, followers only, off; slow mode), live captions and what happens to the recording (kept or not; private, unlisted or public). Chat rules are enforced on the socket (the host is exempt). Live captions come from the host's browser (Web Speech API, Chrome and Edge) as text over the socket (`live:caption`, host only, rate limited) and are shown over the picture with a CC switch.
- **Watching live.** The live player keeps the whole broadcast seekable (DVR: browser streams use an event playlist; nginx-rtmp keeps 6 hours), shows a red LIVE dot at the newest pieces and "Go to live" once a viewer is behind, and plays adaptive quality (browser streams: 360p and 720p). The host chooses the delay: normal (three 2-second pieces behind, about 10–15 s end to end) or low latency (browser streams cut 1-second pieces; the player stays two pieces behind and plays slightly faster to catch up, about 4–6 s). Chat, captions and polls travel over the socket, separately from the video, so they arrive at once.
- **Live polls.** The host asks a question with 2 to 4 answers; signed-in viewers vote once (a Redis set per poll, so every API server agrees); results go to everyone in the stream's room at most four times a second.
- **Seek-bar previews.** Up to 100 small frames on one sprite sheet (`thumbs/storyboard.jpg`, keyframes only for videos over 10 minutes); the API serves the layout as WebVTT and the player shows the frame above the pointer.
- **Moments.** Vertical or square videos up to 3 minutes are marked as Moments automatically and appear in the Moments feed.
- **Removals.** A removed video gets `takenDownAt` and status `SUSPENDED`; feeds, search, playback and every interaction refuse it, the watch page answers 410 with the reason, and its media moves to the private prefix (also when it was still processing).
- **Visibility follows media.** Public and unlisted media live under `pub/` (CDN, cacheable for a year); private media under `prv/`. Changing visibility queues a `relocate` job that copies, switches, then deletes the old copy, so playback never breaks. Jobs on one video never overlap (Redis lock).
- **Deleting** removes the database row at once and queues a `purge` of every file. Uploads left unfinished for 3 days are cancelled hourly, and the worker checks for missing jobs every five minutes. Uploads still waiting for processing become eligible after five minutes. Interrupted processing stages become eligible after 30 minutes. Redis keeps one queued or active transcode per video, and an active worker renews a one-minute processing lease.
- **Views.** The player reports a view after real watching (30 s, or half of a short video). The API de-duplicates per viewer for 6 hours in Redis and adds up views and watch time; the worker writes the totals to PostgreSQL every 15 seconds in three statements whatever the number of videos (per-day rows, video totals, Space totals), in one transaction that also records the batch in `CounterFlush`. A worker that stops mid-way leaves its claimed batch in Redis; the next flush takes it after two minutes, and a batch already written is only removed, never added twice.

## Playback quality (what viewers experience)

Every playback measures time to first frame, rebuffering (how often and how long), seconds played, the picture size shown, the codec and failures, and sends one small summary when the viewer leaves (and every 5 minutes of a long playback; `apps/web/src/lib/qoe.ts`). The API keeps nothing about the viewer: it adds the summary to counters in one Redis hash per hour, per country (from the CDN's `GEO_COUNTRY_HEADER`, else the profile), codec, device and connection (`media/qoe.ts`). The worker writes each finished hour to `QoeHourly` in one statement, exactly once, and exports the last hour per country and codec as Prometheus gauges with alerts (`ViewersRebuffering`, `SlowStart`, `PlaybackFailures`). Administration → Playback Health shows playbacks, first frame (median, 90th percentile), rebuffering ratio, share of playbacks that stopped, average picture and failures, overall and by country, codec, device or connection, for the last hour to 30 days. These are the numbers that say whether a change (AV1, per-title, a CDN) helped.

## Watching at scale

The video itself comes from the CDN. What reaches the servers while people watch is small and constant: every signed-in player saves its position every 15 seconds and reports watch time about every minute. At a million people watching at once that is roughly 70,000 requests a second. None of them costs a database round trip any more:

- **Resume positions** (`media/progress.ts`) go to Redis (the latest per viewer and video wins) and the worker writes everything pending every 15 seconds in multi-row statements of 2,000. The watch page and History read a position from Redis first, so it is exact before it is written; removing a video from History (or all of it) also drops pending and in-flight saves, so it does not come back. An older save never replaces a newer one, and saves for deleted videos or accounts are skipped.
- **The video's few facts** those endpoints check (`engagement/hot-video.ts`) are kept in each process for 10 seconds; 100,000 players of one video cause one query per process every 10 seconds instead of thousands a second. Only counting and positions use it; pages, playlists and comments read the database. Changes made through Creator Hub or moderation are forgotten at once on that process.
- **Sessions** (`auth/session-cache.ts`) are kept in each process for `SESSION_CACHE_SECONDS` (15). Every change to an account (roles, status, plans, family) and every sign-out calls `authChanged`, which every process hears over Redis (sent twice, two seconds apart, so a change inside a transaction is committed by the second). Expiry is checked on every request.

Measured with `deploy/loadtest/player-bench.mjs` (see [RESULTS.md](deploy/loadtest/RESULTS.md)): on one 4-core test machine, twice the requests per second with half the response time, and 92% fewer database transactions. What is left on the database grows with the number of distinct viewers, not with the number of requests, so API servers can be added in front of one database for much longer.
- **Processes.** The worker (`apps/api/src/worker.ts`) shares code with the API but runs on the media node. Several instances can run on several servers; failed jobs retry (transcode 3 times, others with backoff), and a file that is not a video fails at once with a clear reason shown in Studio.

## Discovery

The whole recommendation system (For you, Up next, Trending: signals, candidates, scoring, mix rules, cost at
scale and how to tune it) is described in [ALGORITHM.md](ALGORITHM.md).

- **Next** (`/api/videos/:id/next`): same Space, shared tags and topic, the viewer's topics, popularity and freshness, plus **watched together**: among the latest 500 signed-in viewers of the video, the other videos at least 3 of them watched. A count shared by fewer than 3 people is never used, so no one's own history can be read from it.
- **Trending** (`/api/feed/rising?country=RW`, and the home page's Trending shelf): videos of the last 30 days ranked by views in the last two days (`VideoDailyStat`), so a video rising now beats last month's hit. With a country, only creators who chose that country. The home page shows the viewer's country when it has at least 4 such videos, else everywhere.
- **For you** (`/api/feed/for-you`, on the home page) ranks for each viewer from what they watch, like and follow, with the reason on every card; it can be turned off in Settings. See ALGORITHM.md.

## Coming in later phases

- **Phase 3:** comments, likes, watch history, playlists, captions (WebVTT), recommendations beyond "latest".

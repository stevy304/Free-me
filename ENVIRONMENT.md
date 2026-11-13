# Environment variables

Values for local development are in [.env.example](.env.example). In production every Free Me service on a server reads `/etc/freeme/freeme.env` (owner root, group `freeme`, mode 640; template: `deploy/ubuntu/freeme.env.example`). The API checks them at start-up and stops with a clear message if something required or unsafe is set.

## API (apps/api)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `production` turns on the strict checks below |
| `PORT` | | `4000` | Listening port |
| `API_PROCESSES` | | `1` | API processes sharing the port; `auto` = one per CPU core (a Node process uses one core). Set `auto` on app servers |
| `FEED_CACHE_SECONDS` | | `60` (`0` in tests) | How long parts of the home page and Rising that are the same for everyone are reused. New videos appear on the home page within this time |
| `SESSION_CACHE_SECONDS` | | `15` (`0` in tests), at most `60` | How long each API process keeps a signed-in session and its account, so requests do not each read them from the database. Sign-outs, suspensions, role and plan changes are announced to every process over Redis and seen at once; this is only the longest a change could lag if such a message were lost. `0` reads them on every request |
| `DATABASE_URL` | yes | | PostgreSQL connection string (private address of server 3) |
| `REDIS_URL` | production | | Redis: shared rate limits, the video job queue and view counting. Without it (development only) limits are per process and the API processes uploads itself |
| `APP_URL` | production | `http://localhost:3000` | Public origin of the web app, e.g. `https://freeme.example`. Must be https in production |
| `EXTRA_ORIGINS` | | | Other web origins allowed to send changes (comma-separated) |
| `SESSION_SECRET` | production | development value | 32+ random characters (`openssl rand -base64 48`). Keys code hashes and the OAuth state cookie. Changing it invalidates pending codes and Google sign-ins in progress (not sessions) |
| `SESSION_TTL_DAYS` | | `30` | Session lifetime, sliding, 1–90 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | | OAuth client ("Web application"). Authorised redirect URI: `${APP_URL}/api/auth/google/callback`. Easier: set them in the app, **Administration → Sign-in** (stored encrypted; what is saved there wins), which also shows the exact addresses to give Google. Logo for Google's consent screen: `apps/web/public/brand/free-me-logo-120.png` |
| `MAIL_TRANSPORT` | | `console` (dev), `smtp` (prod) | `smtp`, `console` (prints codes in the log) or `memory` (tests). Production requires `smtp` |
| `MAIL_FROM` | production | | Sender, e.g. `Free Me <no-reply@freeme.example>` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | with smtp | port 587 | Mail provider credentials (`SMTP_SECURE=true` or port 465 for implicit TLS) |
| `ADMIN_EMAILS` | | | Addresses that get the administrator role when they sign in |
| `LEGAL_OPERATOR_NAME` | | `Free Me` | The person or company that runs the service, named in the Terms, Privacy Policy and notices |
| `LEGAL_CONTACT_EMAIL` | | | Contact address shown on the legal pages (privacy requests, account closure) |
| `COPYRIGHT_EMAIL` | | `LEGAL_CONTACT_EMAIL` | Where copyright notices and counter-notices can also be sent; named in counter-notice emails |
| `LEGAL_POSTAL_ADDRESS` | | | Postal address for legal notices |
| `LEGAL_JURISDICTION` | | | Country whose law governs the Terms, e.g. `Rwanda` |
| `TRUST_PROXY` | | `1` in production | Number of proxies in front of the API |
| `API_DOCS` | | on outside production | `true` serves OpenAPI at `/api/docs` |
| `LOG_FORMAT` | | `json` in production, `text` otherwise | `json`: one JSON object per line (API and worker), with a request id per HTTP request; `text`: readable lines |

## Video storage and processing (API and worker)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `STORAGE_DRIVER` | production: `s3` | `local` outside production | `s3`: S3-compatible object storage. `local`: a folder (development and tests) |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | with s3 | region `us-east-1` | Bucket and keys (e.g. Hetzner Object Storage: `https://fsn1.your-objectstorage.com`, region `fsn1`) |
| `S3_FORCE_PATH_STYLE` | | `true` | `false` for providers that need virtual-hosted URLs |
| `MEDIA_PUBLIC_BASE_URL` | with s3 | local: `${APP_URL}/api/storage/local/pub` | CDN address of the bucket's `pub/` prefix, e.g. `https://media.freeme.example/pub` |
| `LOCAL_STORAGE_DIR` | | `./.data/storage` | Folder for the local driver |
| `MAX_UPLOAD_MB` | | `20480` (20 GB) | Largest upload |
| `UPLOAD_PART_MB` | | `16` | Base upload part size in MiB (5 or more). New S3 uploads of at least 4 GiB use at least 64 MiB per part. |
| `SCRATCH_DIR` | | `/tmp/freeme-scratch` | Worker's working folder (source and renditions while processing): put it on a fast local disk with room for the largest uploads |
| `METRICS_TOKEN` | | none | 24+ random characters (`openssl rand -hex 24`). Turns on `/api/metrics` and the worker's metrics port for Prometheus, which sends it as `Authorization: Bearer …`. Without it both are off. See [MONITORING.md](MONITORING.md) |
| `WORKER_METRICS_PORT` | | none | Port where each worker serves `/metrics` (e.g. `9464`; one port per worker process). Needs `METRICS_TOKEN` |
| `WORKER_METRICS_HOST` | | `127.0.0.1` | Address that port listens on: the media node's private address when Prometheus runs on another server |
| `WORKER_CONCURRENCY` | | `2` | Foreground jobs, including first-playable video processing, per worker instance |
| `WORKER_UPGRADE_CONCURRENCY` | | `1` | Background quality upgrades and caption backfills per worker instance |
| `TRANSCODE_PRESET` | | `veryfast` | x264 preset: faster = quicker processing, slightly larger files |
| `TRANSCODE_PRESET_HIGH` | | `superfast` | x264 preset for 1080p and above (the rungs that cost the most CPU); `veryfast` for slightly smaller files, slower |
| `CHUNKED_ENCODING` | | `true` | Encode long videos in pieces that every worker server takes from a shared queue (more media servers = long videos ready sooner). `false`: one run per pass, as before |
| `CHUNK_MIN_SECONDS` | | `120` | Videos at least this long are encoded in pieces |
| `CHUNK_SECONDS` | | `30` | Length of one piece (rounded to an even number, so keyframes stay on the 2-second grid) |
| `CHUNK_CONCURRENCY` | | `1` | Pieces one worker instance encodes at once (x264 already uses every core, so 1 is right for most servers) |
| `NODE_NAME` | | the host name | Name of this media server. Pieces encoded on the server that planned the work skip object storage; set it only if two servers share a host name |
| `HD_MIN_VIEWS` | | `100` | Popularity-based encoding: 1080p and above are made only once a video has this many views (checked every minute by the worker). Premium creators' uploads get them at once. `0` makes every quality straight away |
| `FREE_MAX_QUALITY` | | `720` | Highest quality free viewers get (`144`, `240`, `360`, `480`, `720`, `1080`, `1440` or `2160`); Premium members and the video's owner get every quality. `0` = no limit. Applies to videos processed after it is set. It saves delivery cost, it is not protection: the higher-quality files of public videos are still on the CDN |
| `SOURCE_RETENTION_DAYS` | | `0` (keep) | Delete a ready video's original upload after this many days, keeping its renditions. Originals are often the largest file, so this can cut storage a lot. A video that has not reached `HD_MIN_VIEWS` by then keeps up to 720p for good, and the original cannot be used again (for example for new formats later). Try `90` once you are sure |
| `AV1_MIN_VIEWS` | | `500` | AV1 renditions for popular videos: once a ready video has this many views, the worker (every 5 minutes, most watched first) adds an AV1 version of every quality beside the H.264 ones. AV1 needs roughly a third fewer bytes for the same picture, for every later viewer whose device plays it well; other devices keep H.264. Several times slower to encode than H.264, so it is kept for videos that are watched. Needs an ffmpeg with `libsvtav1` (Ubuntu's has it); without it nothing is queued. `0` turns AV1 off |
| `AV1_PRESET` | | `8` | SVT-AV1 speed, `0` (slowest, smallest files) to `13` (fastest). Lower it when encoding capacity is spare: each step down saves a little more delivery for a lot more encoding time |
| `AV1_CRF` | | `32` | AV1 quality, `10`–`55` (lower is better and bigger). 360p and below use 2 less. Each rendition also has a bitrate ceiling of 65% of its H.264 one |
| `COPY_TOP_RUNG` | | `true` | Use the upload's own H.264 as the top quality when it is suitable (exact size, 8-bit, normal colour, keyframe at least every 4.5 s, bitrate viewers can stream): the most expensive encode is skipped. `false` always re-encodes |
| `VIDEO_ENCODER` | | `libx264` | `nvenc` (NVIDIA GPU) or `qsv` (Intel Quick Sync) for a media server with a GPU: several times faster. Falls back to `libx264` by itself if the GPU encoder fails |
| `FFMPEG_PATH`, `FFPROBE_PATH` | | `ffmpeg`, `ffprobe` | Binaries |
| `QUEUE_PREFIX` | | `fm` | Redis key prefix for the job queue |
| `WHISPER_CPP_PATH`, `WHISPER_MODEL` | | off | Automatic captions on the media server: the whisper.cpp program (e.g. `/opt/whisper.cpp/build/bin/whisper-cli`) and a model file (e.g. `ggml-small.bin`). Set both or neither. See DEPLOYMENT.md → Automatic captions |
| `AUTO_CAPTIONS_ENGLISH` | | `true` | With automatic captions: videos spoken in another language also get English captions (Whisper's translation). Use a multilingual model (not an `.en` one). `false` keeps only the spoken language |
| `WHISPER_THREADS` | | `4` | CPU threads for one transcription |
| `SAFETY_SCAN_URL` | | off | Optional outside matching service for uploads (e.g. a PDQ/TMK service such as Meta's Hasher-Matcher-Actioner behind a small adapter, or a vendor). Receives `POST { videoId, sha256, md5, durationSeconds, frames: [base64 JPEG] }`, answers `{ match: boolean, label? }` |
| `SAFETY_SCAN_TOKEN` | | | Sent as `Authorization: Bearer …` to the scanner |
| `SAFETY_SCAN_TIMEOUT_MS` | | `60000` | How long to wait for the scanner |
| `SAFETY_SCAN_FAIL_CLOSED` | | `false` | `true`: hold uploads when the scanner cannot be reached, instead of letting them through |
| `NEW_ACCOUNT_DAILY_UPLOADS` | | `5` | Uploads a day for accounts in their first week |
| `REPORT_HOLD_THRESHOLD` | | `5` | Reports from this many different accounts (each at least a day old) hide a video from everyone but its owner until a moderator decides; child-safety reports need only 2. `0` turns it off |

## Web (apps/web)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `API_INTERNAL_URL` | yes | `http://localhost:4000` | Where the web server reaches the API (`http://127.0.0.1:4000` on the same server) |
| `PORT`, `HOSTNAME` | | `3000`, `0.0.0.0` | Listening address of the standalone server |

## Database server (deploy/ubuntu/install.sh ROLE=db)

`PRIVATE_IP`, `DB_PASSWORD`, `REDIS_PASSWORD`, optional `APP_NODES` and `MEDIA_NODE`. Backups read `/etc/freeme/backup.env`: `DATABASE_URL`, `BACKUP_S3_URI`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, `BACKUP_KEEP_DAYS`.

## Edge (ROLE=edge)

`FREEME_DOMAIN`, `ACME_EMAIL`, `APP_NODES` (private addresses of servers 1 and 2), passed to Caddy through a systemd drop-in.

## Payments (API and worker)

Premium, ad campaigns and creator earnings are priced in US dollars. **The easiest way: Administration → Money → Payment settings**, in the app. There, administrators set the prices, switch on *Send money (manual)* (people pay to your MoMo, Airtel Money or bank account with a reference code, and you confirm each payment; no provider account needed), create MTN MoMo sandbox keys from a Collections subscription key in one click, or paste live MoMo and Flutterwave keys. Keys are stored encrypted with SESSION_SECRET. Settings saved in the app win over the variables below, which remain for servers configured from files. MONETISATION.md explains the numbers.

To make someone an administrator (everything, including every Premium feature such as Live Studio): `npm run make-admin -- someone@example.com`, or list the address in `ADMIN_EMAILS`. To make that account the platform's official Space too (verified badge): `npm run make-admin -- someone@example.com --space "Free Me" --handle freeme` (the person must have signed in once).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PREMIUM_PRICE_USD_CENTS` | | `1000` ($10) | Premium, per month |
| `CREATOR_PASS_PRICE_USD_CENTS` | | `200` ($2) | Creator pass per **year**: needed to upload after the free uploads. Premium includes it. Administrators can change it in the app |
| `CREATOR_FREE_VIDEOS` | | `3` | Uploads every Space gets before it needs the Creator pass; `0` = the pass from the first upload. Administrators can change it in the app |
| `PREMIUM_PRICE_BY_COUNTRY` | | `RW=414` | Premium (Pro) per month in some countries, in US cents: RW=414 is about RWF 6,000. People whose profile country is listed pay that price; everyone else pays `PREMIUM_PRICE_USD_CENTS`. Set it empty for one price everywhere. Administrators can change it in the app |
| `PLUS_PRICE_USD_CENTS`, `PLUS_PRICE_BY_COUNTRY` | | `300`, `RW=172` | Plus (no ads, every quality) per month: $3, about RWF 2,500 in Rwanda |
| `FAMILY_PRICE_USD_CENTS`, `FAMILY_PRICE_BY_COUNTRY` | | `1200`, `RW=621` | Family & TV per month: $12, about RWF 9,000 in Rwanda |
| `FAMILY_SEATS` | | `4` | People in a Family & TV plan, the holder included |
| `SUBSCRIPTION_CREATOR_SHARE_PERCENT` | | `50` | Share of Plus and Family money paid to monetised creators, by members' watch time |
| `CREATOR_PASS_VIDEOS_PER_YEAR` | | `50` | Uploads the Creator pass allows in any 365 days (Pro: no limit) |
| `AIRTEL_CLIENT_ID`, `AIRTEL_CLIENT_SECRET` | | none | Airtel Money Collections (Airtel Africa developer portal). Both or neither |
| `AIRTEL_BASE_URL` | | `https://openapiuat.airtel.africa` (sandbox) | `https://openapi.airtel.africa` when live |
| `AIRTEL_COUNTRY`, `AIRTEL_CURRENCY` | | `RW`, `RWF` | Where the Airtel Money account is |
| `AIRTEL_RATE_PER_USD` | | `MOMO_RATE_PER_USD` | RWF for one US dollar for Airtel charges |
| `AD_PRICE_PER_DAY_USD_CENTS` | | `300` ($3) | One day of an ad campaign |
| `AD_MIN_BUDGET_USD_CENTS` | | `700` ($7) | Smallest funds an ad can start with, and the smallest amount of **Add funds** for a running ad |
| `VERIFICATION_PRICE_USD_CENTS` | | `1000` ($10) | Verified business badge, per year, paid after an administrator approved the business |
| `AD_CPM_USD_CENTS` | | `100` ($1) | Price of 1,000 ad views. A paid day buys `AD_PRICE_PER_DAY_USD_CENTS × 1000 / AD_CPM_USD_CENTS` views at most (3,000 by default); views not delivered in the days bought keep running for as many days again. Administrators can change it in the app |
| `PAYOUT_MINIMUM_USD_CENTS` | | `1000` ($10) | Smallest withdrawal a creator can ask for |
| `MONETISE_MIN_WATCH_HOURS` | | `0` (none) | Watch hours a Space needs in the last 12 months to join monetisation. Watch time is counted by the player's heartbeats, checked against real time |
| `MONETISE_MIN_FOLLOWERS` | | `0` (none) | Followers a Space needs to join monetisation |
| `MOMO_SUBSCRIPTION_KEY`, `MOMO_API_USER`, `MOMO_API_KEY` | for MTN MoMo | off | MTN MoMo **Collections** product: the primary subscription key and the API user and key from momodeveloper.mtn.com (sandbox) or the MTN partner portal (live). Set all three or none |
| `MOMO_BASE_URL` | | `https://sandbox.momodeveloper.mtn.com` | Live: the address MTN gives you (e.g. `https://proxy.momoapi.mtn.com`) |
| `MOMO_TARGET_ENVIRONMENT` | | `sandbox` | Live: your market, e.g. `mtnrwanda` |
| `MOMO_CURRENCY` | | `RWF` | What MoMo charges in (the sandbox only accepts `EUR`) |
| `MOMO_RATE_PER_USD` | with MoMo, unless the currency is USD | | How many units of `MOMO_CURRENCY` make one US dollar, e.g. `1450`. Update it when the rate moves; charges are rounded up to a whole franc |
| `FLW_SECRET_KEY` | for cards | off | Flutterwave secret key (cards worldwide, and mobile money where Flutterwave offers it) |
| `FLW_WEBHOOK_HASH` | recommended with Flutterwave | | The "secret hash" set in the Flutterwave dashboard; the webhook is `https://<domain>/api/billing/webhooks/flutterwave` |
| `FLW_BASE_URL` | | `https://api.flutterwave.com` | |

## Live (API and worker)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LIVE_RTMP_URL` | for OBS / TV encoders | off (browser streaming only) | The address encoders publish to, shown in Live Studio, e.g. `rtmp://live.freeme.example/live` |
| `LIVE_RTMP_SECRET` | with `LIVE_RTMP_URL` | | 24+ random characters; the same secret is in nginx-rtmp's `on_publish` and `on_publish_done` addresses |
| `LIVE_RTMP_HLS_DIR` | on the media server, with RTMP | | nginx-rtmp's `hls_path` (with `hls_nested on`), e.g. `/var/lib/freeme/live`; the worker copies it to storage |

Browser streams need no setting. See DEPLOYMENT.md → Live streaming.

The worker checks pending payments every minute (MoMo approvals happen on the payer's phone), ends memberships and shares each finished day's ad revenue every 15 minutes.

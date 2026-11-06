# Environment variables

Values for local development are in [.env.example](.env.example). In production every Free Me service on a server reads `/etc/freeme/freeme.env` (owner root, group `freeme`, mode 640; template: `deploy/ubuntu/freeme.env.example`). The API checks them at start-up and stops with a clear message if something required or unsafe is set.

## API (apps/api)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `production` turns on the strict checks below |
| `PORT` | | `4000` | Listening port |
| `DATABASE_URL` | yes | | PostgreSQL connection string (private address of server 3) |
| `REDIS_URL` | production | | Redis: shared rate limits, the video job queue and view counting. Without it (development only) limits are per process and the API processes uploads itself |
| `APP_URL` | production | `http://localhost:3000` | Public origin of the web app, e.g. `https://freeme.example`. Must be https in production |
| `EXTRA_ORIGINS` | | | Other web origins allowed to send changes (comma-separated) |
| `SESSION_SECRET` | production | development value | 32+ random characters (`openssl rand -base64 48`). Keys code hashes and the OAuth state cookie. Changing it invalidates pending codes and Google sign-ins in progress (not sessions) |
| `SESSION_TTL_DAYS` | | `30` | Session lifetime, sliding, 1–90 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | | OAuth client ("Web application"). Authorised redirect URI: `${APP_URL}/api/auth/google/callback` |
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
| `UPLOAD_PART_MB` | | `16` | Size of each upload part (5 or more; at most 10,000 parts per file) |
| `SCRATCH_DIR` | | `/tmp/freeme-scratch` | Worker's working folder (source and renditions while processing): put it on a fast local disk with room for the largest uploads |
| `WORKER_CONCURRENCY` | | `2` | Videos one worker instance processes at once |
| `TRANSCODE_PRESET` | | `veryfast` | x264 preset: faster = quicker processing, slightly larger files |
| `TRANSCODE_PRESET_HIGH` | | `superfast` | x264 preset for 1080p and above (the rungs that cost the most CPU); `veryfast` for slightly smaller files, slower |
| `VIDEO_ENCODER` | | `libx264` | `nvenc` (NVIDIA GPU) or `qsv` (Intel Quick Sync) for a media server with a GPU: several times faster. Falls back to `libx264` by itself if the GPU encoder fails |
| `FFMPEG_PATH`, `FFPROBE_PATH` | | `ffmpeg`, `ffprobe` | Binaries |
| `QUEUE_PREFIX` | | `fm` | Redis key prefix for the job queue |
| `WHISPER_CPP_PATH`, `WHISPER_MODEL` | | off | Automatic captions on the media server: the whisper.cpp program (e.g. `/opt/whisper.cpp/build/bin/whisper-cli`) and a model file (e.g. `ggml-small.bin`). Set both or neither. See DEPLOYMENT.md → Automatic captions |
| `WHISPER_THREADS` | | `4` | CPU threads for one transcription |
| `SAFETY_SCAN_URL` | | off | Optional outside matching service for uploads (e.g. a PDQ/TMK service such as Meta's Hasher-Matcher-Actioner behind a small adapter, or a vendor). Receives `POST { videoId, sha256, md5, durationSeconds, frames: [base64 JPEG] }`, answers `{ match: boolean, label? }` |
| `SAFETY_SCAN_TOKEN` | | | Sent as `Authorization: Bearer …` to the scanner |
| `SAFETY_SCAN_TIMEOUT_MS` | | `60000` | How long to wait for the scanner |
| `SAFETY_SCAN_FAIL_CLOSED` | | `false` | `true`: hold uploads when the scanner cannot be reached, instead of letting them through |
| `NEW_ACCOUNT_DAILY_UPLOADS` | | `5` | Uploads a day for accounts in their first week |

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

Premium, ad campaigns and creator earnings are priced in US dollars. Turn on one or both payment methods; with neither, the Premium and Ads pages say payments are not set up. Prices are set by the operator (MONETISATION.md explains the numbers).

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PREMIUM_PRICE_USD_CENTS` | | `1000` ($10) | Premium, per month |
| `AD_PRICE_PER_DAY_USD_CENTS` | | `300` ($3) | One day of an ad campaign |
| `PAYOUT_MINIMUM_USD_CENTS` | | `1000` ($10) | Smallest withdrawal a creator can ask for |
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

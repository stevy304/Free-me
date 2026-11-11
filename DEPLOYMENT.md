# Deployment (Ubuntu 24.04, no containers)

Going live for the first time? Follow [LAUNCH.md](LAUNCH.md), which links back here.

Free Me runs as plain systemd services on Ubuntu servers. Nothing here has been provisioned yet. Buying servers or storage, pointing a domain and opening the platform to the public each need the owner's go-ahead.

## Servers

All servers join one private network (Hetzner vSwitch or Cloud Network), e.g. `10.0.1.0/24`.

| Server | Private IP | Runs | Install |
| --- | --- | --- | --- |
| 1. App node A | 10.0.1.10 | Caddy (HTTPS, load balancing), API, web | `ROLE=edge` |
| 2. App node B | 10.0.1.11 | API, web | `ROLE=app` |
| 3. Database node | 10.0.1.20 | PostgreSQL 16, Redis 7, nightly backups | `ROLE=db` |
| 4. Media node | 10.0.1.30 | FFmpeg workers (`freeme-worker@N`), local scratch disk | `ROLE=media` |
| Object storage | (service) | Video sources, renditions, thumbnails | `storage-setup.sh` |
| CDN | (service) | Serves the bucket's `pub/` prefix worldwide | provider console |

### Why object storage and a CDN for "big video storage"

Videos never sit on the application servers. An S3-compatible bucket grows without limits or disk planning, keeps three copies, and costs far less per terabyte than server disks. Hetzner Object Storage is the default choice next to Hetzner servers; MinIO on your own storage servers, Wasabi, Backblaze B2 or AWS S3 also work, because the code only speaks S3. A CDN (for example Bunny CDN or Cloudflare) in front of the bucket's `pub/` prefix caches segments close to viewers everywhere, so playback starts fast in Kigali and in Tokyo, and the servers carry almost no video traffic.

Rough storage per hour of 1080p video: about 3.5 GB of renditions plus the source.

## Firewall

`install.sh` enables `ufw` with default deny on every server and opens only:

| Server | From | Port |
| --- | --- | --- |
| 1 | internet | 80, 443/tcp, 443/udp |
| 1, 2 | app nodes | 3000 (web), 4000 (API) |
| 3 | app nodes and media node | 5432 (PostgreSQL), 6379 (Redis) |
| all | `ADMIN_SSH_FROM` (or anywhere, with a warning) | 22 |

PostgreSQL and Redis also bind only to localhost and the private address, require passwords (SCRAM for PostgreSQL), and the PostgreSQL account is limited to the private subnet in `pg_hba.conf`.

## First installation

Copy the repository's `deploy/ubuntu` folder to each server (or clone the repository), then:

1. **Server 3 (database):**
   `sudo ROLE=db PRIVATE_IP=10.0.1.20 DB_PASSWORD=… REDIS_PASSWORD=… ./install.sh`
   It installs and tunes PostgreSQL 16 (memory-based settings) and Redis (append-only, password, no eviction), creates the `freeme` database and role, and installs the nightly backup cron (fill `/etc/freeme/backup.env`).
2. **Object storage:** create a bucket and keys at your provider, then run
   `S3_ENDPOINT=… S3_BUCKET=freeme-media APP_URL=https://freeme.example AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… ./storage-setup.sh`
   It sets CORS (direct browser uploads, reading `ETag`), public read for `pub/` only, and cleans abandoned uploads after 7 days.
3. **CDN:** create a pull zone whose origin is the bucket's `pub/` prefix (`https://<endpoint>/<bucket>/pub`). Use its address as `MEDIA_PUBLIC_BASE_URL`.
4. **Configuration:** the first run of `ROLE=app|edge|media` creates `/etc/freeme/freeme.env` from `freeme.env.example` and stops. Fill it in (see [ENVIRONMENT.md](ENVIRONMENT.md)); the same file is used on servers 1, 2 and 4.
5. **Server 2:** `sudo ROLE=app PRIVATE_IP=10.0.1.11 ./install.sh`
6. **Database schema** (once, from server 2): `cd /opt/freeme/app && sudo -u freeme bash -c 'set -a; . /etc/freeme/freeme.env; set +a; npx prisma migrate deploy && npm run db:seed'`
7. **Server 1:** `sudo ROLE=edge PRIVATE_IP=10.0.1.10 FREEME_DOMAIN=freeme.example ACME_EMAIL=ops@freeme.example ./install.sh`. Caddy gets the TLS certificate once DNS points at server 1.
8. **Server 4:** `sudo ROLE=media PRIVATE_IP=10.0.1.30 WORKERS=2 ./install.sh`. Each worker instance transcodes `WORKER_CONCURRENCY` videos at once; about one instance per 8 CPU cores is a good start.
9. **Google sign-in:** add `https://freeme.example/api/auth/google/callback` as an authorised redirect URI.
10. **Check:** `https://freeme.example/api/health` shows `database: ok, redis: ok`; sign in, create a channel, upload a video, publish it, play it.

## Automatic captions

Captions are made on the media server with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (open source, no outside service, no per-minute fees). Configure Whisper on every media worker to generate captions without creator uploads. Existing ready videos with a retained source and no caption tracks are queued in small, lower-priority batches.

1. On each media server: `sudo apt-get install -y build-essential cmake git`, then
   `sudo git clone https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp && cd /opt/whisper.cpp && sudo cmake -B build && sudo cmake --build build -j --config Release`
2. A model: `sudo bash ./models/download-ggml-model.sh small` (multilingual; `base` is faster, `medium` more accurate). Model files are 0.1–1.5 GB.
3. In `/etc/freeme/freeme.env`: `WHISPER_CPP_PATH=/opt/whisper.cpp/build/bin/whisper-cli`, `WHISPER_MODEL=/opt/whisper.cpp/models/ggml-small.bin`, optionally `WHISPER_THREADS=4`; restart the workers.
4. `/api/admin/system` then shows `autoCaptions: true`. Transcription runs after a video is ready; on 4 cores, the `small` model takes roughly as long as the video, `base` about a third (estimates; measure on your hardware).

Payment receipts are sent by the worker using the configured SMTP transport. Apply the database migrations before restarting the API and worker. Only newly confirmed payments are queued for receipts.

## Services

| Unit | Server | Logs |
| --- | --- | --- |
| `freeme-api` | 1, 2 | `journalctl -u freeme-api -f` |
| `freeme-web` | 1, 2 | `journalctl -u freeme-web -f` |
| `freeme-worker@1..N` | 4 | `journalctl -u 'freeme-worker@*' -f` |
| `caddy` | 1 | `journalctl -u caddy -f` |
| `postgresql`, `redis-server` | 3 | `journalctl -u postgresql -f` |

Services run as the unprivileged `freeme` user with systemd hardening (read-only system, private `/tmp`, no privilege escalation) and restart automatically.

## Releasing a new version

1. CI green on `main`; tag the release (`v0.2.0`).
2. Server 2: `sudo FREEME_REF=v0.2.0 MIGRATE=1 ./release.sh` (migrations are additive and work with the version still running on server 1).
3. Server 1: `sudo FREEME_REF=v0.2.0 ./release.sh`. Caddy's health checks keep traffic on server 2 while server 1 restarts.
4. Server 4: `sudo FREEME_REF=v0.2.0 ./release.sh`. Interrupted transcodes are retried automatically.
5. Roll back by releasing the previous tag (and a written down-migration if the schema changed).

## Live streaming

Creators with a Space can broadcast for free at **Go Live** (`/go-live`). Premium members can also use **Live Studio** (`/studio/live`) for encoder keys, stream history, and integrated chat.

**From the browser** (camera or screen): nothing to install. The browser sends its recording over the socket to an
API server, which encodes it with ffmpeg into HLS (2-second segments, 720p, about 2.6 Mbit/s) and copies it to
storage as it grows; viewers play it from the CDN. Each browser stream uses about one CPU core on the API server
that receives it. Each API process defaults to three concurrent browser streams. Set `LIVE_BROWSER_LIMIT` to match the CPU available per process.

**Premium encoder streaming (RTMP):** install nginx with the RTMP module on the media server and let it
write HLS that the worker copies to storage. The encoder's key is checked by the API, and the stream is published
under the stream id, so the key never appears in any public address.

```bash
sudo apt install -y nginx libnginx-mod-rtmp
sudo mkdir -p /var/lib/freeme/live && sudo chown www-data:freeme /var/lib/freeme/live && sudo chmod 2775 /var/lib/freeme/live
```

Add to `/etc/nginx/nginx.conf` (outside the `http { }` block), with the API's private address and your secret:

```nginx
rtmp {
  server {
    listen 1935;
    chunk_size 4096;
    application live {
      live on;
      record off;
      allow play 127.0.0.1;
      deny play all;
      on_publish http://10.0.0.2:4000/api/live/rtmp/publish?secret=LIVE_RTMP_SECRET;
      on_publish_done http://10.0.0.2:4000/api/live/rtmp/done?secret=LIVE_RTMP_SECRET;
      hls on;
      hls_path /var/lib/freeme/live;
      hls_nested on;
      hls_fragment 2s;
      hls_playlist_length 6h;
      hls_cleanup off;
    }
  }
}
```

Then `sudo systemctl reload nginx`, open TCP 1935 in the firewall for encoders (and point a name such as
`live.freeme.example` at the media server), and set:

- on the application servers: `LIVE_RTMP_URL=rtmp://live.freeme.example/live` and `LIVE_RTMP_SECRET` (24+ random characters, the same as in nginx.conf);
- on the media server (worker): `LIVE_RTMP_HLS_DIR=/var/lib/freeme/live`.

Encoders send H.264 video and AAC audio as they are (no re-encoding), so one media server carries many RTMP
streams. Creators see the address and their key in Live Studio. When a stream ends, its recording becomes a
private video, processed like an upload; the creator publishes it as a replay from Creator Hub.

## Instant updates

The web app keeps one WebSocket per tab to `/api/socket` (socket.io). New comments, Sparks, notifications,
processing progress, payments, live chat and viewer counts arrive without refreshing. With several application
servers, Redis carries every update to every server, so no sticky sessions are needed (Caddy proxies WebSockets
as it is). The worker sends its updates (processing, payments) through Redis too.

## Scaling

- **More uploads at once:** add media servers (`ROLE=media`), all pulling from the same queue. Each runs `WORKER_CONCURRENCY` videos at a time (default 2; one per 2–4 cores). Uploads go straight from the browser to object storage in parts, so the application servers carry no upload traffic.
- **New uploads first:** processing is two jobs. The first makes a video playable (360p, thumbnails, seek previews); the second adds 480p and up at a lower priority, so a new upload never waits behind another video's 1080p or 4K. Measured with one busy worker: a second upload was playable after 13 s instead of about 55 s.
- **Long videos on several servers:** a video of 2 minutes or more is cut into 30-second pieces (`CHUNK_SECONDS`) on the `media-chunks` queue. Every media server takes pieces, so adding a server shortens long videos, not only the queue. Pieces made on another server travel through object storage under `tmp/chunks/` and are deleted when joined; add a lifecycle rule on the bucket that expires `tmp/` after 1 day, for pieces left by a crashed server. Background pieces (higher qualities) run at a lower CPU priority, so new uploads stay quick. Measured on one machine split into two 2-core "servers": a 150-second 1080p video was playable in 21 s instead of 33 s and fully ready in 100 s instead of 155 s; one server alone stays the same (157 s vs 155 s).
- **Smaller uploads from phones:** in browsers that can encode H.264 (Chrome, Edge, Safari 16.4+, Android), a video over 20 MB whose bitrate is well above what viewers need is first made smaller in the browser (1080p at 6 Mbps, keyframes every 2 s, sound copied), typically 2–5× less data to send. The server then copies that H.264 as the top quality instead of encoding it again. HDR videos, very long ones (more than about 450 MB after compressing), and browsers without an H.264 encoder upload the original, as before. The creator can choose "Upload the original instead" while it runs.
- **No re-encoding when not needed:** a suitable H.264 upload keeps its own top quality (`COPY_TOP_RUNG`). On a 60-second 1080p camera file the 1080p step went from 10.8 s to 0.6 s.
- **Fast start for viewers:** the first segments are 1 second long, the player downloads the first one while it sets up, the page opens its connection to the CDN early, and the start of the next video is loaded near the end of the current one. Caddy serves HTTP/3 by default (UDP 443 is open in the firewall).
- **Faster processing per video:** a video gets better in three steps: SD (144p–360p, watchable), then HD (480p, 720p), then 1080p and above. On 4 cores a 60-second 1080p video was playable after 14 s, in 720p after 29 s and in 1080p after 41 s. Processing time grows with length and with the number of cores: a server with twice the cores is about twice as fast, and a GPU (`VIDEO_ENCODER=nvenc` or `qsv`) is several times faster again. The worker log prints how long each step took. `TRANSCODE_PRESET` (default `veryfast`) and `TRANSCODE_PRESET_HIGH` (1080p+, default `superfast`) trade speed for file size.
- **More viewers:** almost all traffic is video segments from the CDN, which scales by itself. Add application servers behind Caddy for pages, the API and WebSockets; they share Redis and the database. Put PgBouncer in front of PostgreSQL when you pass a few hundred API connections, and a read replica when the database CPU stays above 60%.
- **Measure before you promise:** `deploy/loadtest/watch.js` (k6) ramps to a number of simultaneous viewers who open pages and play videos as a player would. Run it at 500, then 2,000, then your launch target, and add servers where it shows a limit.

**What "10 million users at the same time" needs.** That is the scale of the largest video platforms. It is reached
by adding servers and CDN capacity, not by changing this code: video comes from the CDN (pay per terabyte; at
3 Mbit/s, 10 million viewers move about 30 Tbit/s, which only the largest CDNs serve), and pages and the API need on
the order of hundreds of application servers and a sharded database. A sensible path: launch on the four servers
above (thousands of simultaneous viewers), load test, then grow server by server as real traffic arrives.

## Not yet covered (phase 6)

Monitoring and alerts (Prometheus, Grafana) and a central log store (logs are already JSON lines with request ids, and `/api/admin/system` reports health, queue and failures), staged load tests at 100, 500 and 1,000 concurrent viewers, and a recorded restore drill.

### Guest connections and browser production

Free Go Live supports a host and two invited guests. Premium Studio allows six guest seats and composites the selected scene, video transition, lower third, ticker and logo into the browser recording. The host's browser renders the Program feed. Keep its tab in the foreground during a show.

Browser broadcasts allow 30 seconds to reconnect on the same application server. The host tab keeps a bounded buffer of video and audio, and the watch page and chat stay open while the host reconnects. Route returning broadcaster sockets to the same server in a multi-server deployment because the active encoder runs there. Guest connections use their own signaling session and may need a new invite after the host reconnects.

Guests need an authenticated Free Me account and a private invitation link. Enable the Socket.IO Redis adapter for signaling across API nodes. Direct WebRTC connections use STUN by default. For networks that require relaying, set `LIVE_TURN_URLS` to your comma-separated coturn addresses and set `LIVE_TURN_SECRET` to the coturn `static-auth-secret` on each API node. The API signs temporary credentials. Keep the shared secret on the servers.

Browser composition applies to browser broadcasts. External encoders still supply their own composed program feed through Premium RTMP.

## Upload and playback timing

With JSON logging enabled, match the API and worker events by `videoId`.

| Event | What it measures |
| --- | --- |
| `upload_completed` | Browser bytes acknowledged and average bytes per second during active transfer runs, including signing and retry delays. Pauses, bytes resumed from an earlier tab, and server finalization are separate. `finalizeMs` measures server-side assembly and verification. |
| `transcode_started` | `queueWaitMs` measures time since enqueue. Use attempt 1 for initial queue wait. On later attempts the value includes earlier attempts and backoff. The inline development worker reports zero. |
| `video_first_playable` | `processingToPlayableMs` runs from worker processing start through publication of the first playable HLS renditions. The event also records download, probe, screening, thumbnail, loudness, SD encode, and SD publish timings. Thumbnail and loudness timings overlap. |
| `video_storyboard_ready` | `storyboardMs` measures generating seek previews after playback is available. |

The browser records the separate `free-me:play-to-playing` User Timing measure from the first play event to the first playing event for a source. Inspect it in the browser Performance panel. It measures viewer startup and stays in that browser.

Uploads start with four concurrent parts. On sufficiently large files, the browser samples acknowledged throughput, tries up to six, and returns to the previous setting if the gain is under 10%. Retries reduce concurrency to a minimum of two. Use the API's transfer rate, retries, and peak concurrency to compare similar file sizes and network conditions.

### Benchmark uploads while a 4K job is running

Use a development or staging instance with FFmpeg, Redis, a separate media worker, and `LOG_FORMAT=json` on the API and worker. Use an isolated creator account with a channel and room for four private uploads. Use fresh log files available to the machine running the benchmark.

Set `BENCH_ORIGIN` to the application origin, `BENCH_COOKIE` to that account's session cookie in `name=value` form, and `BENCH_API_LOG` and `BENCH_WORKER_LOG` to the JSON log paths. Keep the session cookie out of command history and reports.

```sh
npm run --silent bench:video -- phone-720p.mp4 video-1080p.mp4 long-video-2160p.mp4
```

The phone clip can be portrait with a 720-pixel short edge. The runner uploads the 4K file once to establish background load and again as a measured upload. Use a long enough 4K fixture that its upgrade is still running when the three measured uploads start. The four drafts stay private and can be removed from Creator Hub after the run. If the API is processing media inline, omit `BENCH_WORKER_LOG`; the reported queue wait is then zero by design.

The JSON output includes transfer throughput, finalization round trip, queue wait, SD encode time, and time until the first HLS segment is fetched. It also reports when 720p, the source resolution, and all qualities are visible in Creator Hub. The HLS and quality milestones are measured from the start of upload finalization with a 500 ms polling interval. The segment fetch checks the delivery path; it does not measure a browser decoding its first frame. Compare runs with the same fixtures, worker settings, and network conditions.

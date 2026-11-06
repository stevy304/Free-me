# Launch checklist

Everything Free Me needs before real people use it, in order. Tick each box; the commands and settings are in
[DEPLOYMENT.md](DEPLOYMENT.md) and [ENVIRONMENT.md](ENVIRONMENT.md). Items marked **(you)** need an account, a
payment or a decision only the operator can make.

## 1. Accounts and names (you)

- [ ] **Domain** registered, e.g. `freeme.example`, with DNS you can edit.
- [ ] **Servers**: four Ubuntu 24.04 machines as in DEPLOYMENT.md → Servers (one is enough to start: run `ROLE=db`, `app`, `edge` and `media` on the same machine).
- [ ] **Object storage** bucket (S3-compatible) and a **CDN** pull zone in front of its `pub/` prefix.
- [ ] **Email sending**: an SMTP provider for sign-in codes. Sign-in by email does not work without it.
- [ ] **Google Cloud** project for "Sign in with Google".

## 2. Install (DEPLOYMENT.md → First installation, steps 1–8)

- [ ] Database server (`ROLE=db`), with the nightly backup cron and `/etc/freeme/backup.env` filled in.
- [ ] Bucket set up with `storage-setup.sh`; CDN address in `MEDIA_PUBLIC_BASE_URL`.
- [ ] `/etc/freeme/freeme.env` filled in from `freeme.env.example`:
  - [ ] `SESSION_SECRET` = `openssl rand -base64 48` (keep it secret, never commit it)
  - [ ] strong `DB_PASSWORD` / `REDIS_PASSWORD`, private addresses only
  - [ ] `ADMIN_EMAILS` = your own address
  - [ ] `LEGAL_*` (operator name, contact and copyright email, postal address, jurisdiction)
- [ ] Schema: `npx prisma migrate deploy && npm run db:seed`. The migrations turn on the `pg_trgm` extension for search; it ships with PostgreSQL 16 on Ubuntu and the `freeme` database owner may enable it.
- [ ] App, edge (Caddy gets HTTPS once DNS points at it) and media servers installed.

## 3. Sign-in that reaches people

- [ ] **Email DNS** at your domain, as your SMTP provider tells you: **SPF**, **DKIM** and a **DMARC** record. Without them, codes land in spam.
- [ ] Send a code to a Gmail and an Outlook address; both arrive within a minute, not in spam.
- [ ] **Google**: OAuth client of type "Web application", redirect URI `https://<domain>/api/auth/google/callback`; OAuth consent screen with your logo, privacy and terms links (`/legal/privacy`, `/legal/terms`), then **publish** it (status "In production") so anyone can sign in.

## 4. Check it works (as an administrator)

- [ ] `https://<domain>/api/health` → `"database":"ok","redis":"ok"`.
- [ ] Open **Administration → Launch**: it checks this server live (https address, workers, email, storage, CDN, payments, Google sign-in, official Space, phone notifications) and says what to do for each item not ready.
- [ ] Make yourself administrator: `npm run make-admin -- you@example.com` (or `ADMIN_EMAILS`). In Administration → Money → Payment settings, switch on *Send money (manual)* with your MoMo number, and later MoMo or Flutterwave keys.
- [ ] Sign in with the `ADMIN_EMAILS` address, then open `https://<domain>/api/admin/system`: `"ok": true` and no warnings. It warns when email is not really sent, Google sign-in is missing, Redis is down, videos wait or fail.
- [ ] Create a Space, upload a video, add a custom thumbnail, publish **before** processing finishes, then check on another device: plays, thumbnail shows, search finds it (also with a typo), "Up next" lists it on other videos.
- [ ] Report a video as another account; see it in the moderation queue; remove and restore it.
- [ ] Phones: watch page, upload, sign in, on a real Android and iPhone.

## 5. Keep it running

- [ ] **Uptime monitor** (any external service) on `https://<domain>/api/health`, alerting you by email or SMS.
- [ ] **Logs**: production logs are one JSON object per line (`journalctl -u freeme-api -o cat`). Every answer carries an `X-Request-Id`; a "Something went wrong" answer shows it as `requestId`, so a user's report can be matched with `journalctl -u freeme-api -o cat | grep <id>`.
- [ ] **Backups**: run one restore drill (BACKUP-AND-RECOVERY.md) onto a spare database and open the site against it. A backup that was never restored is not a backup.
- [ ] **Disk and CPU** alerts on the media server (transcoding) and the database server.
- [ ] Look at `/api/admin/system` daily in the first weeks: queue waiting, stuck or failed videos, open reports.

## 6. Legal and trust (you)

- [ ] Terms, Privacy Policy, Community Guidelines and Copyright pages read by someone qualified for your country, with your `LEGAL_*` details shown.
- [ ] A real inbox for `COPYRIGHT_EMAIL` and `LEGAL_CONTACT_EMAIL`, checked daily; copyright notices answered promptly.
- [ ] Minimum age decided and stated in the Terms.
- [ ] At least one moderator account (Admin → roles) besides yourself.

## 6b. Safety of uploads (you)

- [ ] Apply for access to hash lists of known child sexual abuse material (NCMEC, the Tech Coalition, or a vendor). When granted, import them: `node dist/tools/import-hashes.js <file> "<list name>"` (in `apps/api`). Matching uploads are held for review.
- [ ] Optionally run a perceptual matching service (e.g. Meta's open-source Hasher-Matcher-Actioner with PDQ/TMK) and set `SAFETY_SCAN_URL`; consider `SAFETY_SCAN_FAIL_CLOSED=true` once it is reliable.
- [ ] Know your legal duty to report: in many countries, platforms must report child sexual abuse material to the authorities (in the US, to NCMEC). Write down who does this and how.

## 7. Before announcing it

- [ ] Load test with the expected first audience (DEPLOYMENT.md → Scaling) and decide how many media workers you need.
- [ ] Tag the release (`v1.0.0`) and deploy with `release.sh`.
- [ ] Submit `https://<domain>/sitemap.xml` in Google Search Console and Bing Webmaster Tools, and paste a video link into WhatsApp to check the preview card.

## Maintenance commands

| What | Command (on an app server, as `freeme`, with `/etc/freeme/freeme.env` loaded) |
| --- | --- |
| Find files a video left in the wrong storage place (report only) | `node dist/tools/repair-media.js` in `apps/api` |
| Repair them | `node dist/tools/repair-media.js --apply` (safe while the site runs; busy videos are skipped, run again later) |
| System status | `GET /api/admin/system` signed in as an administrator |
| Import a blocked-content hash list | `node dist/tools/import-hashes.js <file> "<list name>"` (MD5 or SHA-256, one per line) |
| Upgrade older videos (HDR colour, even volume, previews, captions) | `POST /api/admin/system/reprocess` with `{ "limit": 50 }`, repeated until `remaining` is 0 (check `videosNeedingUpgrade` on the status page) |

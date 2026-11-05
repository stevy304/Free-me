# Security

## Sign-in (no passwords)

- **Email one-time codes.** Six random digits (`crypto.randomInt`), valid for 10 minutes, five attempts, single use. The database keeps an HMAC-SHA-256 of the code keyed with `SESSION_SECRET` and bound to the address, so a database leak does not reveal usable codes. Comparison is constant-time; using a code is an atomic update, so two simultaneous requests cannot both succeed. A new request replaces older codes.
- **Google.** OpenID Connect authorization-code flow with PKCE (S256), a random `state` and `nonce` carried in a 10-minute HMAC-signed, HttpOnly cookie scoped to the callback path. The ID token's signature, audience and expiry are verified by `google-auth-library`; the email must be verified by Google. Accounts link by Google's stable subject id, then by verified email.
- **One account per email**, however the person signs in. Administrators are named only in configuration (`ADMIN_EMAILS`), never by a request.
- **Return paths** after sign-in must be same-site paths (`/watch?v=…`); full URLs and `//host` are replaced with `/`.

## Sessions

- A random 256-bit token in an HttpOnly, `SameSite=Lax` cookie: `__Host-fm_session` (Secure, host-only) over HTTPS. The database stores only its SHA-256.
- Sliding expiry (`SESSION_TTL_DAYS`, default 30). Sign-out, "sign out other devices" and administrator suspension revoke sessions immediately on every server.
- Suspended or deleted accounts cannot use existing sessions or sign in again.

## Request protection

- **CSRF:** every `POST`/`PATCH`/`DELETE` must come from the web app's origin (`Origin`, or `Referer`), on top of `SameSite=Lax` cookies.
- **Validation:** DTOs with `class-validator`; unknown fields are rejected; countries, languages, time zones and handles are checked against real lists; text lengths are capped.
- **Rate limits** (Redis, shared by all instances): sign-in codes 1 a minute and 5 an hour per address and 30 an hour per IP; code checks 60 an hour per IP; Google start 30 per 10 minutes per IP; channel creation and subscriptions per account.
- **Headers:** Helmet on the API; `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY` and `Permissions-Policy` on the web app; HSTS at the Caddy edge.
- **Errors:** unexpected errors are logged with their stack and answered with a generic message; nothing internal leaks to clients.
- **Proxies:** `TRUST_PROXY` tells the API how many proxies to trust for client IPs (1 behind Caddy).

## Uploads and media

- Uploads go straight to object storage through presigned part links that expire after an hour; the API checks the declared size, the assembled size and the file extension, and creators only (accounts with a channel) can upload, with daily and open-upload limits.
- The media worker identifies every file with `ffprobe` before processing; anything that is not a playable video fails with a clear message and is never published. FFmpeg runs as the unprivileged `freeme` user under systemd hardening.
- Custom thumbnails are accepted only as JPEG, PNG or WebP, checked by their bytes, up to 2 MB.
- Private videos live under a separate `prv/` prefix that is never public; they play only for their owner, through playlists whose segment links are signed for 4 hours. Public and unlisted videos live under `pub/`, the only prefix the bucket policy makes readable.
- The bucket allows browser access (CORS) only from the web app's origin.

## Authorization

Roles are a set on the account. `@RequireAuth()` and `@RequireAuth('ADMIN')` guard routes on the server; the web app hides what a role cannot use, but the API is the authority. Administrators cannot remove their own administrator role or suspend themselves.

## Audit log

Account creation, sign-in and sign-out, Google linking, profile and channel changes, session revocations, role changes, suspensions and configuration-granted administrator rights are recorded with actor, record, IP and user agent. Entries are never edited by the application.

## Secrets

No secrets in the repository. Production values (database and Redis passwords, `SESSION_SECRET`, Google and SMTP credentials) live in the deployment secret store and reach containers as environment files readable only by root (see [ENVIRONMENT.md](ENVIRONMENT.md)). The API refuses to start in production without HTTPS `APP_URL`, a real `SESSION_SECRET` and SMTP email.

## Still to do (tracked in ROADMAP.md)

Malware scanning of uploaded files beyond media identification, reporting and moderation queues, copyright workflow and age-appropriate controls (phase 5), dependency scanning in CI, and a penetration test before public launch. Every operating country's data-protection, consumer, advertising and payment rules are reviewed before launch there.

Report a vulnerability privately to the maintainers; do not open a public issue.

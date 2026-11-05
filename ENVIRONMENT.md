# Environment variables

Values for local development are in [.env.example](.env.example). In production they come from the deployment secret store as `api.env` (mode 600, owned by root) on each application node. The API checks them at start-up and stops with a clear message if something required or unsafe is set.

## API (apps/api)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `production` turns on the strict checks below |
| `PORT` | | `4000` | Listening port |
| `DATABASE_URL` | yes | | PostgreSQL connection string (private address of server 3) |
| `REDIS_URL` | production | | Redis for rate limits shared by all instances. Without it, limits are per process (development only; production health reports degraded) |
| `APP_URL` | production | `http://localhost:3000` | Public origin of the web app, e.g. `https://freeme.example`. Must be https in production |
| `EXTRA_ORIGINS` | | | Other web origins allowed to send changes (comma-separated) |
| `SESSION_SECRET` | production | development value | 32+ random characters (`openssl rand -base64 48`). Keys code hashes and the OAuth state cookie. Changing it invalidates pending codes and Google sign-ins in progress (not sessions) |
| `SESSION_TTL_DAYS` | | `30` | Session lifetime, sliding, 1–90 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for Google sign-in | | OAuth client ("Web application"). Authorised redirect URI: `${APP_URL}/api/auth/google/callback` |
| `MAIL_TRANSPORT` | | `console` (dev), `smtp` (prod) | `smtp`, `console` (prints codes in the log) or `memory` (tests). Production requires `smtp` |
| `MAIL_FROM` | production | | Sender, e.g. `Free Me <no-reply@freeme.example>` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | with smtp | port 587 | Mail provider credentials (`SMTP_SECURE=true` or port 465 for implicit TLS) |
| `ADMIN_EMAILS` | | | Addresses that get the administrator role when they sign in |
| `TRUST_PROXY` | | `1` in production | Number of proxies in front of the API |
| `API_DOCS` | | on outside production | `true` serves OpenAPI at `/api/docs` |

## Web (apps/web)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `API_INTERNAL_URL` | yes | `http://localhost:4000` | Where the web server reaches the API (private network, or `http://api:4000` inside the app-node compose) |
| `PORT`, `HOSTNAME` | | `3000`, `0.0.0.0` | Listening address of the standalone server |

## Database node (deploy/db-node)

`PRIVATE_IP`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`; for backups `BACKUP_S3_URI`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, `BACKUP_KEEP_DAYS`.

## Edge (deploy/edge)

`FREEME_DOMAIN`, `ACME_EMAIL`, `APP_NODE_A`, `APP_NODE_B` (private addresses of servers 1 and 2).

## Coming with later phases

Object storage (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`), `CDN_BASE_URL`, upload and transcoding limits (phase 2); payment provider credentials per country (phase 5). They will be added here when code uses them.

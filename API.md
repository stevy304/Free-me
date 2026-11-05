# API

REST over JSON, all routes under `/api`. Interactive documentation (OpenAPI) is served at `/api/docs` and the raw document at `/api/openapi.json` (enabled outside production, or with `API_DOCS=true`).

## Conventions

- **Authentication:** the `fm_session` cookie (`__Host-fm_session` over HTTPS), set by sign-in. Routes marked 🔒 need it; 🛡 needs the administrator role.
- **CSRF:** `POST`, `PATCH` and `DELETE` must carry an `Origin` (or `Referer`) of the web app, or they get 403.
- **Validation:** unknown fields are rejected (400). Errors look like `{ "statusCode": 400, "message": "..." }`; messages are written for people.
- **Rate limits:** 429 with `retryAfterSeconds`.
- **Pagination:** `?cursor=` with `nextCursor` in the response (`null` at the end).
- **Big numbers** (views, totals) are strings.

## Sign-in

| Method | Path | Description |
| --- | --- | --- |
| GET | `/auth/providers` | Which sign-in methods this server offers (`google`, `emailCode`) |
| POST | `/auth/email/request` | `{ email }`: emails a 6-digit code (one a minute, five an hour per address) |
| POST | `/auth/email/verify` | `{ email, code }`: signs in, creates the account on first use; `{ signedIn, newAccount }` |
| GET | `/auth/google?returnTo=/path` | Starts Google sign-in (redirect) |
| GET | `/auth/google/callback` | Google returns here; signs in and redirects to `returnTo`, or to `/login?error=...` |
| POST | `/auth/logout` | Signs out this device |

## Me 🔒

| Method | Path | Description |
| --- | --- | --- |
| GET | `/me` | Account, profile and channel |
| PATCH | `/me/profile` | `displayName`, `bio`, `country` (ISO 3166), `city`, `preferredLanguage` (BCP 47), `timezone` (IANA) |
| GET | `/me/sessions` | Signed-in devices (`current` marks this one) |
| DELETE | `/me/sessions/:id` | Signs out one device |
| DELETE | `/me/sessions` | Signs out every other device |

## Channels

| Method | Path | Description |
| --- | --- | --- |
| GET | `/channels/handle-available?handle=` | `{ available, reason? }` |
| POST | `/channels` 🔒 | `{ handle, name, description?, country?, defaultLanguage? }`: one channel per account; adds the creator role |
| PATCH | `/channels/mine` 🔒 | Edit name, description, country, language |
| GET | `/channels/:handle` | Channel, video count, latest public videos, and the viewer's relation (`subscribed`, `isOwner`) |
| POST / DELETE | `/channels/:handle/subscription` 🔒 | Subscribe / unsubscribe; returns the exact subscriber count |

## Catalogue

| Method | Path | Description |
| --- | --- | --- |
| GET | `/categories` | Video categories |
| GET | `/videos?category=&shorts=&cursor=&limit=` | Latest public videos |
| GET | `/videos/:id` | One video for its watch page (playback URL when ready) |
| GET | `/search?q=&cursor=` | Matching channels (first page) and videos |
| GET | `/search/suggest?q=` | Up to ten suggestions while typing |
| GET | `/feed/subscriptions` 🔒 | Subscribed channels and their latest videos |

## Administration 🛡

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users?q=&cursor=` | Find accounts by email, name or @handle |
| PATCH | `/admin/users/:id/roles` | `{ roles }`; you cannot remove your own administrator role |
| PATCH | `/admin/users/:id/status` | `{ status: ACTIVE or SUSPENDED }`; suspension signs the account out everywhere |
| GET | `/admin/audit?cursor=` | Latest audit entries |

## Health

`GET /health`: `200 { status: "ok", database, redis }` or `503` when a dependency is down (production also requires Redis).

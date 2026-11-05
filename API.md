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
| GET | `/videos/:id` | One video for its watch page: `playbackUrl` (CDN for public and unlisted, API route for private), processing stage, size |
| GET | `/search?q=&cursor=` | Matching channels (first page) and videos |
| GET | `/search/suggest?q=` | Up to ten suggestions while typing |
| GET | `/feed/subscriptions` 🔒 | Subscribed channels and their latest videos |

## Uploads (creators) 🔒

| Method | Path | Description |
| --- | --- | --- |
| POST | `/uploads` | `{ fileName, sizeBytes }`: creates a private draft video and a multipart upload; `{ videoId, partSize, partCount }`. Video formats only; up to `MAX_UPLOAD_MB` |
| POST | `/uploads/:id/parts` | `{ partNumbers }` (up to 100): signed addresses to `PUT` each part to (valid 1 hour). Each response's `ETag` header is the part's tag |
| GET | `/uploads/:id` | Parts already stored, for resuming |
| POST | `/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }`: assembles the file, checks its size and queues processing |
| DELETE | `/uploads/:id` | Cancels an unfinished upload |

## Studio (creators) 🔒

| Method | Path | Description |
| --- | --- | --- |
| GET | `/studio/videos?cursor=` | My videos in every state: processing progress and stage, errors, renditions, thumbnails (signed when private) |
| GET | `/studio/videos/:id` | One of my videos |
| PATCH | `/studio/videos/:id` | `title`, `description`, `visibility` (PUBLIC, UNLISTED, PRIVATE), `category` (slug), `tags`, `language`, `madeForKids`, `thumbnail` (0–2: a generated frame). Publishing sets the publish date; visibility changes move the media |
| PUT | `/studio/videos/:id/thumbnail` | Body: a JPEG, PNG or WebP image (up to 2 MB), checked by its bytes |
| DELETE | `/studio/videos/:id` | Deletes the video and every file |

## Playback

| Method | Path | Description |
| --- | --- | --- |
| GET | `/videos/:id/hls/master.m3u8` | Master playlist for private media (owner only) or while media is moving |
| GET | `/videos/:id/hls/:rendition/index.m3u8` | Variant playlist whose segment links are signed for 4 hours |
| POST | `/videos/:id/views` | `{ watchedSeconds }`: counts a view after at least 30 s (or half of a short video); once per viewer per 6 hours; the owner's views do not count |

Public and unlisted videos play from the CDN: `playbackUrl` in `/videos/:id` and feed items points at `MEDIA_PUBLIC_BASE_URL/<id>/hls/master.m3u8`.

## Administration 🛡

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users?q=&cursor=` | Find accounts by email, name or @handle |
| PATCH | `/admin/users/:id/roles` | `{ roles }`; you cannot remove your own administrator role |
| PATCH | `/admin/users/:id/status` | `{ status: ACTIVE or SUSPENDED }`; suspension signs the account out everywhere |
| GET | `/admin/audit?cursor=` | Latest audit entries |

## Health

`GET /health`: `200 { status: "ok", database, redis }` or `503` when a dependency is down (production also requires Redis).

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
| GET | `/channels/:handle` | Channel (with `followerCount`), video count, latest public videos, and the viewer's relation (`following`, `isOwner`) |
| POST / DELETE | `/channels/:handle/follow` 🔒 | Follow / unfollow; returns the exact follower count |

## Catalogue

| Method | Path | Description |
| --- | --- | --- |
| GET | `/categories` | Video categories |
| GET | `/videos?category=&moments=&cursor=&limit=` | Latest public videos; `moments=true` only Moments (vertical, up to 3 minutes), `false` none |
| GET | `/videos/:id` | One video for its watch page: `playbackUrl` (CDN for public and unlisted, API route for private), processing stage, size, `commentsOpen`; and `viewer`: `reaction`, `saved`, `following`, `isOwner`, `resumeAt` (seconds). `410` with the reason when moderators removed it |
| GET | `/search?q=&cursor=` | Matching channels (first page) and videos |
| GET | `/search/suggest?q=` | Up to ten suggestions while typing |
| GET | `/feed/following` 🔒 | Channels I follow and their latest videos |
| GET | `/site` | Operator name and contact details (from `LEGAL_*` settings) and the report reasons |

## Uploads (creators) 🔒

| Method | Path | Description |
| --- | --- | --- |
| POST | `/uploads` | `{ fileName, sizeBytes }`: creates a private draft video and a multipart upload; `{ videoId, partSize, partCount }`. Video formats only; up to `MAX_UPLOAD_MB` |
| POST | `/uploads/:id/parts` | `{ partNumbers }` (up to 100): signed addresses to `PUT` each part to (valid 1 hour). Each response's `ETag` header is the part's tag |
| GET | `/uploads/:id` | Parts already stored, for resuming |
| POST | `/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }`: assembles the file, checks its size and queues processing |
| DELETE | `/uploads/:id` | Cancels an unfinished upload |

## Creator Hub (creators) 🔒

| Method | Path | Description |
| --- | --- | --- |
| GET | `/hub/videos?cursor=` | My videos in every state: processing progress and stage, errors, renditions, thumbnails (signed when private), likes, dislikes (only the creator sees these), comments, removal |
| GET | `/hub/videos/:id` | One of my videos |
| PATCH | `/hub/videos/:id` | `title`, `description`, `visibility` (PUBLIC, UNLISTED, PRIVATE), `category` (slug), `tags`, `language`, `madeForKids`, `commentsEnabled`, `thumbnail` (0–2: a generated frame). Publishing sets the publish date; visibility changes move the media |
| PUT | `/hub/videos/:id/thumbnail` | Body: a JPEG, PNG or WebP image (up to 2 MB), checked by its bytes |
| DELETE | `/hub/videos/:id` | Deletes the video and every file |
| GET | `/hub/notices` | My removed videos, why, the copyright notice (claimant name and work, never their email), and strikes in the last 90 days |
| POST | `/hub/notices/:reportId/counter` | Counter-notice for a copyright removal: `{ statement, name, address, goodFaith: true, consent: true, signature }` (signature = name); forwarded to the claimant |

## Playback

| Method | Path | Description |
| --- | --- | --- |
| GET | `/videos/:id/hls/master.m3u8` | Master playlist for private media (owner only) or while media is moving |
| GET | `/videos/:id/hls/:rendition/index.m3u8` | Variant playlist whose segment links are signed for 4 hours |
| POST | `/videos/:id/views` | `{ watchedSeconds }`: counts a view after at least 30 s (or half of a short video); once per viewer per 6 hours; the owner's views do not count |

Public and unlisted videos play from the CDN: `playbackUrl` in `/videos/:id` and feed items points at `MEDIA_PUBLIC_BASE_URL/<id>/hls/master.m3u8`.

## Likes, history and collections 🔒

| Method | Path | Description |
| --- | --- | --- |
| PUT | `/videos/:id/reaction` | `{ value: like, dislike or none }`; returns `likeCount`. Dislikes are never shown publicly. Counts stay exact under concurrent requests |
| POST | `/videos/:id/progress` | `{ seconds, ended? }`: remembers the position (sent by the player every 10 s, on pause, at the end and when leaving) |
| GET | `/me/history?cursor=` | Videos I watched, newest first, with progress |
| DELETE | `/me/history/:videoId`, `/me/history` | Forget one video, or all |
| GET | `/me/collections` | My collections; "Saved" (private, always there) first |
| POST | `/me/collections` | `{ title, description?, visibility? }` (private by default) |
| PATCH / DELETE | `/me/collections/:id` | Rename, describe, change visibility; delete ("Saved" cannot be shared or deleted) |
| PUT / DELETE | `/me/collections/:id/videos/:videoId` | Add or remove a video; `:id` may be `saved` |
| GET | `/me/collections/containing/:videoId` | Which of my collections hold a video |
| GET | `/collections/:id` | A collection and its watchable videos (public and unlisted for anyone, private for the owner) |

## Comments

| Method | Path | Description |
| --- | --- | --- |
| GET | `/videos/:id/comments?sort=newest\|oldest&cursor=` | Pinned comment first, then 20 a page; `open: false` with the reason when comments are off (always off for videos made for kids) |
| GET | `/comments/:id/replies?cursor=` | Replies, oldest first |
| POST | `/videos/:id/comments` 🔒 | `{ content, parentId? }` (up to 2,000 characters); replies to replies join the same thread |
| PATCH | `/comments/:id` 🔒 | Edit my comment |
| DELETE | `/comments/:id` 🔒 | Author, the video's creator or a moderator; a comment with replies stays as "removed" |
| POST / DELETE | `/comments/:id/pin` 🔒 | The video's creator; one pinned comment per video |

## Reports and copyright 🔒

| Method | Path | Description |
| --- | --- | --- |
| POST | `/videos/:id/reports` | `{ reason, details?, timestampSeconds? }`; one open report per person and video |
| POST | `/copyright/notices` | `{ videoId, claimantName, claimantEmail, claimantAddress, originalWork, details, timestampSeconds?, goodFaith: true, accurate: true, signature }`; confirmation emailed to the claimant |
| GET | `/me/reports` | Reports I sent and what was decided |

## Moderation (moderators and administrators) 🛡

| Method | Path | Description |
| --- | --- | --- |
| GET | `/moderation/reports?state=open\|counter\|closed&reason=` | The queue with video, channel strikes, notice and counter-notice details |
| POST | `/moderation/reports/:id/decision` | `{ action: remove, dismiss or restore, notes }` (notes required to remove). Removal hides the video everywhere, moves its media behind signed links, closes every open report on it and emails the creator (and the claimant for copyright). Restore undoes it |

## Administration 🛡

| Method | Path | Description |
| --- | --- | --- |
| GET | `/admin/users?q=&cursor=` | Find accounts by email, name or @handle |
| PATCH | `/admin/users/:id/roles` | `{ roles }`; you cannot remove your own administrator role |
| PATCH | `/admin/users/:id/status` | `{ status: ACTIVE or SUSPENDED }`; suspension signs the account out everywhere |
| GET | `/admin/audit?cursor=` | Latest audit entries |

## Health

`GET /health`: `200 { status: "ok", database, redis }` or `503` when a dependency is down (production also requires Redis).

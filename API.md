# API

REST over JSON, all routes under `/api`. Interactive documentation (OpenAPI) is served at `/api/docs` and the raw document at `/api/openapi.json` (enabled outside production, or with `API_DOCS=true`).

## Conventions

- **Authentication:** the `fm_session` cookie (`__Host-fm_session` over HTTPS), set by sign-in. Routes marked 🔒 need it; 🛡 needs the administrator role.
- **CSRF:** `POST`, `PATCH` and `DELETE` must carry an `Origin` (or `Referer`) of the web app, or they get 403.
- **Validation:** unknown fields are rejected (400). Errors look like `{ "statusCode": 400, "message": "..." }`; messages are written for people.
- **Rate limits:** 429 with `retryAfterSeconds`.
- **Pagination:** `?cursor=` with `nextCursor` in the response (`null` at the end).
- **Big numbers** (views, totals) are strings.
- **Request id:** every answer has an `X-Request-Id` header (the edge's, or a new one). Unexpected errors (500) also return it as `requestId`, so a report can be matched with the server log.

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
| GET | `/videos/:id/next?limit=` | What to watch after this video (default 20, up to 40): same Space, shared tags and topic first, then the viewer's picked topics, then popularity and freshness; videos the viewer finished come last; at most two from one Space in any four in a row. Unknown video: the latest videos |
| GET | `/search?q=&cursor=` | Matching channels (first page) and videos, ranked: title words first, then description, tags and Space name; close spellings match too ("gorrilas" finds "Gorillas"). Pages of 24 |
| GET | `/search/suggest?q=` | Up to ten suggestions while typing |
| GET | `/feed/following` 🔒 | Channels I follow and their latest videos |
| GET | `/feed/home` | For you: `spotlight`, `interests` (with `picked`), `shelves` (one per picked topic, then the busiest topics this month), `fromCreators`, `moments`, `latest`. Built only from picked topics, followed creators and recency |
| GET | `/feed/rising` | The most watched public videos published in the last 7 days |
| GET / PUT | `/me/interests` 🔒 | My topics for For you: `{ categories: [slug] }` (up to 12) |
| GET | `/site/sitemap` | Public videos (newest 20,000) and Spaces with public videos, for `/sitemap.xml` |
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
| PUT | `/hub/videos/:id/captions/:lang` | Body: a WebVTT or SubRip (.srt) file, up to 1 MB. Cleaned to WebVTT (times normalised; markup other than `<b>`, `<i>`, `<u>` removed). Replaces captions in that language, automatic ones included. `:lang` from the language list |
| DELETE | `/hub/videos/:id/captions/:lang` | Removes captions in one language |
| GET | `/hub/stats?days=` | My Space over 7, 28, 90 or 365 days: `series` (per day: views, watchSeconds, newFollowers), `totals` with the `previous` period, `topVideos` (views, watch time, average view) |
| GET | `/hub/videos/:id/stats?days=` | One video: daily series, `lifetime` and `period` totals, and `retention` (share of signed-in viewers still watching at each 5%; shown from 5 viewers) |
| DELETE | `/hub/videos/:id` | Deletes the video and every file |
| GET | `/hub/notices` | My removed videos, why, the copyright notice (claimant name and work, never their email), and strikes in the last 90 days |
| POST | `/hub/notices/:reportId/counter` | Counter-notice for a copyright removal: `{ statement, name, address, goodFaith: true, consent: true, signature }` (signature = name); forwarded to the claimant |

## Playback

| Method | Path | Description |
| --- | --- | --- |
| GET | `/videos/:id/hls/master.m3u8` | Master playlist for private media (owner only) or while media is moving |
| GET | `/videos/:id/hls/:rendition/index.m3u8` | Variant playlist whose segment links are signed for 4 hours (`144p`…`2160p`, and `audio` for the shared audio rendition) |
| GET | `/videos/:id/captions/:lang.vtt` | Captions as WebVTT, with the video's own access rules (private: owner only). `captions` in `/videos/:id` lists them: `{ language, auto, url }` |
| GET | `/videos/:id/storyboard.vtt` | Seek-bar previews as WebVTT: each cue is a time range and a tile of the sprite sheet (`#xywh=x,y,w,h`). `storyboardUrl` in `/videos/:id` points here when the video has them |
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
| POST | `/admin/system/reprocess` | `{ limit?: 1–500 (50), dryRun? }`: queue older videos (processed before seek previews existed) for the current pipeline, oldest first; they stay watchable. Answers `{ queued, wouldQueue, remaining }` |
| POST | `/admin/system/repair-media` | `{ apply? }`: find (and with `apply`, bring back) files videos left in the wrong storage place (broken thumbnails or playback); lists up to 100 affected videos |
| GET | `/admin/system` | `ok`, `warnings` (database or Redis down, email not really sent, Google sign-in missing, videos waiting, stuck over 2 hours or failed in 24 hours), `services`, `processing` (queue counts), `videos` by status, `storage` bytes, `accounts`, `moderation.openReports` |

| GET | `/admin/billing` | Premium members, income in the last 30 days, ads waiting for review, withdrawals to send, ad revenue by day |
| GET | `/admin/billing/campaigns?status=` | Ad campaigns (default `PENDING_REVIEW`; `all`) |
| POST | `/admin/billing/campaigns/:id/review` | `{ approve, note? }` (a note is required to reject): approved campaigns start now and run for the days bought |
| GET | `/admin/billing/payouts?status=` | Creator withdrawals (default: open) |
| POST | `/admin/billing/payouts/:id` | `{ action: paid, reference }` or `{ action: reject, reason }` (the money returns to the creator's balance) |
| POST | `/admin/billing/premium` | `{ email, months }`: give Premium without payment |
| GET | `/admin/billing/payments` | Latest 100 payments |

## Premium and payments

| Method | Path | Description |
| --- | --- | --- |
| GET | `/billing/plans` | Prices (`premium.usdCents`, `ads.usdCentsPerDay`, `payoutMinimumUsdCents`) and the payment methods this server accepts (`mtn_momo` with its currency and rate, `flutterwave`) |
| GET | `/billing/me` 🔒 | `premium: { active, until }` and my payments |
| POST | `/billing/premium` 🔒 | `{ method, months (1, 3, 6, 12), phone? }`: MoMo sends a prompt to the phone; a card payment answers with `checkoutUrl` |
| GET | `/billing/payments/:id` 🔒 | One of my payments, checked with the provider while pending; with `premium` |
| POST | `/billing/webhooks/flutterwave` | Flutterwave's callback (needs the `verif-hash` header; the payment is verified with Flutterwave itself) |

Premium gives the verified badge (`channel.isVerified`), which goes when the membership ends unless an administrator verified the Space. `/me` includes `premium`.

## Ads

| Method | Path | Description |
| --- | --- | --- |
| GET | `/ads/campaigns` 🔒 | My campaigns with `impressions` and `clicks` |
| POST | `/ads/campaigns` 🔒 | `{ businessName, country, headline, destinationUrl (https), videoId (my own video, Public or Unlisted, 5–90 s), days (1–90), targetCountries? }`: a draft |
| POST | `/ads/campaigns/:id/pay` 🔒 | `{ method, phone? }`: pay a draft (days × the daily price); then it waits for review |
| POST | `/ads/campaigns/:id/pause` 🔒 | Pause or resume a running campaign |
| DELETE | `/ads/campaigns/:id` 🔒 | Delete an unpaid draft |
| GET | `/videos/:id/ads` | `{ slots: [{ at, ad }] }`: none, one before the video, and for videos of 8 minutes or more one halfway; only on monetised Premium creators' videos, never on Moments |
| POST | `/ads/impressions` | `{ campaignId, videoId }`: an ad started (once per viewer, campaign and video every 30 minutes) → `{ impressionId }` |
| POST | `/ads/impressions/:id/events` | `{ type: COMPLETE, SKIP or CLICK, ms }` |

## Monetisation 🔒

| Method | Path | Description |
| --- | --- | --- |
| GET | `/hub/monetisation` | Membership, `joined`, `earning`, `balance`, ads shown in 28 days, earnings ledger, withdrawals, programme terms |
| POST | `/hub/monetisation/join` | Join (Premium members with no removed videos in 90 days) |
| POST | `/hub/monetisation/payouts` | `{ phone, accountHolderName }`: withdraw the whole available balance to MTN MoMo (from the minimum) |

See MONETISATION.md for how the money is shared.

## Notifications 🔒

| Method | Path | Description |
| --- | --- | --- |
| GET | `/me/notifications?cursor=` | Newest first, 50 a page: `{ id, type (NEW_VIDEO, COMMENT, REPLY, SPARK), count, read, at, text, href, actor, video }` and `unread`. Sparks on one video are one unread entry with a count. Removed videos drop out |
| GET | `/me/notifications/unread` | `{ unread }`, for the bell |
| POST | `/me/notifications/read` | `{ ids? }`: mark these, or all, as read |

Raised when: a Space you tune into publishes a video (once, the first time it is public and ready); someone joins the conversation on your video; someone replies to your comment; someone sparks your video. Never for your own actions.

## Health

`GET /health`: `200 { status: "ok", database, redis }` or `503` when a dependency is down (production also requires Redis).

# Free Me — REST API Specification (OpenAPI Compatible)

All API requests are prefixed with `/api/v1`. Requests requiring authentication require the standard `Authorization: Bearer <JWT>` header or secure HTTP-only cookies.

---

## 1. Authentication Endpoints (`/api/v1/auth`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/register` | Register new Viewer, Creator, or Advertiser account | Public |
| `POST` | `/auth/login` | Email/password login with JWT token issuance | Public |
| `POST` | `/auth/verify-email` | Confirm email verification token | Authenticated |
| `POST` | `/auth/refresh` | Refresh access token using HTTP-only refresh token | Authenticated |
| `POST` | `/auth/switch-role` | Switch active context (Viewer ↔ Creator ↔ Advertiser) | Authenticated |

---

## 2. Video & Stream Endpoints (`/api/v1/videos`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/videos` | Feed of published videos (category, search, sorting) | Public |
| `GET` | `/videos/:id` | Video details, metadata, playback URLs, like count | Public |
| `GET` | `/videos/:id/hls/master.m3u8` | Master adaptive bitrate playlist | Public |
| `POST` | `/videos/init-upload` | Request presigned S3 upload URL for raw media | Creator |
| `POST` | `/videos/:id/complete-upload` | Dispatch media worker for FFmpeg HLS transcoding | Creator |
| `POST` | `/videos/:id/like` | Like or remove like on video | Authenticated |
| `GET` | `/videos/:id/comments` | Paginated comments with nested replies | Public |
| `POST` | `/videos/:id/comments` | Post comment | Authenticated |

---

## 3. Shorts Vertical Feed (`/api/v1/shorts`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/shorts/feed` | Infinite vertical 9:16 short video feed | Public |
| `POST` | `/shorts/:id/view` | Track valid short playback completion | Public/Auth |

---

## 4. Creator Studio Endpoints (`/api/v1/studio`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/studio/channel` | Current creator channel settings & metrics | Creator |
| `GET` | `/studio/analytics` | Views, watch time, subscribers, CPM analytics | Creator |
| `GET` | `/studio/monetization` | Monetization eligibility status (subs & hours) | Creator |
| `POST` | `/studio/monetization/apply` | Apply for platform monetization program | Creator |
| `GET` | `/studio/ledger` | Detailed 60% revenue sharing ledger entries | Creator |
| `POST` | `/studio/payouts/request` | Request Mobile Money (MoMo) or Bank withdrawal | Creator |

---

## 5. Local Advertising Engine (`/api/v1/ads`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/ads/campaigns` | List active & past campaigns for advertiser | Advertiser |
| `POST` | `/ads/campaigns` | Create new campaign with budget and targeting | Advertiser |
| `GET` | `/ads/dispatch` | Fetch matching pre-roll ad for video playback | Player/System |
| `POST` | `/ads/events` | Record start, quartile, complete, or click event | Player/System |

---

## 6. Administration & Governance (`/api/v1/admin`)

| Method | Endpoint | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/admin/metrics` | Platform overview (total users, creators, GMV) | Admin |
| `GET` | `/admin/campaigns/pending` | Review local ad campaigns awaiting approval | Admin |
| `POST` | `/admin/campaigns/:id/review` | Approve or reject advertising campaign | Admin |
| `GET` | `/admin/payouts/pending` | Review pending creator payout requests | Admin |
| `POST` | `/admin/payouts/:id/approve` | Process payout via MTN MoMo / Bank API | Admin |
| `POST` | `/admin/settings/revenue-split` | Update platform split ratio (e.g. 60/30/10) | Admin |
| `GET` | `/admin/audit-logs` | Tamper-evident administrative action history | Admin |

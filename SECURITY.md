# Free Me — Platform Security, Privacy & Compliance Architecture

## 1. Threat Model & Defense In Depth

Free Me is built to defend user privacy, protect advertiser funds, and safeguard creator monetization against fraud:

### A. Authentication & Credential Protection
- Passwords hashed using Argon2id with recommended memory and parallelism parameters.
- JWT tokens split: short-lived Access Tokens (15 minutes) and HTTP-only, secure, `SameSite=Strict` Refresh Tokens (7 days).
- Role-based Access Control (RBAC) enforced on every API route via guard decorators.
- Two-factor authentication (TOTP RFC 6238) supported for creator and administrator accounts.

### B. Secure File & Video Ingestion
- Raw videos are uploaded directly from client to S3 bucket via time-limited presigned URLs (15 minute expiration).
- File type validation enforces magic-byte checking (MPEG-4, QuickTime, WebM) on the media worker before processing.
- Executable files (`.exe`, `.sh`, `.php`, `.js`) and polyglot files are rejected.
- File size caps: 10GB for verified creators, 2GB for unverified creators.
- Transcoding worker runs as an unprivileged Linux user (`uid: 1001`) inside an isolated, non-root Docker container without access to the host root filesystem.

### C. Financial & Monetization Integrity
- **Double-Entry Ledgers**: Revenue cannot be created without corresponding valid advertising impressions.
- **View Fraud Detection**: View events require proof of playback duration ($\ge 30\text{s}$) with randomized heartbeat verification tokens.
- **Audience Quality & Bot Filtering**: Rate limiting per IP and device fingerprint using Redis sliding window log algorithm.
- **Payout Approval Guard**: All withdrawals above $100 (or equivalent RWF 130,000) require manual administrative dual-authorization before triggering MTN Mobile Money or Bank API payouts.

### D. Age-Appropriate Safeguards & Content Moderation
- Sensitive content flagging enabled for graphic, mature, or unverified medical content.
- Community reporting workflow with quick-takedown capability for copyright infringements (DMCA/African Copyright treaties compliant) and child safety violations.
- Tamper-evident `AuditLog` captures all administrative decisions (moderation strikes, split adjustments, payout approvals).

### E. Rate Limiting & Denial of Service Protection
- Public endpoints: 60 requests/minute per IP.
- Auth endpoints: 5 attempts/15 minutes per IP with exponential lockout.
- Video stream chunks served via CDN edge with geographical Anycast routing.

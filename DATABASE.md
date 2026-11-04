# Free Me — Database Architecture & Schema Specification

## 1. Engine & Storage Strategy

- **Database Engine**: PostgreSQL 16
- **Connection Management**: PgBouncer (Transaction pooling mode, pool size 50)
- **Primary Schema Tooling**: Prisma ORM with versioned SQL migrations
- **In-Memory Store**: Redis 7 (used for session caching, rate limiting, and BullMQ queues)

---

## 2. Entity Relationship Overview

```
User (1) ────────── (1) Profile
User (1) ────────── (1) Channel
Channel (1) ─────── (N) Video
Video (1) ───────── (N) VideoRendition
Video (1) ───────── (N) Comment
User (N) ────────── (N) Channel [Subscription]
User (N) ────────── (N) Video [Like / WatchHistory]

User (1) ────────── (1) Advertiser
Advertiser (1) ──── (N) Campaign
Campaign (1) ────── (N) AdImpression
AdImpression (N) ── (1) Video

Channel (1) ─────── (1) CreatorEligibility
Channel (1) ─────── (1) CreatorBalance
Channel (1) ─────── (N) RevenueLedger
Channel (1) ─────── (N) Payout
```

---

## 3. High-Concurrency Mitigation Strategy

### Avoid Direct Unbounded Writes on View Counts
A naive platform writes `UPDATE videos SET view_count = view_count + 1 WHERE id = ?` on every play request. Under 1,000 concurrent viewers, this creates catastrophic row-lock contention.

**Free Me Strategy**:
1. When a client watches $\ge 30\text{s}$ (or completes 50% of a short), a view event is written into Redis via `PFADD video:views:<id> <viewer_ip_user_hash>`.
2. A lightweight background worker runs every 60 seconds, reads unique counts via `PFCOUNT`, and flushes delta increments in single atomic batch queries:
   ```sql
   UPDATE "Video" AS v
   SET "viewCount" = v."viewCount" + batch.delta
   FROM (VALUES ('vid_1'::text, 42), ('vid_2'::text, 18)) AS batch(id, delta)
   WHERE v.id = batch.id;
   ```

### Strict Financial Invariants (Double-Entry Ledger)
Money is NEVER magically credited to `CreatorBalance` without a corresponding `RevenueLedger` row.
The sum of `creatorShareCents + platformShareCents + reinvestShareCents` MUST equal `grossAmountCents`.

---

## 4. Key Performance Indexes

- `Channel(handle)`: Unique index for fast `@handle` profile routing.
- `Video(channelId, createdAt DESC)`: High-performance channel video tabs.
- `Video(status, visibility, createdAt DESC)`: Filter index for homepage feed and search discovery.
- `AdImpression(campaignId, createdAt DESC)`: Fast advertiser spend aggregation.
- `RevenueLedger(channelId, createdAt DESC)`: Creator earnings timeline.
- `WatchHistory(userId, lastWatchedAt DESC)`: Fast user history retrieval.

---

## 5. Migration Execution Checklist

```bash
# Generate SQL migration from schema
npx prisma migrate dev --name init_free_me_schema

# Apply migrations to production database (Node 3)
npx prisma migrate deploy

# Verify database connection and schema state
npx prisma db seed
```

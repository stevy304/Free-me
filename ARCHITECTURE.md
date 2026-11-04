# Free Me — Platform Architecture Specification

## 1. System Philosophy & Target Capacity

- **Initial Market**: Rwanda (Kigali flagship hub)
- **Immediate Capacity Target**: 50,000 registered accounts, 1,000 concurrent video streams
- **Traffic Profile**: High read concurrency on CDN edge, asynchronous video ingestion, batch-aggregated financial metrics to prevent write contention on primary PostgreSQL.

---

## 2. Four-Server Hetzner Physical Topology

Free Me leverages dedicated bare-metal servers from Hetzner (AX42 / AX52 line) interconnected via an isolated private vSwitch (10G internal LAN):

### Server 1: Application Node A (IP: 10.0.1.10)
- **Role**: Active Web Frontend & Primary REST API Gateway
- **Specs**: AMD Ryzen 7 7700, 64GB DDR5 RAM, 2x 1TB NVMe (RAID 1)
- **Services**:
  - Next.js / React SSR & SPA runtime
  - NestJS / Express REST API Gateway
  - JWT / Session Authentication & Role Authorization
  - Prometheus Node Exporter

### Server 2: Application Node B (IP: 10.0.1.11)
- **Role**: Secondary Horizontal Application Node
- **Specs**: AMD Ryzen 7 7700, 64GB DDR5 RAM, 2x 1TB NVMe (RAID 1)
- **Services**:
  - Clustered API worker instance
  - BullMQ job dispatchers & event listeners
  - Notification dispatch (SMS via Africa's Talking / MTN Rwanda SMS Gateway)

### Server 3: Database & State Node (IP: 10.0.1.20)
- **Role**: Persistent Data Storage & In-Memory Caching
- **Specs**: AMD Ryzen 9 7950X, 128GB DDR5 ECC RAM, 2x 1.92TB Enterprise NVMe
- **Firewall Policy**: STRICT. No public IP exposure. Only accessible on ports 5432 (Postgres) and 6379 (Redis) via private vSwitch subnet `10.0.1.0/24`.
- **Services**:
  - PostgreSQL 16 (Tuned buffer cache, connection pool via PgBouncer)
  - Redis 7 (In-memory token blacklist, view counting aggregates, BullMQ queues)
  - Automated WAL-G replication to remote Hetzner Storage Box

### Server 4: Media Processing Node (IP: 10.0.1.30)
- **Role**: Dedicated FFmpeg Transcoding & Asset Generation
- **Specs**: AMD Ryzen 9 7950X (16 cores / 32 threads), 128GB RAM, 2x 1.92TB NVMe scratch disk
- **Services**:
  - BullMQ Media Processing Workers (`concurrency: 4`)
  - FFmpeg 6.1 with libx264, libaac, and hls muxer
  - Video rendition ladder:
    - `1080p`: 1920x1080 @ 4500 kbps, 60fps/30fps
    - `720p`: 1280x720 @ 2200 kbps, 30fps
    - `480p`: 854x480 @ 900 kbps (Optimized for 3G/4G African mobile users)
    - `360p`: 640x360 @ 450 kbps (Ultra-low bandwidth data saving)
  - WebVTT thumbnail strip extraction & animated WebP preview generation

---

## 3. Video Processing & Transcoding Pipeline

```
[ Client Upload ] 
       │ 1. Presigned S3 Multipart Upload (Chunked 10MB)
       ▼
[ Raw Storage Bucket ]
       │ 2. SQS / BullMQ Event triggered
       ▼
[ Media Worker (Server 4) ]
       │ 3. Fetch Raw Video to NVMe Scratch (/tmp/transcode/<job_id>)
       │ 4. Probe Metadata (ffprobe: codec, resolution, rotation, audio channels)
       │ 5. Execute 2-Pass FFmpeg HLS Transcoding
       │    ├─ Master playlist: master.m3u8
       │    ├─ 1080p/index.m3u8 & ts chunks (6s keyframe intervals)
       │    ├─ 720p/index.m3u8 & ts chunks
       │    ├─ 480p/index.m3u8 & ts chunks
       │    └─ 360p/index.m3u8 & ts chunks
       │ 6. Generate 3 representative thumbnails (25%, 50%, 75% timestamps)
       │ 7. Upload Transcoded Directory to HLS Distribution Bucket
       │ 8. Notify API Gateway: UPDATE Video SET status = 'READY', masterPlaylistUrl = ...
       ▼
[ Cloudflare / BunnyCDN Edge Caching ]
       │ 9. Low-latency HLS Segment Streaming to Viewer Devices
       ▼
[ Viewer Video Player ]
```

---

## 4. Advertising & Revenue Engine Architecture

To eliminate write locks on PostgreSQL, view counts and ad impressions follow a high-throughput event buffer pattern:

1. **Client Event**: Viewer plays video and completes ad impression.
2. **Fast Ingestion Route**: `/api/v1/ads/impression` records impression to Redis HyperLogLog and Stream.
3. **Scheduled Aggregation Job**: Every 5 minutes, BullMQ pulls stream batches, deduplicates bot traffic, checks viewer geography, and executes atomic ledger entry:
   - Creator Pool Share (60%): Credited to `CreatorBalance.pendingBalanceCents`.
   - Platform Maintenance (30%): Credited to operations account.
   - Growth Fund (10%): Credited to creator grant pool.
4. **End-of-Month Settlement**: Admin/System runs reconciliation, transferring `pendingBalanceCents` to `confirmedBalanceCents` after fraud filtering.

---

## 5. Security & Isolation

- All internal inter-server communication uses private VLAN or WireGuard VPN.
- Public web traffic terminates at Caddy / Cloudflare with automatic TLS 1.3 certificates.
- Rate limiting enforced at both edge and application layers via Redis token bucket.

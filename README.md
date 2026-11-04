# Free Me — African Video Sharing & Creator Monetization Platform

> **Your content. Your freedom. Your opportunity.**

Free Me is an independent video-sharing platform engineered to give African creators fair monetization, direct audience relationships, and transparent revenue-sharing powered by local advertisers and businesses.

Launching initially in **Rwanda** with expansion planned across East Africa (Kenya, Uganda, Tanzania) and the wider African continent, Free Me bridges the gap between local enterprise marketing budgets and African digital creators.

---

## Core Pillars & Values

1. **Creator-First Monetization**: 60% of verified local advertising revenue is directly deposited into creator balances, strictly audited on an immutable ledger.
2. **Transparent Platform Split**: Configurable and clearly disclosed:
   - **60%** Creator Revenue Pool
   - **30%** Platform Infrastructure & Operations
   - **10%** Community Reinvestment & Creator Grants
3. **Local Advertising Engine**: Built for Rwandan and African businesses (RDB/RRA registered merchants, telcos, hospitality, fintech, SMEs) with targeting by country, district, and niche category.
4. **Adaptive Video Streaming**: Resilient HLS (HTTP Live Streaming) supporting 1080p, 720p, 480p, and 360p with low data consumption optimization for African cellular networks.
5. **Shorts & Long-Form Harmony**: Unified video architecture serving both cinematic long-form stories and viral 9:16 vertical short videos.
6. **Local Payout Adapters**: Integration with MTN Mobile Money (MoMo Rwanda), Airtel Money, Bank of Kigali (BK), and regional switches with transparent minimum thresholds.

---

## System Architecture Overview

The proposed production deployment uses four Hetzner servers:

```
                          [ Internet Traffic / CDN Cloudflare ]
                                          │
                                          ▼
                      [ Hetzner Load Balancer / Caddy Edge ]
                                          │
                   ┌──────────────────────┴──────────────────────┐
                   │                                             │
                   ▼                                             ▼
       [ SERVER 1: App Node A ]                      [ SERVER 2: App Node B ]
       • Next.js / React Client                      • Second Web Instance
       • NestJS/Express API Server                   • Horizontal Scaling Node
       • Auth & Session Services                     • Background Job Dispatch
                   │                                             │
                   └──────────────────────┬──────────────────────┘
                                          │ Private WireGuard / Hetzner vSwitch
                   ┌──────────────────────┴──────────────────────┐
                   │                                             │
                   ▼                                             ▼
       [ SERVER 3: Database Node ]                   [ SERVER 4: Media Node ]
       • PostgreSQL (Prisma ORM)                     • BullMQ Worker Fleet
       • Redis Cache & Session Store                 • FFmpeg HLS Transcoding
       • Automated Barman Backups                    • Thumbnail & Sprite Generator
       • Private Isolated Network                    • Direct-to-S3 Uploader
                                                                 │
                                                                 ▼
                                                  [ S3-Compatible Object Store ]
                                                  • MinIO / Hetzner Storage Box / Wasabi
```

---

## Run the web prototype

The current repository runs a Vite preview of the product. It uses sample media and in-memory demo accounts, campaigns and balances. See the [production roadmap](ROADMAP.md) for the current phase and release gates.

```bash
git clone https://github.com/stevy304/Free-me.git
cd Free-me
# Use Node.js 24
npm ci
npm run dev
```

Open http://localhost:3000. Run `npm run lint`, `npm test`, and `npm run build` to check the preview.

To bootstrap an empty PostgreSQL development database, set `DATABASE_URL` to its connection string and run `npx prisma migrate deploy`. The web preview still uses demo data.

## Platform Documentation Directory

| Document | Description |
| :--- | :--- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full architectural blueprint, data flow, queue specs, and 4-server topology |
| [`DATABASE.md`](DATABASE.md) | Relational schema diagrams, Prisma models, indexing strategy, and read-replicas |
| [`API.md`](API.md) | OpenAPI / REST endpoints for Auth, Videos, Studio, Ads, and Admin |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Hetzner provisioning guide, Docker Compose configurations, and Caddy reverse proxy |
| [`SECURITY.md`](SECURITY.md) | Threat model, CSRF/XSS mitigations, upload sanitization, and audit logs |
| [`ENVIRONMENT.md`](ENVIRONMENT.md) | Complete inventory of environment variables and production secrets |
| [`BACKUP-AND-RECOVERY.md`](BACKUP-AND-RECOVERY.md) | Automated PostgreSQL WAL-G/Barman snapshots, S3 replication, and RTO/RPO |

---

## License

Proprietary — All rights reserved by Free Me Platform Ltd. (Rwanda).

## Try real upload and playback locally

Install FFmpeg, then run the video service in one terminal and the web app in another.

```bash
node prototypes/video-backend.mjs
npm run dev
```

The **Upload** button accepts a raw MP4 of up to 25 MiB. On mobile, open the account menu to find it. The backend processes the first 60 seconds into an adaptive HLS playlist with up to three quality levels, stores media on disk, and records status in SQLite. SQLite stores the upload catalog, and FFmpeg generates a thumbnail. The backend serves ready videos to any browser connected to the same local instance. Data defaults to `~/.free-me-video`. To reopen an earlier prototype catalog, set `FREEME_DATA_DIR` to its previous directory before starting the backend. The discovery fixtures, persona switching, and monetization screens use sample data.

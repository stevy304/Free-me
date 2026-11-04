# Free Me — Hetzner 4-Server Deployment & Provisioning Guide

## 1. Network Topology & Firewall Matrix

All servers reside in a dedicated Hetzner Cloud vSwitch / Private Subnet `10.0.1.0/24`.

| Server | Role | Private IP | Public Ports Allowed | Internal Ports Allowed |
| :--- | :--- | :--- | :--- | :--- |
| **Server 1** | App Node A | `10.0.1.10` | `80, 443` (Caddy/Edge) | `3000, 4000, 9100` |
| **Server 2** | App Node B | `10.0.1.11` | None (Traffic via Node A / LB) | `3000, 4000, 9100` |
| **Server 3** | Database Node | `10.0.1.20` | None (STRICT) | `5432` (Postgres), `6379` (Redis) |
| **Server 4** | Media Node | `10.0.1.30` | None (STRICT) | `9100` (Node exporter) |

---

## 2. Server 1 (App Node A) Docker Setup

Directory: `/opt/freeme/server1-app-a/docker-compose.yml`

```yaml
version: '3.8'
services:
  caddy:
    image: caddy:2.7-alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - web_net

  app_frontend:
    image: freeme/frontend:latest
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=3000
      - NEXT_PUBLIC_API_URL=https://freeme.rw/api/v1
    networks:
      - web_net

  api_gateway:
    image: freeme/api:latest
    restart: always
    environment:
      - NODE_ENV=production
      - PORT=4000
      - DATABASE_URL=postgresql://freeme_user:${DB_PASS}@10.0.1.20:5432/freeme_prod?schema=public
      - REDIS_URL=redis://10.0.1.20:6379
      - S3_ENDPOINT=https://fsn1.your-objectstorage.com
      - S3_BUCKET_NAME=freeme-rwanda-production
    networks:
      - web_net

volumes:
  caddy_data:
  caddy_config:

networks:
  web_net:
    driver: bridge
```

---

## 3. Server 3 (Database Node) Docker Setup

Directory: `/opt/freeme/server3-database/docker-compose.yml`

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_DB: freeme_prod
      POSTGRES_USER: freeme_user
      POSTGRES_PASSWORD: ${DB_PASS}
    ports:
      - "10.0.1.20:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgresql.conf:/etc/postgresql/postgresql.conf:ro
    command: postgres -c config_file=/etc/postgresql/postgresql.conf

  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --requirepass ${REDIS_PASS} --maxmemory 8gb --maxmemory-policy volatile-lru
    ports:
      - "10.0.1.20:6379:6379"
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

---

## 4. Server 4 (Media Processing Node) Docker Setup

Directory: `/opt/freeme/server4-media/docker-compose.yml`

```yaml
version: '3.8'
services:
  transcoding_worker:
    image: freeme/media-worker:latest
    restart: always
    deploy:
      resources:
        limits:
          cpus: '28.0'
          memory: 96G
    environment:
      - REDIS_URL=redis://:${REDIS_PASS}@10.0.1.20:6379
      - QUEUE_NAME=video-transcoding
      - CONCURRENCY=4
      - S3_ENDPOINT=https://fsn1.your-objectstorage.com
      - S3_ACCESS_KEY=${S3_KEY}
      - S3_SECRET_KEY=${S3_SECRET}
      - S3_BUCKET_RAW=freeme-raw-uploads
      - S3_BUCKET_HLS=freeme-hls-streaming
    volumes:
      - /tmp/transcode:/tmp/transcode
```

---

## 5. Provisioning Steps

1. **Private Subnet Setup**: Enable Hetzner vSwitch and bind all 4 servers to interface `enp7s0`.
2. **UFW Rules on Node 3**:
   ```bash
   sudo ufw default deny incoming
   sudo ufw allow in on enp7s0 from 10.0.1.0/24 to any port 5432
   sudo ufw allow in on enp7s0 from 10.0.1.0/24 to any port 6379
   sudo ufw enable
   ```
3. **Run Migrations**: On Node 1 or CI runner, run `npx prisma migrate deploy`.
4. **SSL / DNS**: Point `freeme.rw` to Node 1 public IP. Caddy auto-provisions Let's Encrypt certificates.

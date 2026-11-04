# Free Me — Environment Configuration Matrix

This document defines the configuration parameters for development, staging, and production environments across all four Hetzner nodes.

## 1. Application Nodes (Server 1 & 2)

```env
# Runtime
NODE_ENV="production"
PORT=3000
API_PORT=4000
APP_URL="https://freeme.rw"

# Database & Cache (Server 3 Private IP)
DATABASE_URL="postgresql://freeme_user:${DB_PASSWORD}@10.0.1.20:5432/freeme_prod?schema=public&sslmode=prefer"
REDIS_URL="redis://:${REDIS_PASSWORD}@10.0.1.20:6379"

# Security & Authentication
JWT_ACCESS_SECRET="CHANGE_ME_IN_PRODUCTION_MIN_64_CHAR_HEX"
JWT_REFRESH_SECRET="CHANGE_ME_IN_PRODUCTION_MIN_64_CHAR_HEX"
JWT_ACCESS_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"

# S3-Compatible Object Storage (Hetzner / MinIO / Wasabi)
S3_ENDPOINT="https://fsn1.your-objectstorage.com"
S3_REGION="eu-central-1"
S3_ACCESS_KEY="S3_ACCESS_KEY_ID"
S3_SECRET_KEY="S3_SECRET_ACCESS_KEY"
S3_BUCKET_RAW="freeme-raw-uploads"
S3_BUCKET_HLS="freeme-hls-streaming"
S3_BUCKET_THUMBNAILS="freeme-thumbnails"
CDN_BASE_URL="https://cdn.freeme.rw"

# Creator Revenue Sharing Default Splits (Audited)
REVENUE_SPLIT_CREATOR_PERCENT=60
REVENUE_SPLIT_PLATFORM_PERCENT=30
REVENUE_SPLIT_REINVEST_PERCENT=10

# Local Payment Gateway Adapters
MTN_MOMO_API_KEY="MOMO_API_KEY"
MTN_MOMO_SUBSCRIPTION_KEY="MOMO_SUBSCRIPTION_KEY"
MTN_MOMO_ENVIRONMENT="production"
BANK_OF_KIGALI_MERCHANT_ID="BK_MERCHANT_ID"
BANK_OF_KIGALI_API_SECRET="BK_SECRET"
```

## 2. Media Node (Server 4)

```env
# Transcoding Engine
REDIS_URL="redis://:${REDIS_PASSWORD}@10.0.1.20:6379"
FFMPEG_PATH="/usr/bin/ffmpeg"
FFPROBE_PATH="/usr/bin/ffprobe"
TRANSCODE_CONCURRENCY=4
TMP_SCRATCH_DIR="/tmp/transcode"

# S3 Access
S3_ENDPOINT="https://fsn1.your-objectstorage.com"
S3_ACCESS_KEY="S3_ACCESS_KEY_ID"
S3_SECRET_KEY="S3_SECRET_ACCESS_KEY"
S3_BUCKET_RAW="freeme-raw-uploads"
S3_BUCKET_HLS="freeme-hls-streaming"
```

## 3. Database Node (Server 3)

```env
POSTGRES_DB="freeme_prod"
POSTGRES_USER="freeme_user"
POSTGRES_PASSWORD="STRONG_SECURE_PASSWORD"
REDIS_PASSWORD="STRONG_REDIS_PASSWORD"
WALG_S3_PREFIX="s3://freeme-db-backups/postgres-wal"
```

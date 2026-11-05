#!/usr/bin/env bash
# Prepares the S3-compatible bucket (e.g. Hetzner Object Storage) for Free Me, using the aws CLI:
#  - CORS so browsers can upload parts directly (PUT, reading the ETag header) and play media (GET)
#  - public read for pub/ only (public and unlisted videos, served through the CDN); src/ and prv/ stay private
#  - abandoned multipart uploads are cleaned after 7 days
# Usage: AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... S3_ENDPOINT=https://fsn1.your-objectstorage.com \
#        S3_BUCKET=freeme-media APP_URL=https://freeme.example ./storage-setup.sh
set -euo pipefail
: "${S3_ENDPOINT:?}" "${S3_BUCKET:?}" "${APP_URL:?}"
aws() { command aws --endpoint-url "$S3_ENDPOINT" "$@"; }
aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null || aws s3api create-bucket --bucket "$S3_BUCKET"
aws s3api put-bucket-cors --bucket "$S3_BUCKET" --cors-configuration "{
  \"CORSRules\": [{ \"AllowedOrigins\": [\"$APP_URL\"], \"AllowedMethods\": [\"PUT\", \"GET\", \"HEAD\"], \"AllowedHeaders\": [\"*\"], \"ExposeHeaders\": [\"ETag\"], \"MaxAgeSeconds\": 3600 }]
}"
aws s3api put-bucket-policy --bucket "$S3_BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Sid\": \"PublicMedia\", \"Effect\": \"Allow\", \"Principal\": \"*\", \"Action\": [\"s3:GetObject\"], \"Resource\": [\"arn:aws:s3:::$S3_BUCKET/pub/*\"] }]
}"
aws s3api put-bucket-lifecycle-configuration --bucket "$S3_BUCKET" --lifecycle-configuration '{
  "Rules": [{ "ID": "abort-incomplete-uploads", "Status": "Enabled", "Filter": { "Prefix": "src/" }, "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 } }]
}'
echo "Bucket $S3_BUCKET ready. Point the CDN at ${S3_ENDPOINT}/${S3_BUCKET}/pub and set MEDIA_PUBLIC_BASE_URL to the CDN address of that prefix."

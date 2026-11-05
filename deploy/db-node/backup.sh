#!/usr/bin/env bash
# Nightly logical backup of the Free Me database to S3-compatible storage, kept for BACKUP_KEEP_DAYS.
# Needs: pg_dump (16), aws CLI; env: DATABASE_URL, BACKUP_S3_URI (s3://bucket/path), AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL (the storage endpoint), optional BACKUP_KEEP_DAYS (default 30).
# Cron (server 3): 15 2 * * * /opt/freeme/backup.sh >> /var/log/freeme-backup.log 2>&1
set -euo pipefail
: "${DATABASE_URL:?}" "${BACKUP_S3_URI:?}"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="/tmp/freeme-${stamp}.dump"
trap 'rm -f "$file"' EXIT
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$file"
pg_restore --list "$file" > /dev/null   # the dump must be readable before it counts as a backup
aws s3 cp "$file" "${BACKUP_S3_URI%/}/freeme-${stamp}.dump" --only-show-errors
echo "$(date -u +%FT%TZ) backup ok: freeme-${stamp}.dump ($(du -h "$file" | cut -f1))"
keep=${BACKUP_KEEP_DAYS:-30}
cutoff=$(date -u -d "-${keep} days" +%Y%m%d)
aws s3 ls "${BACKUP_S3_URI%/}/" | awk '{print $4}' | grep -E '^freeme-[0-9]{8}T' | while read -r name; do
  day=${name:7:8}
  if [[ "$day" < "$cutoff" ]]; then aws s3 rm "${BACKUP_S3_URI%/}/$name" --only-show-errors; echo "removed $name"; fi
done

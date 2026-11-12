#!/usr/bin/env bash
# Restore drill: restores a backup into a scratch database, compares row counts with the live database, records the
# result and drops the scratch database. Run it before launch and every quarter (BACKUP-AND-RECOVERY.md → Drills).
#   sudo -u freeme env $(cat /etc/freeme/backup.env | xargs) ./restore-drill.sh              # newest backup in BACKUP_S3_URI
#   DATABASE_URL=… ./restore-drill.sh /path/to/freeme-20261112T021500Z.dump                  # a dump you already have
# Needs: pg_restore/psql (16), and the aws CLI when no file is given. The live database is only read.
set -euo pipefail
: "${DATABASE_URL:?}"
drill_db="freeme_restore_drill"
base_url="${DATABASE_URL%/*}"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [[ $# -ge 1 ]]; then dump="$1"; else
  : "${BACKUP_S3_URI:?}"
  name=$(aws s3 ls "${BACKUP_S3_URI%/}/" | awk '{print $4}' | grep -E '^freeme-[0-9]{8}T' | sort | tail -1)
  [[ -n "$name" ]] || { echo "No backups found in $BACKUP_S3_URI"; exit 1; }
  dump="$work/$name"; aws s3 cp "${BACKUP_S3_URI%/}/$name" "$dump" --only-show-errors
fi
started=$(date +%s)
psql "$DATABASE_URL" -qc "DROP DATABASE IF EXISTS $drill_db" -c "CREATE DATABASE $drill_db"
pg_restore --no-owner --exit-on-error --dbname="$base_url/$drill_db" "$dump"
took=$(( $(date +%s) - started ))
tables=(User Channel Video VideoRendition WatchHistory Comment Payment RevenueLedger Payout AuditLog)
echo "table live restored"
diff=0
for t in "${tables[@]}"; do
  live=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"$t\"")
  restored=$(psql "$base_url/$drill_db" -Atc "SELECT count(*) FROM \"$t\"")
  echo "$t $live $restored"
  # The live database keeps changing after the dump was taken: restored may be lower, never higher.
  (( restored <= live )) || diff=1
done
psql "$DATABASE_URL" -qc "DROP DATABASE $drill_db"
echo "$(date -u +%FT%TZ) restore drill: $(basename "$dump") restored in ${took}s, $([[ $diff == 0 ]] && echo ok || echo 'MISMATCH (more rows restored than live)')"
exit $diff

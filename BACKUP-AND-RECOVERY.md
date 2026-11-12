# Backup and recovery

## What is backed up

| Data | Where | How | Frequency |
| --- | --- | --- | --- |
| PostgreSQL (all accounts, channels, money records, audit log) | Server 3 | `deploy/ubuntu/backup.sh`: `pg_dump` custom format, checked with `pg_restore --list`, uploaded to S3-compatible storage in another location | Nightly (02:15 UTC), kept 30 days |
| Redis | Server 3 | Append-only file (`/var/lib/redis`) | Continuous; Redis holds rate-limit counters, the job queue and views not yet written (at most 15 s); videos whose processing was interrupted are queued again automatically after 30 minutes |
| Video sources, renditions, thumbnails | Object storage | The provider keeps redundant copies; enable bucket versioning or replication to a second region for protection against deletion | Continuous |

`deploy/ubuntu/install.sh ROLE=db` installs the script as `/usr/local/bin/freeme-backup` and the cron entry (02:15 UTC). Fill `/etc/freeme/backup.env` (mode 600) with `DATABASE_URL`, `BACKUP_S3_URI`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_ENDPOINT_URL`. Keep backups in a different bucket (and ideally a different location) than the videos.

## Restore

```bash
aws s3 cp s3://<bucket>/<path>/freeme-<stamp>.dump /tmp/restore.dump --endpoint-url "$AWS_ENDPOINT_URL"
createdb -h 10.0.1.20 -U freeme freeme_restore
pg_restore --no-owner --dbname=postgresql://freeme:…@10.0.1.20:5432/freeme_restore /tmp/restore.dump
# check row counts and a few known records, then point DATABASE_URL at the restored database and restart the API containers
```

## Targets

- **Recovery point objective:** 24 hours with nightly dumps. Before money starts flowing (phase 4), continuous WAL archiving (e.g. WAL-G to object storage) brings this to minutes; the installer already sets `wal_level=replica` for it.
- **Recovery time objective:** under 2 hours for a full restore at launch size.

## Drills

A restore into a scratch database is performed and recorded before launch and every quarter after: dump date, restore duration, row counts compared with production. A backup that has never been restored is not counted as a backup.

`deploy/ubuntu/restore-drill.sh` does the drill in one step. It downloads the newest backup (or takes a dump file), restores it into a scratch database `freeme_restore_drill`, and compares row counts of the main tables with the live database, which it only reads. It then drops the scratch database and prints one line to paste below. The database role needs `CREATEDB`.

```bash
sudo -u freeme env $(cat /etc/freeme/backup.env | xargs) /opt/freeme/app/deploy/ubuntu/restore-drill.sh
```

Monitoring: after each successful upload, `backup.sh` writes `freeme_backup_last_success_timestamp_seconds` for the node exporter's textfile collector (`/var/lib/prometheus/node-exporter`). The user that runs the backup must be able to write there (`sudo chgrp freeme /var/lib/prometheus/node-exporter && sudo chmod g+w /var/lib/prometheus/node-exporter`). The `BackupTooOld` alert fires when no backup succeeded in 30 hours.

| Date | Backup | Restore time | Result | By |
| --- | --- | --- | --- | --- |
| 2026-11-12 | Test sandbox dump (script check only, not production) | under 1 s | Row counts match | Claude Code |


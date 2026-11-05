# Backup and recovery

## What is backed up

| Data | Where | How | Frequency |
| --- | --- | --- | --- |
| PostgreSQL (all accounts, channels, money records, audit log) | Server 3 | `deploy/db-node/backup.sh`: `pg_dump` custom format, checked with `pg_restore --list`, uploaded to S3-compatible storage in another location | Nightly (02:15 UTC), kept 30 days |
| Redis | Server 3 | Append-only file on a Docker volume | Continuous; Redis holds only rate-limit counters (and queues from phase 2), which can be rebuilt |
| Video files (phase 2) | Object storage | Provider replication/versioning | Continuous |

Install the backup on server 3:

```bash
install -m 700 deploy/db-node/backup.sh /opt/freeme/backup.sh
# /etc/cron.d/freeme-backup (with the variables from ENVIRONMENT.md in /opt/freeme/backup.env, mode 600)
15 2 * * * root set -a; . /opt/freeme/backup.env; set +a; /opt/freeme/backup.sh >> /var/log/freeme-backup.log 2>&1
```

## Restore

```bash
aws s3 cp s3://<bucket>/<path>/freeme-<stamp>.dump /tmp/restore.dump --endpoint-url "$AWS_ENDPOINT_URL"
createdb -h 10.0.1.20 -U freeme freeme_restore
pg_restore --no-owner --dbname=postgresql://freeme:…@10.0.1.20:5432/freeme_restore /tmp/restore.dump
# check row counts and a few known records, then point DATABASE_URL at the restored database and restart the API containers
```

## Targets

- **Recovery point objective:** 24 hours with nightly dumps. Before money starts flowing (phase 4), continuous WAL archiving (e.g. WAL-G to object storage) brings this to minutes; the database compose file already sets `wal_level=replica` for it.
- **Recovery time objective:** under 2 hours for a full restore at launch size.

## Drills

A restore into a scratch database is performed and recorded before launch and every quarter after: dump date, restore duration, row counts compared with production. A backup that has never been restored is not counted as a backup.

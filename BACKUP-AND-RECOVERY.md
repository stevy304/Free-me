# Free Me — Disaster Recovery & Backup Plan

## 1. Objectives & Metrics

- **Recovery Point Objective (RPO)**: $< 5$ minutes (continuous Write-Ahead Log archiving).
- **Recovery Time Objective (RTO)**: $< 30$ minutes for full database restoration to a cold standby instance.

---

## 2. PostgreSQL Automated WAL-G Setup

PostgreSQL on Server 3 is configured to continuously ship WAL (Write-Ahead Logs) to encrypted offsite object storage (Hetzner Storage Box + redundant Wasabi S3 bucket).

### Archive Command in `postgresql.conf`:
```ini
wal_level = replica
archive_mode = on
archive_command = 'wal-g wal-push %p'
archive_timeout = 300
```

### Full Base Backup Cron:
Run nightly at 02:00 CAT (Central Africa Time):
```bash
0 2 * * * /usr/local/bin/wal-g backup-push /var/lib/postgresql/data
```

---

## 3. Disaster Recovery Scenario: Complete Node 3 Failure

If Server 3 hardware suffers an irrecoverable crash:

1. **Spin up Standby Node**: Launch replacement Hetzner server in Nuremberg or Helsinki.
2. **Install PostgreSQL 16 & WAL-G**:
   ```bash
   apt-get install -y postgresql-16 wal-g
   ```
3. **Fetch Latest Base Backup**:
   ```bash
   wal-g backup-fetch /var/lib/postgresql/data LATEST
   ```
4. **Configure Recovery Target**:
   Create `/var/lib/postgresql/data/recovery.signal` and append to `postgresql.conf`:
   ```ini
   restore_command = 'wal-g wal-fetch %f %p'
   ```
5. **Start PostgreSQL**: PostgreSQL replays WAL segments up to the exact minute of failure.
6. **Switch Internal DNS / IP**: Point `10.0.1.20` to the restored node. Application nodes reconnect automatically via connection retry logic.

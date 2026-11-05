#!/usr/bin/env bash
# Free Me server installer for Ubuntu 24.04 LTS (no containers). Run as root on each server with its role:
#
#   sudo ROLE=db    PRIVATE_IP=10.0.1.20 DB_PASSWORD=... REDIS_PASSWORD=... ./install.sh
#   sudo ROLE=app   PRIVATE_IP=10.0.1.11 ./install.sh                  # application node B
#   sudo ROLE=edge  PRIVATE_IP=10.0.1.10 FREEME_DOMAIN=freeme.example ACME_EMAIL=ops@freeme.example ./install.sh   # node A: app + Caddy
#   sudo ROLE=media PRIVATE_IP=10.0.1.30 WORKERS=2 ./install.sh
#
# Common options: PRIVATE_SUBNET (10.0.1.0/24), ADMIN_SSH_FROM (address allowed to SSH; default: anywhere),
# FREEME_REPO, FREEME_REF (git ref to install, default main), APP_NODES ("10.0.1.10 10.0.1.11").
# Safe to run again: it updates packages, code and configuration in place.
set -euo pipefail

ROLE=${ROLE:?set ROLE to db, app, edge or media}
PRIVATE_IP=${PRIVATE_IP:?set PRIVATE_IP (this server on the private network)}
PRIVATE_SUBNET=${PRIVATE_SUBNET:-10.0.1.0/24}
FREEME_REPO=${FREEME_REPO:-https://github.com/stevy304/Free-me.git}
FREEME_REF=${FREEME_REF:-main}
APP_NODES=${APP_NODES:-"10.0.1.10 10.0.1.11"}
HERE=$(cd "$(dirname "$0")" && pwd)
log() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { echo "This installer targets Ubuntu (found $ID)."; exit 1; }

base() {
  log "Base system"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get upgrade -yq
  apt-get install -yq ca-certificates curl gnupg git ufw unattended-upgrades jq
  dpkg-reconfigure -fnoninteractive unattended-upgrades
  timedatectl set-timezone UTC || true
  id freeme >/dev/null 2>&1 || useradd --system --home /opt/freeme --shell /usr/sbin/nologin freeme
  install -d -o freeme -g freeme /opt/freeme /var/lib/freeme
  install -d -o root -g freeme -m 750 /etc/freeme
  log "Firewall (deny by default)"
  ufw --force default deny incoming
  ufw --force default allow outgoing
  if [ -n "${ADMIN_SSH_FROM:-}" ]; then ufw allow from "$ADMIN_SSH_FROM" to any port 22 proto tcp; else ufw allow 22/tcp; echo "Note: SSH is open to all; set ADMIN_SSH_FROM to restrict it."; fi
  ufw --force enable
}

node22() {
  if ! command -v node >/dev/null || ! node -v | grep -q '^v22\.'; then
    log "Node.js 22 LTS"
    install -d -m 755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q && apt-get install -yq nodejs
  fi
}

code() {
  log "Free Me code ($FREEME_REF)"
  if [ ! -d /opt/freeme/app/.git ]; then sudo -u freeme git clone --quiet "$FREEME_REPO" /opt/freeme/app; fi
  sudo -u freeme git -C /opt/freeme/app fetch --quiet --tags origin
  sudo -u freeme git -C /opt/freeme/app checkout --quiet --force "$FREEME_REF"
  sudo -u freeme git -C /opt/freeme/app reset --quiet --hard "origin/$FREEME_REF" 2>/dev/null || true
  cd /opt/freeme/app
  sudo -u freeme npm ci --no-audit --no-fund
  sudo -u freeme npm run build -w @free-me/api
  if [ "$1" = web ]; then sudo -u freeme NEXT_TELEMETRY_DISABLED=1 npm run build -w @free-me/web; fi
}

envfile() {
  if [ ! -f /etc/freeme/freeme.env ]; then
    install -o root -g freeme -m 640 "$HERE/freeme.env.example" /etc/freeme/freeme.env
    echo "Created /etc/freeme/freeme.env from the template: fill it in, then run this installer again."
    exit 2
  fi
  grep -q '^SESSION_SECRET=.\{32,\}' /etc/freeme/freeme.env || { echo "Set SESSION_SECRET (32+ characters) in /etc/freeme/freeme.env."; exit 2; }
}

units() {
  install -m 644 "$HERE"/systemd/*.service /etc/systemd/system/
  systemctl daemon-reload
}

db() {
  : "${DB_PASSWORD:?set DB_PASSWORD}" "${REDIS_PASSWORD:?set REDIS_PASSWORD}"
  log "PostgreSQL 16"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /etc/apt/keyrings/postgresql.gpg
  echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q && apt-get install -yq postgresql-16 postgresql-client-16 redis-server
  local mem_mb; mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  cat > /etc/postgresql/16/main/conf.d/freeme.conf <<CONF
listen_addresses = 'localhost,${PRIVATE_IP}'
max_connections = 300
shared_buffers = $((mem_mb / 4))MB
effective_cache_size = $((mem_mb * 3 / 4))MB
maintenance_work_mem = 1GB
work_mem = 16MB
wal_level = replica
max_wal_size = 8GB
random_page_cost = 1.1
effective_io_concurrency = 200
password_encryption = scram-sha-256
log_min_duration_statement = 500
CONF
  grep -q "freeme-app-nodes" /etc/postgresql/16/main/pg_hba.conf || echo "host freeme freeme ${PRIVATE_SUBNET} scram-sha-256 # freeme-app-nodes" >> /etc/postgresql/16/main/pg_hba.conf
  systemctl restart postgresql
  sudo -u postgres psql -qc "DO \$\$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='freeme') THEN CREATE ROLE freeme LOGIN; END IF; END\$\$;"
  sudo -u postgres psql -qc "ALTER ROLE freeme PASSWORD '${DB_PASSWORD}';"
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='freeme'" | grep -q 1 || sudo -u postgres createdb -O freeme freeme

  log "Redis"
  sed -i -E "s/^#? ?bind .*/bind 127.0.0.1 ${PRIVATE_IP}/; s/^#? ?requirepass .*/requirepass ${REDIS_PASSWORD}/; s/^#? ?appendonly .*/appendonly yes/; s/^#? ?maxmemory-policy .*/maxmemory-policy noeviction/" /etc/redis/redis.conf
  grep -q '^requirepass' /etc/redis/redis.conf || echo "requirepass ${REDIS_PASSWORD}" >> /etc/redis/redis.conf
  systemctl restart redis-server
  for ip in $APP_NODES ${MEDIA_NODE:-10.0.1.30}; do ufw allow from "$ip" to any port 5432 proto tcp; ufw allow from "$ip" to any port 6379 proto tcp; done

  log "Backups"
  command -v aws >/dev/null || snap install aws-cli --classic
  install -m 750 "$HERE/backup.sh" /usr/local/bin/freeme-backup
  [ -f /etc/freeme/backup.env ] || install -m 600 /dev/null /etc/freeme/backup.env
  echo "15 2 * * * root set -a; . /etc/freeme/backup.env; set +a; /usr/local/bin/freeme-backup >> /var/log/freeme-backup.log 2>&1" > /etc/cron.d/freeme-backup
  echo "Fill /etc/freeme/backup.env (DATABASE_URL, BACKUP_S3_URI, AWS_* , AWS_ENDPOINT_URL); see BACKUP-AND-RECOVERY.md."
}

app() {
  envfile; node22; code web; units
  systemctl enable --now freeme-api freeme-web
  systemctl restart freeme-api freeme-web
  for ip in $APP_NODES; do ufw allow from "$ip" to any port 3000 proto tcp; ufw allow from "$ip" to any port 4000 proto tcp; done
}

edge() {
  : "${FREEME_DOMAIN:?set FREEME_DOMAIN}" "${ACME_EMAIL:?set ACME_EMAIL}"
  app
  log "Caddy (HTTPS and load balancing)"
  apt-get install -yq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
  install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
  local a b; read -r a b <<< "$APP_NODES"
  install -d /etc/systemd/system/caddy.service.d
  printf '[Service]\nEnvironment=FREEME_DOMAIN=%s ACME_EMAIL=%s APP_NODE_A=%s APP_NODE_B=%s\n' "$FREEME_DOMAIN" "$ACME_EMAIL" "$a" "${b:-$a}" > /etc/systemd/system/caddy.service.d/freeme.conf
  systemctl daemon-reload && systemctl enable --now caddy && systemctl reload caddy || systemctl restart caddy
  ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
}

media() {
  envfile; node22
  log "FFmpeg"
  apt-get install -yq ffmpeg
  code api; units
  install -d -o freeme -g freeme /var/lib/freeme/scratch
  local n=${WORKERS:-$(( $(nproc) / 8 > 0 ? $(nproc) / 8 : 1 ))}
  for i in $(seq 1 "$n"); do systemctl enable --now "freeme-worker@$i"; systemctl restart "freeme-worker@$i"; done
  echo "Running $n worker instance(s)."
}

base
case "$ROLE" in
  db) db ;;
  app) app ;;
  edge) edge ;;
  media) media ;;
  *) echo "Unknown ROLE $ROLE"; exit 1 ;;
esac
log "Done: $ROLE on $PRIVATE_IP"

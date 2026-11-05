#!/usr/bin/env bash
# Rolls out a new version on this server (run as root): fetch the ref, install, build, migrate (MIGRATE=1, on one
# application node only, before the others), restart, wait for health. Run on node B first, then node A, then media.
#   sudo FREEME_REF=v0.2.0 MIGRATE=1 ./release.sh
set -euo pipefail
REF=${FREEME_REF:-main}
cd /opt/freeme/app
sudo -u freeme git fetch --quiet --tags origin
sudo -u freeme git checkout --quiet --force "$REF"
sudo -u freeme git reset --quiet --hard "origin/$REF" 2>/dev/null || true
sudo -u freeme npm ci --no-audit --no-fund
sudo -u freeme npm run build -w @free-me/api
if systemctl list-unit-files freeme-web.service >/dev/null 2>&1 && systemctl is-enabled --quiet freeme-web; then sudo -u freeme NEXT_TELEMETRY_DISABLED=1 npm run build -w @free-me/web; fi
if [ "${MIGRATE:-0}" = 1 ]; then
  echo "Applying database migrations"
  sudo -u freeme bash -c 'set -a; . /etc/freeme/freeme.env; set +a; npx prisma migrate deploy && npm run db:seed'
fi
for unit in freeme-api freeme-web $(systemctl list-units --plain --no-legend 'freeme-worker@*' | awk '{print $1}'); do
  systemctl is-enabled --quiet "$unit" 2>/dev/null || continue
  systemctl restart "$unit"; echo "restarted $unit"
done
if systemctl is-active --quiet freeme-api; then
  for i in $(seq 1 30); do curl -fsS http://127.0.0.1:4000/api/health >/dev/null && { echo "API healthy"; break; }; sleep 2; [ "$i" = 30 ] && { echo "API did not become healthy"; journalctl -u freeme-api -n 50 --no-pager; exit 1; }; done
fi
echo "Release $REF done on $(hostname)"

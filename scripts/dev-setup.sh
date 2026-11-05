#!/usr/bin/env bash
# One-time setup of the local services Free Me needs, on Ubuntu or Debian (including GitHub Codespaces).
# Installs PostgreSQL, Redis and FFmpeg with apt. No containers. Safe to run again.
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
need=()
command -v psql >/dev/null 2>&1 || need+=(postgresql postgresql-contrib)
command -v redis-server >/dev/null 2>&1 || need+=(redis-server)
command -v ffmpeg >/dev/null 2>&1 || need+=(ffmpeg)
if [ ${#need[@]} -gt 0 ]; then
  echo "Installing: ${need[*]}"
  $SUDO apt-get update -q
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -yq "${need[@]}"
else
  echo "PostgreSQL, Redis and FFmpeg are already installed."
fi

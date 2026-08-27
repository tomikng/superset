#!/bin/bash
# Nightly logical backup of the Superset Postgres cluster on host ms1.
# Runs pg_dump INSIDE the container so the dump tool version always matches the
# server version (postgres:17) — no Homebrew libpq version skew.
set -euo pipefail

# Paths default to this script's own directory, which is the deploy/ directory
# holding docker-compose.prod.yml and .env.docker (conventionally <clone>/deploy —
# the same location smoke-test.sh and the launchd stack job assume). Override by
# exporting ENV_FILE / BACKUP_DIR before running.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env.docker}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$SCRIPT_DIR")/backups}"
# container_name in docker-compose.prod.yml (project name `superset`).
CONTAINER="${CONTAINER:-superset-postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/superset-$STAMP.dump"

# -Fc = custom format: compressed, and restorable selectively with pg_restore.
docker exec \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-privileges \
  > "$OUT.partial"

# Only promote to a real filename once pg_dump exited 0, so a truncated dump
# from a mid-run reboot is never mistaken for a good backup.
mv "$OUT.partial" "$OUT"
chmod 600 "$OUT"

# Prune old dumps and any partials left by a failed run.
find "$BACKUP_DIR" -name 'superset-*.dump' -type f -mtime +$RETENTION_DAYS -delete
find "$BACKUP_DIR" -name 'superset-*.dump.partial' -type f -mtime +1 -delete

echo "$(date -Iseconds) ok $OUT ($(du -h "$OUT" | cut -f1))"

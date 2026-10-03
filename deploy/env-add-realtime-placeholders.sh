#!/usr/bin/env bash
# One-off for the 1.35.0 upgrade: append the realtime placeholders that
# apps/web/src/env.ts requires at boot (NEXT_PUBLIC_REALTIME_URL) and that keep
# packages/trpc from defaulting REALTIME_URL to upstream's hosted service, to
# the live self-host .env. Idempotent. Run on ms3 BEFORE the 1.35.0 deploy:
#
#   ssh ms3 'bash -s' < deploy/env-add-realtime-placeholders.sh
#
# Values mirror deploy/env.production.template section 2.10b.
set -euo pipefail
ENV_FILE="${1:-$HOME/Code/superset/.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE" >&2; exit 1; }
if grep -q '^NEXT_PUBLIC_REALTIME_URL=' "$ENV_FILE"; then
  echo "NEXT_PUBLIC_REALTIME_URL already present in $ENV_FILE — nothing to do"
  exit 0
fi
cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
# An existing REALTIME_URL (empty in older templates) would shadow ours.
sed -i.tmp '/^REALTIME_URL=/d' "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
cat >>"$ENV_FILE" <<'EOF'

# --- Realtime placeholders (NEXT_PUBLIC_REALTIME_URL required since 1.35) ----
# See deploy/env.production.template section 2.10b. Point both at a deployed
# apps/realtime to make page storage and live nudges work.
REALTIME_URL=http://127.0.0.1:9
NEXT_PUBLIC_REALTIME_URL=http://127.0.0.1:9
EOF
echo "appended realtime placeholders to $ENV_FILE (backup kept next to it)"
grep -c '^\(NEXT_PUBLIC_\)\?REALTIME_URL=' "$ENV_FILE"

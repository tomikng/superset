#!/usr/bin/env bash
# One-off for the 1.25.6 upgrade: append the R2 / usercontent placeholders that
# packages/trpc/src/env.ts requires at boot since upstream #7078 / #7061 to the
# live self-host .env. Idempotent. Run on ms1 BEFORE the `selfhost` deploy:
#
#   ssh ms1 'bash -s' < deploy/env-add-r2-placeholders.sh
#
# Values mirror deploy/env.production.template section 2.10 — they keep the
# instance booting; uploads keep failing at the storage call as they did with
# the Vercel Blob placeholder.
set -euo pipefail
ENV_FILE="${1:-$HOME/Code/superset/.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE" >&2; exit 1; }
if grep -q '^R2_PUBLIC_BUCKET=' "$ENV_FILE"; then
  echo "R2_PUBLIC_BUCKET already present in $ENV_FILE — nothing to do"
  exit 0
fi
cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
cat >>"$ENV_FILE" <<'EOF'

# --- Object storage placeholders (required at boot since upstream #7078) ------
# See deploy/env.production.template section 2.10. Replace with real R2 values
# to make avatar/logo uploads, attachments and page publishing work.
CLOUDFLARE_ACCOUNT_ID=unused-selfhosted
R2_ACCESS_KEY_ID=unused-selfhosted
R2_SECRET_ACCESS_KEY=unused-selfhosted
R2_PRIVATE_BUCKET=superset-private-unused
R2_PUBLIC_BUCKET=superset-public-unused
R2_ENDPOINT=http://127.0.0.1:9
USERCONTENT_URL=https://usercontent.invalid
STATIC_URL=https://static.invalid
USERCONTENT_TOKEN_SECRET=unused-selfhosted-usercontent-token-secret-placeholder
EOF
echo "appended R2 placeholders to $ENV_FILE (backup kept next to it)"
grep -c '^\(CLOUDFLARE_ACCOUNT_ID\|R2_[A-Z_]*\|USERCONTENT_URL\|STATIC_URL\|USERCONTENT_TOKEN_SECRET\)=' "$ENV_FILE"

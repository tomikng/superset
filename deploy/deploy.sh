#!/usr/bin/env bash
# Deploy the checked-out `selfhost` tree on ms1: install if the lockfile moved,
# migrate if packages/db/drizzle moved, rebuild only the apps whose inputs
# changed, restart only those launchd services, health-check, notify Discord.
#
#   deploy/deploy.sh [PREVIOUS_SHA]
#
# PREVIOUS_SHA is the commit that was running before the tree was advanced
# (deploy-selfhost.yml passes it). Without it everything is rebuilt/restarted.
# Runs from the live clone (the same one the launchd plists point at). It never
# fetches or merges — the caller advances the tree, this script realises it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
LOG_DIR="$HOME/Library/Logs/superset"; mkdir -p "$LOG_DIR"
DOMAIN="gui/$(id -u)"
PREV="${1:-}"
NEW="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
SUBJECT="$(git log -1 --format=%s)"

# Discord webhook lives in the same untracked file check-upstream.sh uses.
[ -f "$HOME/.superset-selfhost.env" ] && . "$HOME/.superset-selfhost.env"
notify() {   # notify <emoji> <text>
  [ -z "${DISCORD_WEBHOOK_URL:-}" ] && return 0
  local payload
  payload="$(printf '%s' "$1 **ms1 deploy** \`$SHORT\` — $2"$'\n'"$SUBJECT" | python3 -c 'import json,sys; print(json.dumps({"content": sys.stdin.read()}))')"
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "$payload" "$DISCORD_WEBHOOK_URL" >/dev/null || true
}
fail() { echo "deploy: $1" >&2; notify "❌" "$1"; exit 1; }
trap 'notify "❌" "died at line $LINENO (see $LOG_DIR/deploy.log)"' ERR

# One deploy at a time. mkdir is atomic; a stale lock means a crashed run, so
# the next run clears anything older than 30 minutes.
LOCK="$ROOT/.deploy.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30)" ]; then rmdir "$LOCK"; mkdir "$LOCK"; else fail "another deploy is running"; fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

[ -z "$(git status --porcelain)" ] || fail "working tree is dirty; refusing"

# --- what changed --------------------------------------------------------
if [ -n "$PREV" ] && git cat-file -e "$PREV" 2>/dev/null; then
  CHANGED="$(git diff --name-only "$PREV" "$NEW")"
else
  CHANGED="EVERYTHING"
fi
# A here-string, not a pipe: `grep -q` exits at the first match and a large
# diff then kills printf with SIGPIPE, which pipefail reports as "not touched".
touched() { [ "$CHANGED" = "EVERYTHING" ] || grep -q -E "$1" <<<"$CHANGED"; }

SHARED='^(packages/|bun\.lock$|package\.json$|turbo\.jsonc?$|\.bun-version$|tsconfig)'
NEED_INSTALL=0; NEED_MIGRATE=0; BUILD=(); RESTART=()
touched '^bun\.lock$'                 && NEED_INSTALL=1
touched '^packages/db/drizzle/'       && NEED_MIGRATE=1
touched "^apps/api/|$SHARED"          && { BUILD+=(--filter=@superset/api); RESTART+=(api); }
touched "^apps/web/|$SHARED"          && { BUILD+=(--filter=@superset/web); RESTART+=(web); }
touched "^apps/relay/|$SHARED"        && RESTART+=(relay)   # relay runs from source, no build
if [ ${#RESTART[@]} -eq 0 ] && [ $NEED_MIGRATE -eq 0 ]; then
  echo "deploy: $SHORT touches no service; nothing to do"; exit 0
fi
echo "deploy: $PREV -> $NEW install=$NEED_INSTALL migrate=$NEED_MIGRATE build=[${BUILD[*]:-}] restart=[${RESTART[*]:-}]"

# --- env: same rules as deploy/launchd/README.md step 3 --------------------
set -a; . "$ROOT/.env"; set +a
unset SUPERSET_ALLOW_SIGNUP

[ $NEED_INSTALL -eq 1 ] && bun install --frozen
[ $NEED_MIGRATE -eq 1 ] && bun run db:migrate
if [ ${#BUILD[@]} -gt 0 ]; then
  # --env-mode=loose: turbo's strict mode strips RELAY_URL & co. from the build
  # env and the web CSP silently falls back to relay.superset.sh.
  bunx turbo build "${BUILD[@]}" --env-mode=loose
fi

for svc in ${RESTART[@]+"${RESTART[@]}"}; do
  launchctl kickstart -k "$DOMAIN/dev.tom-nguyen.superset.$svc"
done

# --- health --------------------------------------------------------------
check() {   # check <name> <url> <expected-code-regex>
  local i code
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$2" || true)"
    [[ "$code" =~ $3 ]] && { echo "  $1 ok ($code)"; return 0; }
    sleep 3
  done
  fail "$1 unhealthy after restart (last HTTP $code)"
}
for svc in ${RESTART[@]+"${RESTART[@]}"}; do
  case "$svc" in
    api)   check api   "http://127.0.0.1:3101/api/auth/ok"        '^200$' ;;
    web)   check web   "http://127.0.0.1:${PORT:-3100}/sign-in"    '^(200|307)$' ;;
    relay) check relay "http://127.0.0.1:${RELAY_PORT:-3102}/"     '^[2-4][0-9][0-9]$' ;;
  esac
done

notify "✅" "restarted ${RESTART[*]:-}"
echo "deploy: done"

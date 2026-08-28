#!/usr/bin/env bash
#
# Unattended TestFlight upload from this Mac (launchd, monthly — see
# dev.tom-nguyen.superset.testflight.plist next to this file). Builds the
# branch that is checked out (fast-forwarded from origin when the tree is
# clean — it never switches branches under you), runs testflight.sh and
# reports the outcome to Discord. Credentials come from ~/.superset-selfhost.env
# (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, DISCORD_WEBHOOK_URL).
#
#   apps/mobile/scripts/testflight-cron.sh            # build + upload
#   SKIP_UPLOAD=1 apps/mobile/scripts/testflight-cron.sh   # rehearse
set -uo pipefail
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -f "$HOME/.superset-selfhost.env" ] && . "$HOME/.superset-selfhost.env"

cd "$(dirname "$0")/../../.."
LOG_DIR="$HOME/Library/Logs/superset"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/testflight-$(date +%Y%m%d-%H%M%S).log"
BRANCH=$(git rev-parse --abbrev-ref HEAD)

notify() { # $1 = message
  [ -n "${DISCORD_WEBHOOK_URL:-}" ] || return 0
  jq -n --arg c "$1" '{content:$c}' | curl -sf -H 'Content-Type: application/json' -d @- "$DISCORD_WEBHOOK_URL" >/dev/null || true
}

{
  echo "== $(date) testflight-cron on $(hostname) branch $BRANCH"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "working tree has uncommitted changes; building it as-is"
  else
    git fetch -q origin "$BRANCH" && git merge -q --ff-only "origin/$BRANCH" || echo "not fast-forwardable from origin/$BRANCH; building local HEAD"
  fi
  git log --oneline -1
  bun install --frozen-lockfile
  apps/mobile/scripts/testflight.sh
} >"$LOG" 2>&1
status=$?

sha=$(git rev-parse --short HEAD)
build=$(grep -o '==> build [0-9]*' "$LOG" | head -1 | awk '{print $3}')
if [ "$status" -eq 0 ]; then
  if [ "${SKIP_UPLOAD:-0}" = 1 ]; then
    notify "📱 TestFlight rehearsal OK (${sha}, build ${build:-?}) — archive+export fine, upload skipped."
  else
    notify "📱 TestFlight upload OK: build ${build:-?} from \`${sha}\` (${BRANCH}). Processing takes ~10 min, then it's in the TestFlight app."
  fi
else
  tail_txt=$(grep -E "error|failed" "$LOG" | tail -5 | cut -c1-300)
  notify "❌ TestFlight upload FAILED (${sha}, exit ${status}). Log: ${LOG}"$'\n```\n'"${tail_txt}"$'\n```'
fi
echo "exit $status, log $LOG"
exit "$status"

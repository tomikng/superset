#!/usr/bin/env bash
#
# Publish the current JS to the phone over the air (EAS Update, channel
# "selfhost"). Seconds instead of a TestFlight round-trip — but only for JS,
# assets and config: the update is stamped with a fingerprint of the native
# side, and a binary only applies updates with its own fingerprint. If this
# prints a fingerprint that no installed build has, you need a TestFlight
# build (scripts/testflight-cron.sh) — nothing breaks, the update is ignored.
#
#   apps/mobile/scripts/ota.sh                 # message = last commit subject
#   apps/mobile/scripts/ota.sh "fix composer"  # custom message
#
# Needs `eas login` once on this machine (or EXPO_TOKEN in the environment).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.superset-selfhost.env" ] && . "$HOME/.superset-selfhost.env"
if ! command -v node >/dev/null 2>&1; then
  nvm_default=$(cat "$HOME/.nvm/alias/default" 2>/dev/null || true)
  nvm_node=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | { [ -n "$nvm_default" ] && grep "/v${nvm_default#v}[./]" || cat; } | sort -V | tail -1)
  export PATH="${nvm_node:-/opt/homebrew/opt/node/bin}:$PATH"
fi
export PATH="$HOME/.bun/bin:$PATH"

msg="${1:-$(git log -1 --pretty=%s)}"
eas update --channel selfhost --platform ios --message "$msg" --non-interactive 2>&1 \
  | grep -vE "eas-cli@|To upgrade|npm install -g|Proceeding with outdated"

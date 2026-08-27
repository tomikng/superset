#!/usr/bin/env bash
# Install the Superset launchd agents on ms1.
#
#   ./install.sh /Users/<deploy-user>/superset [/path/to/deploy]
#
# The second argument is the directory holding docker-compose.prod.yml and
# .env.docker. It defaults to the parent of this script (i.e. deploy/), which is
# conventionally <clone>/deploy — the same path pg-backup.sh and OPERATING-NOTES
# assume.
#
# Substitutes the __PLACEHOLDER__ tokens in the .plist files with paths resolved
# on THIS machine, writes them to ~/Library/LaunchAgents, and bootstraps them.
# Re-runnable: it boots out an existing job before replacing its plist.
set -euo pipefail

SUPERSET_ROOT="${1:-}"
if [ -z "$SUPERSET_ROOT" ]; then
  echo "usage: $0 /absolute/path/to/superset/clone" >&2
  exit 64
fi
SUPERSET_ROOT="$(cd "$HOME/$SUPERSET_ROOT" && pwd -P)"

SRC_DIR="$(cd "$(dirname "$0")" && pwd -P)"
DEPLOY_DIR="${2:-$(dirname "$SRC_DIR")}"
DEPLOY_DIR="$(cd "$DEPLOY_DIR" && pwd -P)"

[ -f "$SUPERSET_ROOT/package.json" ] || { echo "no package.json in $SUPERSET_ROOT" >&2; exit 1; }
[ -f "$SUPERSET_ROOT/.env" ]         || { echo "no .env in $SUPERSET_ROOT — build it from deploy/env.production.template first" >&2; exit 1; }
# The stack job runs deploy/docker-compose.prod.yml with deploy/.env.docker as
# compose's --env-file. The repo-root docker-compose.yml is the DEV stack
# (postgres/postgres, SRH_TOKEN=local_dev_token) and is deliberately not used.
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] || { echo "no docker-compose.prod.yml in $DEPLOY_DIR" >&2; exit 1; }
[ -f "$DEPLOY_DIR/.env.docker" ]             || { echo "no .env.docker in $DEPLOY_DIR — cp .env.docker.example .env.docker, fill it in, chmod 600" >&2; exit 1; }
# SRH_TOKEN (compose) and KV_REST_API_TOKEN (app .env) are ONE secret under two
# names. A mismatch makes the relay's host directory fail every call with 401,
# which looks like "hosts never come online" and nothing else.
DOCKER_SRH="$(grep -E '^SRH_TOKEN=' "$DEPLOY_DIR/.env.docker" | tail -n1 | cut -d= -f2-)"
APP_KV="$(grep -E '^KV_REST_API_TOKEN=' "$SUPERSET_ROOT/.env" | tail -n1 | cut -d= -f2-)"
if [ -n "$DOCKER_SRH" ] && [ -n "$APP_KV" ] && [ "$DOCKER_SRH" != "$APP_KV" ]; then
  echo "SRH_TOKEN in $DEPLOY_DIR/.env.docker != KV_REST_API_TOKEN in $SUPERSET_ROOT/.env" >&2
  exit 1
fi

# --- resolve bun -------------------------------------------------------------
# `command -v` here runs in THIS interactive-ish shell, which is the only place
# bun is on PATH. launchd will get the absolute path baked into the plist.
BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] || { echo "bun not on PATH; see README 'Finding the bun binary'" >&2; exit 1; }
# Resolve symlinks/shims (mise, asdf, Homebrew) down to the real executable.
BUN_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$BUN_BIN")"
BUN_DIR="$(dirname "$BUN_BIN")"
BUN_VER="$("$BUN_BIN" --version)"
PINNED="$(cat "$SUPERSET_ROOT/.bun-version")"
[ "$BUN_VER" = "$PINNED" ] || echo "WARNING: bun $BUN_VER != .bun-version $PINNED" >&2

# --- resolve docker ----------------------------------------------------------
DOCKER_BIN="$(command -v docker || true)"
[ -n "$DOCKER_BIN" ] || { echo "docker not on PATH (Docker Desktop or OrbStack)" >&2; exit 1; }
DOCKER_BIN="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DOCKER_BIN")"

echo "root:   $SUPERSET_ROOT"
echo "deploy: $DEPLOY_DIR"
echo "bun:    $BUN_BIN ($BUN_VER)"
echo "docker: $DOCKER_BIN"

# launchd does NOT create log directories. A missing directory makes the job
# fail to spawn with no output anywhere obvious.
mkdir -p "$HOME/Library/Logs/superset"
mkdir -p "$HOME/Library/LaunchAgents"

DOMAIN="gui/$(id -u)"

for svc in stack api web relay releases; do
  LABEL="dev.tom-nguyen.superset.$svc"
  DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

  sed \
    -e "s|__SUPERSET_ROOT__|$SUPERSET_ROOT|g" \
    -e "s|__DEPLOY_DIR__|$DEPLOY_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__BUN_BIN__|$BUN_BIN|g" \
    -e "s|__BUN_DIR__|$BUN_DIR|g" \
    -e "s|__DOCKER_BIN__|$DOCKER_BIN|g" \
    "$SRC_DIR/$LABEL.plist" > "$DEST"

  # Fails loudly on a malformed plist instead of at bootstrap time.
  plutil -lint "$DEST"
  chmod 644 "$DEST"
done

# Bring the compose stack up first, then the apps.
for svc in stack api web relay releases; do
  LABEL="dev.tom-nguyen.superset.$svc"
  launchctl bootstrap "$DOMAIN" "$HOME/Library/LaunchAgents/$LABEL.plist"
  launchctl enable "$DOMAIN/$LABEL"
  echo "bootstrapped $LABEL"
done

echo
echo "tail -F ~/Library/Logs/superset/*.log"

#!/usr/bin/env bash
# Build the self-hosted desktop app for Arch-based Linux (pacman, x64). The
# Linux counterpart of deploy/release-desktop-local.sh; publish the result with
# deploy/publish-desktop-feed.sh linux.
#
#   deploy/release-desktop-linux.sh
#
# Needs ~/.superset-selfhost.env with the public URLs and
# DESKTOP_UPDATE_FEED_URL, and a machine with real memory: compile:app runs
# Node with an 8 GB heap, so the 6.5 GB ms3 cannot build this.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
VER="$(node -p "require('$DESKTOP/package.json').version")"

step() { printf '\n=== %s  (%s)\n' "$1" "$(date +%H:%M:%S)"; }
fail() { echo "FAILED: $*" >&2; exit 1; }

step "preflight"
[ "$(bun --version)" = "$(cat "$ROOT/.bun-version")" ] || fail "bun $(bun --version) on PATH, .bun-version wants $(cat "$ROOT/.bun-version")"
[ -f "$HOME/.superset-selfhost.env" ] || fail "~/.superset-selfhost.env missing"
set -a; . "$HOME/.superset-selfhost.env"; set +a
for v in NEXT_PUBLIC_API_URL NEXT_PUBLIC_WEB_URL DESKTOP_UPDATE_FEED_URL; do
  [ -n "${!v:-}" ] || fail "$v is not set in ~/.superset-selfhost.env"
done
case "$DESKTOP_UPDATE_FEED_URL" in *superset.sh*) fail "DESKTOP_UPDATE_FEED_URL points at upstream: $DESKTOP_UPDATE_FEED_URL";; esac
mem_gb=$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo)
[ "$mem_gb" -ge 12 ] || fail "only ${mem_gb} GB RAM; compile:app needs ~10 GB"
echo "version: $VER  api: $NEXT_PUBLIC_API_URL  feed: $DESKTOP_UPDATE_FEED_URL"

step "bun install --frozen"
cd "$ROOT" && bun install --frozen

step "compile"
cd "$DESKTOP"
export NODE_ENV=production SUPERSET_WORKSPACE_NAME=superset
export NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-phc_unused_selfhosted}"
export NEXT_PUBLIC_POSTHOG_HOST="${NEXT_PUBLIC_POSTHOG_HOST:-https://us.i.posthog.com}"
rm -f release/*.pacman release/latest-linux.yml
bun run install:deps
bun run prebuild

step "package (pacman)"
bun run package -- --publish never --linux pacman --x64

step "verify"
[ -f "release/superset-$VER-x64.pacman" ] || fail "release/superset-$VER-x64.pacman not produced"
grep -q "^version: $VER$" release/latest-linux.yml || fail "latest-linux.yml does not say version $VER"
echo "built release/superset-$VER-x64.pacman"

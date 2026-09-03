#!/usr/bin/env bash
# Build, Developer-ID sign, notarize and staple the self-hosted desktop app
# (macOS arm64) on this machine. Codifies .agents/skills/desktop-release-local/SKILL.md.
#
#   deploy/release-desktop-local.sh            # detaches itself, prints the log path
#   deploy/release-desktop-local.sh --run      # foreground (what the detached copy runs)
#
# Needs ~/.superset-selfhost.env (chmod 600) with the public URLs, CSC_NAME,
# APPLE_TEAM_ID, DESKTOP_UPDATE_FEED_URL and the ASC_KEY_ID / ASC_ISSUER_ID /
# ASC_KEY_P8 (path to the .p8) notarization key. Nothing is published: see
# deploy/publish-desktop-feed.sh for that.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
VER="$(node -p "require('$DESKTOP/package.json').version")"
LOG="$DESKTOP/release-build-$VER.log"

if [ "${1:-}" != "--run" ]; then
  # The harness kills long foreground jobs; the build takes 15-25 minutes.
  nohup "$0" --run >"$LOG" 2>&1 &
  disown
  echo "building Superset $VER in the background"
  echo "log:  $LOG"
  echo "done: $DESKTOP/release/BUILD_OK appears (or BUILD_FAILED)"
  exit 0
fi

step() { printf '\n=== %s  (%s)\n' "$1" "$(date +%H:%M:%S)"; }
fail() { echo "FAILED: $*" >&2; touch "$DESKTOP/release/BUILD_FAILED" 2>/dev/null || true; exit 1; }
trap 'rc=$?; [ $rc -ne 0 ] && { mkdir -p "$DESKTOP/release"; touch "$DESKTOP/release/BUILD_FAILED"; }' EXIT

step "preflight"
export PATH="$HOME/.bun/bin:$PATH"
[ "$(bun --version)" = "$(cat "$ROOT/.bun-version")" ] || fail "bun $(bun --version) on PATH, .bun-version wants $(cat "$ROOT/.bun-version")"
free_gb=$(df -g / | awk 'NR==2{print $4}')
[ "$free_gb" -ge 8 ] || fail "only ${free_gb} GB free on /, need >= 8"
[ -f "$HOME/.superset-selfhost.env" ] || fail "~/.superset-selfhost.env missing"
set -a; . "$HOME/.superset-selfhost.env"; set +a
for v in NEXT_PUBLIC_API_URL NEXT_PUBLIC_WEB_URL DESKTOP_UPDATE_FEED_URL CSC_NAME APPLE_TEAM_ID ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8; do
  [ -n "${!v:-}" ] || fail "$v is not set in ~/.superset-selfhost.env"
done
[ -f "$ASC_KEY_P8" ] || fail "ASC_KEY_P8 does not point at a file: $ASC_KEY_P8"
case "$DESKTOP_UPDATE_FEED_URL" in *superset.sh*) fail "DESKTOP_UPDATE_FEED_URL points at upstream: $DESKTOP_UPDATE_FEED_URL";; esac
security find-identity -v -p codesigning | grep -q "Developer ID Application: $CSC_NAME" || fail "Developer ID Application certificate for CSC_NAME not in the login keychain"
echo "branch:  $(git -C "$ROOT" branch --show-current) @ $(git -C "$ROOT" rev-parse --short HEAD)"
echo "version: $VER"
echo "api:     $NEXT_PUBLIC_API_URL"
echo "feed:    $DESKTOP_UPDATE_FEED_URL"
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || echo "WARNING: working tree has uncommitted changes"

# Archive the previous release's artifacts outside the repo: Biome scans every
# untracked directory, and the .app bundle carries JSON it would flag.
ARCHIVE="$HOME/superset-desktop-releases"
if [ -d "$DESKTOP/release" ]; then
  prev=$(ls "$DESKTOP/release" 2>/dev/null | sed -n 's/^Superset-\([0-9.]*\)-arm64\.dmg$/\1/p' | head -1)
  if [ -n "$prev" ] && [ "$prev" != "$VER" ]; then
    mkdir -p "$ARCHIVE"
    rm -rf "$ARCHIVE/$prev"
    mv "$DESKTOP/release" "$ARCHIVE/$prev"
    echo "archived previous artifacts to $ARCHIVE/$prev"
  fi
fi
mkdir -p "$DESKTOP/release"
rm -f "$DESKTOP/release/BUILD_OK" "$DESKTOP/release/BUILD_FAILED"

step "bun install --frozen"
cd "$ROOT" && bun install --frozen

step "compile"
cd "$DESKTOP"
export NODE_ENV=production TARGET_ARCH=arm64 SUPERSET_WORKSPACE_NAME=superset
export NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY:-phc_unused_selfhosted}"
export NEXT_PUBLIC_POSTHOG_HOST="${NEXT_PUBLIC_POSTHOG_HOST:-https://us.i.posthog.com}"
bun run install:deps
bun run clean:dev
bun run generate:icons
bun run compile:app
bun run copy:native-modules
bun run validate:native-runtime

step "package + notarize the .app (ASC API key)"
export APPLE_API_KEY="$ASC_KEY_P8" APPLE_API_KEY_ID="$ASC_KEY_ID" APPLE_API_ISSUER="$ASC_ISSUER_ID"
unset APPLE_KEYCHAIN_PROFILE
bun run package -- --publish never --config electron-builder.ts --arm64

step "sign, notarize, staple the DMG"
cd "$DESKTOP/release"
DMG="Superset-$VER-arm64.dmg"
[ -f "$DMG" ] || fail "$DMG not produced"
codesign --force -s "$APPLE_TEAM_ID" "$DMG"
xcrun notarytool submit "$DMG" --key "$ASC_KEY_P8" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
xcrun stapler staple "$DMG"

step "verify"
spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | grep -q "Notarized Developer ID" || fail "DMG is not accepted as Notarized Developer ID"
spctl -a -t exec -vv mac-arm64/Superset.app 2>&1 | grep -q "Notarized Developer ID" || fail ".app is not accepted as Notarized Developer ID"
xcrun stapler validate "$DMG"
xcrun stapler validate mac-arm64/Superset.app
grep -q "^version: $VER$" latest-mac.yml || fail "latest-mac.yml does not say version $VER"
grep -q "Superset-$VER-arm64-mac.zip" latest-mac.yml || fail "latest-mac.yml does not reference the $VER zip"
ls -la "Superset-$VER-arm64-mac.zip" "Superset-$VER-arm64-mac.zip.blockmap" "$DMG" latest-mac.yml
shasum -a 256 "$DMG" "Superset-$VER-arm64-mac.zip"
touch BUILD_OK
step "BUILD OK — Superset $VER"

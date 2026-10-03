#!/usr/bin/env bash
# Publish built desktop artifacts to the self-host update feed: the static
# `releases` service on the feed host serving ~/superset-releases at
# $DESKTOP_UPDATE_FEED_URL (deploy/releases-server.ts).
#
#   deploy/publish-desktop-feed.sh mac     # from apps/desktop/release on the Mac
#   deploy/publish-desktop-feed.sh linux   # from apps/desktop/release on Linux
#
# Order matters: latest-*.yml names the installer by filename and sha512, so
# the installer goes up first and the yml last — an app checking in between
# never gets a 404. FEED_HOST is an ssh alias for the feed host (default ms3);
# when this already runs on it, files are copied locally instead.
set -euo pipefail

PLATFORM="${1:?usage: $0 mac|linux}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL="$ROOT/apps/desktop/release"
VER="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
FEED_HOST="${FEED_HOST:-ms3}"
FEED_DIR="${FEED_DIR:-superset-releases}"
[ -f "$HOME/.superset-selfhost.env" ] && { set -a; . "$HOME/.superset-selfhost.env"; set +a; }
: "${DESKTOP_UPDATE_FEED_URL:?DESKTOP_UPDATE_FEED_URL is not set (~/.superset-selfhost.env)}"

case "$PLATFORM" in
  mac)
    FILES=("Superset-$VER-arm64-mac.zip" "Superset-$VER-arm64-mac.zip.blockmap" "Superset-$VER-arm64.dmg")
    YML=latest-mac.yml
    CHECK="Superset-$VER-arm64-mac.zip" ;;
  linux)
    FILES=("superset-$VER-x64.pacman")
    YML=latest-linux.yml
    CHECK="superset-$VER-x64.pacman" ;;
  *) echo "unknown platform: $PLATFORM" >&2; exit 64 ;;
esac

cd "$REL"
for f in "${FILES[@]}" "$YML"; do [ -f "$f" ] || { echo "missing $REL/$f" >&2; exit 1; }; done
grep -q "^version: $VER$" "$YML" || { echo "$YML is not version $VER" >&2; exit 1; }

if [ "$(hostname -s)" = "$FEED_HOST" ]; then
  put() { mkdir -p "$HOME/$FEED_DIR" && cp "$@" "$HOME/$FEED_DIR/"; }
  run() { bash -c "$1"; }
else
  put() { ssh "$FEED_HOST" "mkdir -p ~/$FEED_DIR" && scp -q "$@" "$FEED_HOST:$FEED_DIR/"; }
  run() { ssh "$FEED_HOST" "$1"; }
fi

echo "publishing $PLATFORM $VER to $FEED_HOST:~/$FEED_DIR"
put "${FILES[@]}"
# The web "Download for Mac" button links to this stable name.
[ "$PLATFORM" = mac ] && run "cp ~/$FEED_DIR/Superset-$VER-arm64.dmg ~/$FEED_DIR/Superset-arm64.dmg"
put "$YML"

curl -fsS "$DESKTOP_UPDATE_FEED_URL/$YML" | grep -q "^version: $VER$" \
  || { echo "feed does not serve $YML version $VER" >&2; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' -I "$DESKTOP_UPDATE_FEED_URL/$CHECK")" = 200 ] \
  || { echo "$CHECK is not downloadable from the feed" >&2; exit 1; }
echo "feed serves $PLATFORM $VER"

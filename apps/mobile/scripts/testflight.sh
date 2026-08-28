#!/usr/bin/env bash
#
# Build the self-host mobile app and upload it to TestFlight.
#
# Runs the same way on a laptop and on the ms1 GitHub runner
# (.github/workflows/testflight-mobile.yml). Signing is Xcode "cloud signing":
# an App Store Connect API key lets xcodebuild mint the distribution
# certificate and the App Store provisioning profile itself, so no .p12 or
# .mobileprovision ever has to be exported or stored.
#
# Required env:
#   ASC_KEY_ID        App Store Connect API key id (e.g. AB12CD34EF)
#   ASC_ISSUER_ID     App Store Connect issuer id (UUID)
#   ASC_KEY_P8        the key: either a path to the .p8 file, or its contents
#                     base64-encoded (what a CI secret holds)
# Optional:
#   APPLE_TEAM_ID         default Q89XY3A42H (must match app.config.ts)
#   MOBILE_BUILD_NUMBER   default: UTC timestamp yyyyMMddHHmm (unique, increasing)
#   SKIP_UPLOAD=1         archive + export only (the .ipa lands in build/)
#
# One-time setup, in App Store Connect:
#   1. Users and Access -> Integrations -> App Store Connect API -> Team key,
#      role "Admin" — cloud signing (minting the distribution certificate)
#      is refused for App Manager keys. Download the .p8 (only offered once).
#   2. Apps -> "+" -> New App: platform iOS, bundle id dev.tomnguyen.superset
#      (register the identifier at developer.apple.com first if it is not
#      offered), SKU anything. Add yourself as an internal tester under
#      TestFlight once the first build has processed.
set -euo pipefail

cd "$(dirname "$0")/.."
MOBILE_DIR=$(pwd)
REPO_ROOT=$(cd ../.. && pwd)

# launchd/CI shells have no nvm: the expo CLI is `#!/usr/bin/env node`, so
# put the newest nvm node (or Homebrew's) on PATH when none is found.
if ! command -v node >/dev/null 2>&1; then
  nvm_default=$(cat "$HOME/.nvm/alias/default" 2>/dev/null || true)
  nvm_node=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | { [ -n "$nvm_default" ] && grep "/v${nvm_default#v}[./]" || cat; } | sort -V | tail -1)
  export PATH="${nvm_node:-/opt/homebrew/opt/node/bin}:$PATH"
fi
command -v node >/dev/null || { echo "node not found (install nvm node or brew node)" >&2; exit 1; }

: "${ASC_KEY_ID:?set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID}"
: "${ASC_KEY_P8:?set ASC_KEY_P8 (path or base64 contents)}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-Q89XY3A42H}"
export MOBILE_BUILD_NUMBER="${MOBILE_BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"

# --- API key on disk -------------------------------------------------------
# altool only finds keys under ~/.appstoreconnect/private_keys; xcodebuild takes
# an explicit path. Write it once, to that location, and remove it on exit
# unless it was the caller's own file.
KEY_DIR="$HOME/.appstoreconnect/private_keys"
KEY_PATH="$KEY_DIR/AuthKey_${ASC_KEY_ID}.p8"
CLEANUP_KEY=0
if [ -f "$ASC_KEY_P8" ]; then
  if [ "$(cd "$(dirname "$ASC_KEY_P8")" && pwd)/$(basename "$ASC_KEY_P8")" != "$KEY_PATH" ]; then
    mkdir -p "$KEY_DIR"; cp "$ASC_KEY_P8" "$KEY_PATH"; chmod 600 "$KEY_PATH"; CLEANUP_KEY=1
  fi
else
  mkdir -p "$KEY_DIR"
  printf '%s' "$ASC_KEY_P8" | base64 --decode > "$KEY_PATH"; chmod 600 "$KEY_PATH"; CLEANUP_KEY=1
fi
trap '[ "$CLEANUP_KEY" = 1 ] && rm -f "$KEY_PATH"' EXIT
grep -q "BEGIN PRIVATE KEY" "$KEY_PATH" || { echo "ASC_KEY_P8 does not look like a .p8 key" >&2; exit 1; }

echo "==> build ${MOBILE_BUILD_NUMBER} (team ${APPLE_TEAM_ID})"

# --- native project --------------------------------------------------------
# --clean regenerates ios/ from app.config.ts and runs pod install.
"$MOBILE_DIR/node_modules/.bin/expo" prebuild --platform ios --clean

# patches/expo-modules-jsi@*.patch: bun applies it to node_modules/expo-modules-jsi,
# but Expo autolinking compiles the copy in bun's store, which bun leaves as
# published. Mirror the one-line fix there (idempotent). See patches/README.md.
for h in "$REPO_ROOT"/node_modules/.bun/expo-modules-jsi@*/node_modules/expo-modules-jsi/apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h; do
  [ -f "$h" ] && sed -i '' 's/  SWIFT_RETURNS_RETAINED RuntimeScheduler(/  RuntimeScheduler(/' "$h"
done

# --- archive ---------------------------------------------------------------
BUILD_DIR="$MOBILE_DIR/build"
ARCHIVE="$BUILD_DIR/Superset.xcarchive"
rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"

AUTH=(-allowProvisioningUpdates
      -authenticationKeyPath "$KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

xcodebuild -workspace ios/Superset.xcworkspace -scheme Superset \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CODE_SIGN_STYLE=Automatic \
  "${AUTH[@]}" archive | tee "$BUILD_DIR/archive.log" | grep -E "error:|warning: .*signing|\*\* ARCHIVE" || true
[ -d "$ARCHIVE" ] || { echo "archive failed — see $BUILD_DIR/archive.log" >&2; exit 1; }

# --- export .ipa -----------------------------------------------------------
cat > "$BUILD_DIR/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" -exportPath "$BUILD_DIR/export" \
  "${AUTH[@]}" | tee "$BUILD_DIR/export.log" | grep -E "error:|EXPORT" || true
IPA=$(ls "$BUILD_DIR"/export/*.ipa 2>/dev/null | head -1)
[ -n "$IPA" ] || { echo "export failed — see $BUILD_DIR/export.log" >&2; exit 1; }
echo "==> exported $IPA"

# --- upload ----------------------------------------------------------------
if [ "${SKIP_UPLOAD:-0}" = 1 ]; then echo "==> SKIP_UPLOAD set, done"; exit 0; fi
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
echo "==> uploaded build ${MOBILE_BUILD_NUMBER}; it appears in TestFlight once App Store Connect finishes processing (~10 min)"

#!/usr/bin/env bash
# Install the GitHub Actions self-hosted runner on ms1 as a launchd LaunchAgent
# for the deploy user.
#
#   RUNNER_TOKEN=... ./install-runner.sh [runner-version] [--reconfigure]
#
# The runner is what .github/workflows/deploy-selfhost.yml targets with
# `runs-on: [self-hosted, macOS, ms1]`. GitHub adds the `self-hosted`, `macOS`
# and `ARM64` labels itself; we only add `ms1`.
#
# What it does, in order (every step is skipped if already done, so re-running
# is safe):
#   1. downloads actions-runner-osx-arm64-<ver>.tar.gz into ~/actions-runner,
#      checking it against the sha256 GitHub publishes in the release notes
#   2. registers the runner with github.com/tomikng/superset using $RUNNER_TOKEN
#      (skipped if ~/actions-runner/.runner exists, unless --reconfigure)
#   3. `svc.sh install` + `svc.sh start`, which writes and bootstraps
#      ~/Library/LaunchAgents/actions.runner.tomikng-superset.ms1.plist
#
# Run it from an interactive session of the deploy user (ssh is fine; the
# LaunchAgent lands in that user's gui domain and needs them logged in, which
# on ms1 they always are).
#
# Environment: the runner's launchd job inherits almost no PATH, and that's
# fine. deploy/deploy.sh sets its own PATH (bun, docker, etc.) at the top, and
# the workflow invokes it with an absolute path, so the runner needs no bun on
# PATH and no ~/.zshrc sourcing. Don't add a bespoke PATH to the plist.
set -euo pipefail

# --- pinned version -----------------------------------------------------------
# Latest at the time of writing (gh api repos/actions/runner/releases/latest).
# Bump both lines together: the sha is for the osx-arm64 tarball of THIS version
# and is the offline fallback when `gh` isn't available to read release notes.
DEFAULT_VERSION="2.337.0"
DEFAULT_SHA256="5a2cd92908a93d7276a194e1de6008099f3e7946f3f8e14aa7a1a7b4a31fdec2"

REPO_OWNER="tomikng"
REPO_NAME="superset"
REPO_URL="https://github.com/$REPO_OWNER/$REPO_NAME"
RUNNER_NAME="ms1"
RUNNER_LABELS="ms1"
RUNNER_DIR="$HOME/actions-runner"

# --- args ---------------------------------------------------------------------
VERSION="$DEFAULT_VERSION"
RECONFIGURE=0
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=1 ;;
    -h|--help)
      echo "usage: RUNNER_TOKEN=... $0 [runner-version] [--reconfigure]" >&2
      exit 64 ;;
    -*) echo "unknown flag: $arg" >&2; exit 64 ;;
    *) VERSION="${arg#v}" ;;   # accept "2.337.0" or "v2.337.0"
  esac
done

# --- sanity -------------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] \
  || { echo "this installer only knows osx-arm64 (got $(uname -s)/$(uname -m))" >&2; exit 1; }
command -v curl >/dev/null   || { echo "curl not found" >&2; exit 1; }
command -v shasum >/dev/null || { echo "shasum not found" >&2; exit 1; }

TARBALL="actions-runner-osx-arm64-$VERSION.tar.gz"
URL="https://github.com/actions/runner/releases/download/v$VERSION/$TARBALL"

mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# --- 1. download + verify -----------------------------------------------------
# The runner has a self-update mechanism, so an existing install may be newer
# than $VERSION; we only care that the bootstrap files exist.
if [ -x ./config.sh ] && [ -x ./svc.sh ]; then
  echo "runner already unpacked in $RUNNER_DIR (skipping download)"
else
  if [ ! -f "$TARBALL" ]; then
    echo "downloading $URL"
    curl -fsSL -o "$TARBALL.part" "$URL"
    mv "$TARBALL.part" "$TARBALL"
  fi

  # GitHub embeds the per-asset sha256 in the release body between
  # <!-- BEGIN SHA osx-arm64 --> ... <!-- END SHA osx-arm64 --> markers.
  # Prefer that (it covers any version); fall back to the hardcoded sha for the
  # pinned default; refuse to guess for anything else.
  EXPECTED_SHA=""
  if command -v gh >/dev/null 2>&1; then
    EXPECTED_SHA="$(gh api "repos/actions/runner/releases/tags/v$VERSION" -q .body 2>/dev/null \
      | sed -n 's/.*<!-- BEGIN SHA osx-arm64 -->\([0-9a-f]\{64\}\)<!-- END SHA osx-arm64 -->.*/\1/p' \
      | head -n1 || true)"
  fi
  if [ -z "$EXPECTED_SHA" ] && [ "$VERSION" = "$DEFAULT_VERSION" ]; then
    EXPECTED_SHA="$DEFAULT_SHA256"
  fi
  if [ -z "$EXPECTED_SHA" ]; then
    echo "cannot determine sha256 for v$VERSION (no gh, and not the pinned default)" >&2
    echo "install gh, or check https://github.com/actions/runner/releases/tag/v$VERSION" >&2
    exit 1
  fi
  ACTUAL_SHA="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "sha256 mismatch for $TARBALL" >&2
    echo "  expected $EXPECTED_SHA" >&2
    echo "  actual   $ACTUAL_SHA" >&2
    rm -f "$TARBALL"
    exit 1
  fi
  echo "sha256 ok"

  tar xzf "$TARBALL"
  rm -f "$TARBALL"
fi

# --- 2. register --------------------------------------------------------------
# .runner is written by config.sh and holds the agent id/name; its presence
# means this directory is already registered with GitHub.
if [ -f .runner ] && [ "$RECONFIGURE" -eq 0 ]; then
  echo "runner already configured ($(sed -n 's/.*"agentName": *"\([^"]*\)".*/\1/p' .runner)); pass --reconfigure to redo"
else
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    cat >&2 <<MSG
RUNNER_TOKEN is not set. Mint a registration token (valid ~1h, never commit it):

  export RUNNER_TOKEN="\$(gh api -X POST repos/$REPO_OWNER/$REPO_NAME/actions/runners/registration-token -q .token)"

then re-run this script.
MSG
    exit 1
  fi

  # A running service holds the old config; stop it before reconfiguring.
  if [ "$RECONFIGURE" -eq 1 ] && [ -f .service ]; then
    ./svc.sh stop || true
    ./svc.sh uninstall || true
  fi

  # --replace takes over an existing runner with the same name (e.g. after a
  # wiped ~/actions-runner) instead of failing with "already exists".
  ./config.sh --unattended \
    --url "$REPO_URL" \
    --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --work _work \
    --replace
fi

# --- 3. launchd service -------------------------------------------------------
# svc.sh install writes ~/Library/LaunchAgents/actions.runner.<owner>-<repo>.<name>.plist
# (here actions.runner.tomikng-superset.ms1.plist) and records it in .service.
# It refuses to run twice, so gate on that file.
if [ -f .service ]; then
  echo "service already installed ($(cat .service))"
else
  ./svc.sh install
fi
# start is idempotent: a running job just reports "already started".
./svc.sh start

echo
./svc.sh status
echo
echo "logs:    $RUNNER_DIR/_diag/"
echo "confirm: $REPO_URL/settings/actions/runners  (expect '$RUNNER_NAME' Idle, labels self-hosted macOS ARM64 $RUNNER_LABELS)"

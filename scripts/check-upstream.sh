#!/usr/bin/env bash
#
# Reports what changed upstream since this fork last merged, with attention to
# the files that actually matter to a self-hosted deployment.
#
# Two distinct risks, reported separately:
#
#   CONFLICTS   — files this fork patched that upstream also touched. These
#                 will need a hand-merge.
#   REGRESSIONS — files this fork did NOT patch, but whose behaviour the
#                 self-host depends on. These merge cleanly and break silently,
#                 which makes them the dangerous half.
#
# Read-only: fetches, never merges. Safe to run unattended.
#
#   ./scripts/check-upstream.sh
#
# First run on a fresh clone needs the remote:
#   git remote add upstream https://github.com/superset-sh/superset.git
#
set -uo pipefail

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
UPSTREAM_REF="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"

# Files this fork has modified. Upstream changes here mean a merge conflict.
PATCHED_FILES=(
  "packages/auth/src/server.ts"
  "apps/desktop/src/renderer/routes/sign-in/page.tsx"
  "apps/web/src/app/(auth)/sign-in/[[...sign-in]]/page.tsx"
  "package.json"
)

# Files the self-host depends on but does not patch. Upstream changes here
# merge cleanly and can break the deployment without any visible conflict.
# Each entry is "path:why it matters".
WATCHED_FILES=(
  "packages/trpc/src/router/billing/billing.ts:activePlan is the unlock; if it starts calling Stripe instead of reading Postgres, every paywall re-locks"
  "packages/shared/src/billing.ts:plan tier names and active-status list"
  "apps/desktop/src/renderer/components/Paywall/constants.ts:the set of gated features may grow"
  "apps/desktop/src/renderer/hooks/useCurrentPlan.ts:how a plan resolves to unlocked"
  "packages/auth/src/env.ts:new required env vars break boot"
  "apps/api/src/env.ts:new required env vars break boot"
  "apps/desktop/vite/helpers.ts:injects API/relay origins into the CSP at build time"
  "apps/desktop/electron.vite.config.ts:bakes backend URLs into the renderer"
  "apps/relay/src/access.ts:host authorization; today it ignores paidPlan"
  "packages/trpc/src/router/host/host.ts:checkAccess returns a paidPlan flag nothing consumes yet"
  "docker-compose.yml:the local service topology this deployment mirrors"
  "packages/db/src/schema/auth.ts:organizations/members shape used by db:seed-teams"
  "packages/db/src/schema/schema.ts:subscriptions shape used by db:seed-teams"
  "packages/auth/src/seed-dev.ts:the script db:seed-teams was derived from"
)

bold=$(tput bold 2>/dev/null || printf '')
dim=$(tput dim 2>/dev/null || printf '')
reset=$(tput sgr0 2>/dev/null || printf '')

section() { printf '\n%s%s%s\n' "$bold" "$1" "$reset"; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "not a git repository" >&2
  exit 1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "remote '$UPSTREAM_REMOTE' not configured. Add it with:" >&2
  echo "  git remote add $UPSTREAM_REMOTE https://github.com/superset-sh/superset.git" >&2
  exit 1
fi

echo "Fetching ${UPSTREAM_REF}..."
if ! git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH" 2>/dev/null; then
  echo "fetch failed" >&2
  exit 1
fi

MERGE_BASE=$(git merge-base HEAD "$UPSTREAM_REF" 2>/dev/null || true)
if [ -z "$MERGE_BASE" ]; then
  echo "no common ancestor with ${UPSTREAM_REF}" >&2
  exit 1
fi

BEHIND=$(git rev-list --count "HEAD..${UPSTREAM_REF}")
AHEAD=$(git rev-list --count "${UPSTREAM_REF}..HEAD")

section "Superset fork — upstream check"
printf '%s%s commits behind · %s ahead · base %s%s\n' \
  "$dim" "$BEHIND" "$AHEAD" "$(git rev-parse --short "$MERGE_BASE")" "$reset"

if [ "$BEHIND" -eq 0 ]; then
  echo ""
  echo "Up to date with ${UPSTREAM_REF}. Nothing to do."
  exit 0
fi

CHANGED=$(git diff --name-only "HEAD..${UPSTREAM_REF}")

# --- conflicts -------------------------------------------------------------

section "Merge conflicts expected"
conflict_count=0
for file in "${PATCHED_FILES[@]}"; do
  if grep -Fxq "$file" <<<"$CHANGED"; then
    commits=$(git rev-list --count "HEAD..${UPSTREAM_REF}" -- "$file")
    printf '  %s  %s(%s upstream commits)%s\n' "$file" "$dim" "$commits" "$reset"
    conflict_count=$((conflict_count + 1))
  fi
done
[ "$conflict_count" -eq 0 ] && printf '  %snone — every patched file is untouched upstream%s\n' "$dim" "$reset"

# --- silent regressions ----------------------------------------------------

section "Behaviour to re-verify (merges clean, can still break)"
watch_count=0
for entry in "${WATCHED_FILES[@]}"; do
  file="${entry%%:*}"
  why="${entry#*:}"
  if grep -Fxq "$file" <<<"$CHANGED"; then
    printf '  %s\n    %s%s%s\n' "$file" "$dim" "$why" "$reset"
    watch_count=$((watch_count + 1))
  fi
done
[ "$watch_count" -eq 0 ] && printf '  %snone%s\n' "$dim" "$reset"

# --- migrations ------------------------------------------------------------

NEW_MIGRATIONS=$(grep -c '^packages/db/drizzle/.*\.sql$' <<<"$CHANGED" || true)
if [ "${NEW_MIGRATIONS:-0}" -gt 0 ]; then
  section "Database migrations"
  printf '  %s new migration file(s) — run migrations after merging\n' "$NEW_MIGRATIONS"
  grep '^packages/db/drizzle/.*\.sql$' <<<"$CHANGED" | sed 's/^/    /'
fi

# --- summary ---------------------------------------------------------------

section "Summary"
if [ "$conflict_count" -eq 0 ] && [ "$watch_count" -eq 0 ]; then
  echo "  ${BEHIND} commits behind, but nothing this deployment depends on changed."
  echo "  A plain merge should be safe."
else
  echo "  ${conflict_count} file(s) will conflict, ${watch_count} behaviour(s) to re-verify."
  echo "  Review before merging:"
  echo "    git log --oneline HEAD..${UPSTREAM_REF}"
fi

echo ""
echo "After merging, re-check in this order:"
echo "  1. the API still boots (no new required env vars)"
echo "  2. billing.activePlan still reads Postgres and returns 'enterprise'"
echo "  3. the desktop build still bakes your hostnames into the CSP"
echo "  4. sign-in still offers a password form and no social buttons"

#!/usr/bin/env bash
#
# smoke-test.sh — end-to-end verification of the self-hosted Superset
# deployment on ms1 (macOS host, Cloudflare Tunnel in front).
#
# Runs seven layers in dependency order. The first layer that fails stops the
# run: everything below it is reported SKIP rather than producing a cascade of
# confusing downstream errors.
#
#   1  Docker backing services (postgres, neon-proxy, redis, serverless-redis-http)
#   2  Local app processes listening on their ports
#   3  Public hostnames resolve and terminate TLS
#   4  The API answers through the tunnel
#   5  A WebSocket upgrade succeeds against the relay hostname
#   6  Credential sign-in returns a token
#   7  All three organizations hold an active `enterprise` subscription row
#
# Usage:
#   SUPERSET_SMOKE_PASSWORD='...' ./smoke-test.sh
#
# Exit code 0 = every layer passed. 1 = something failed (or was skipped
# because an earlier layer failed).

set -uo pipefail

# ---------------------------------------------------------------------------
# Configuration — override any of these from the environment.
# ---------------------------------------------------------------------------

# Public hostnames (flat, one subdomain level: Cloudflare Universal SSL).
API_HOST="${API_HOST:-superset-api.tom-nguyen.dev}"
WEB_HOST="${WEB_HOST:-superset-app.tom-nguyen.dev}"
RELAY_HOST="${RELAY_HOST:-superset-relay.tom-nguyen.dev}"

# Local listen ports.
#   API_PORT   — apps/api "start": next start --port 3101
#   WEB_PORT   — apps/web "start": next start (Next.js default 3100; see NOTES)
#   RELAY_PORT — apps/relay/src/env.ts RELAY_PORT, default 3102
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3100}"
RELAY_PORT="${RELAY_PORT:-3102}"

# Compose project, file and env-file. The deployed stack is
# deploy/docker-compose.prod.yml driven by deploy/.env.docker — NOT the repo-root
# docker-compose.yml, which is the dev stack (postgres/postgres,
# SRH_TOKEN=local_dev_token) and would be a different Postgres volume.
# Same project name as launchd's stack job (dev.tom-nguyen.superset.stack).
COMPOSE_PROJECT="${COMPOSE_PROJECT:-superset}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/superset/deploy}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.prod.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-$DEPLOY_DIR/.env.docker}"

# Credentials come from .env.docker, which is the single source of truth for the
# four compose-level values (POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB /
# SRH_TOKEN). Nothing here falls back to the repo's dev defaults: a smoke test
# that passes against postgres/postgres or local_dev_token would be testing the
# wrong stack.
if [ -r "$COMPOSE_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$COMPOSE_ENV_FILE"
fi

# SRH bearer token — one secret, two names: SRH_TOKEN in .env.docker (compose)
# and KV_REST_API_TOKEN in the app's root .env. They must be byte-identical.
KV_REST_API_TOKEN="${KV_REST_API_TOKEN:-${SRH_TOKEN:-}}"

# Backing-service host ports. Defaults match docker-compose.prod.yml's
# ${VAR:-default} fallbacks; values pinned in .env.docker (sourced just above)
# win, because these assignments run after it.
LOCAL_PG_PORT="${LOCAL_PG_PORT:-5432}"
LOCAL_NEON_PROXY_PORT="${LOCAL_NEON_PROXY_PORT:-4444}"
LOCAL_REDIS_PORT="${LOCAL_REDIS_PORT:-6379}"
LOCAL_SRH_PORT="${LOCAL_SRH_PORT:-8079}"

# Postgres credentials, from .env.docker.
PGUSER_SMOKE="${PGUSER_SMOKE:-${POSTGRES_USER:-}}"
PGPASSWORD_SMOKE="${PGPASSWORD_SMOKE:-${POSTGRES_PASSWORD:-}}"
PGDATABASE_SMOKE="${PGDATABASE_SMOKE:-${POSTGRES_DB:-main}}"

# Sign-in probe. The password is NEVER stored in this file — export it.
SUPERSET_SMOKE_EMAIL="${SUPERSET_SMOKE_EMAIL:-tomasnguyen43@gmail.com}"
SUPERSET_SMOKE_PASSWORD="${SUPERSET_SMOKE_PASSWORD:-}"

# The three organizations seeded by `bun run db:seed-teams`
# (packages/auth/src/seed-teams.ts).
EXPECTED_ORG_SLUGS="${EXPECTED_ORG_SLUGS:-team-one team-two team-three}"
EXPECTED_PLAN="${EXPECTED_PLAN:-enterprise}"

CURL_TIMEOUT="${CURL_TIMEOUT:-15}"

# ---------------------------------------------------------------------------
# Reporting helpers — plain ASCII, no colour, log-friendly.
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FIRST_FAILURE=""

layer() {
  echo ""
  echo "=============================================================="
  echo "LAYER $1  $2"
  echo "=============================================================="
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  PASS  $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "  FAIL  $1"
  if [ -n "${2:-}" ]; then
    echo "        $2"
  fi
  if [ -z "$FIRST_FAILURE" ]; then
    FIRST_FAILURE="$1"
  fi
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  echo "  SKIP  $1"
}

info() {
  echo "        $1"
}

# True while no check has failed yet. Every layer guards on this so the run
# stops at the first broken layer instead of cascading.
healthy() {
  [ "$FAIL_COUNT" -eq 0 ]
}

skip_layer() {
  skip "$1 (an earlier layer failed: $FIRST_FAILURE)"
}

require_cmd() {
  command -v "$1" > /dev/null 2>&1
}

dc() {
  if [ -r "$COMPOSE_ENV_FILE" ]; then
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV_FILE" "$@"
  else
    docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
  fi
}

# Port-listening probe. bash's /dev/tcp works on the stock macOS bash 3.2 and
# needs no netcat.
port_open() {
  local host="$1" port="$2"
  if require_cmd nc; then
    nc -z -w 3 "$host" "$port" > /dev/null 2>&1
    return $?
  fi
  (exec 3<> "/dev/tcp/$host/$port") > /dev/null 2>&1
}

echo "Superset self-hosted smoke test"
echo "host:      $(hostname 2>/dev/null || echo unknown)"
echo "date:      $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "api:       https://$API_HOST"
echo "web:       https://$WEB_HOST"
echo "relay:     https://$RELAY_HOST"
echo "compose:   project=$COMPOSE_PROJECT file=$COMPOSE_FILE env-file=$COMPOSE_ENV_FILE"

# ---------------------------------------------------------------------------
# Preflight — tools this script cannot work without.
# ---------------------------------------------------------------------------

layer 0 "Preflight"

for tool in curl docker; do
  if require_cmd "$tool"; then
    pass "$tool available"
  else
    fail "$tool available" "install $tool and re-run"
  fi
done

if [ -f "$COMPOSE_FILE" ]; then
  pass "compose file present ($COMPOSE_FILE)"
else
  fail "compose file present" "not found: $COMPOSE_FILE — set COMPOSE_FILE=..."
fi

if [ -r "$COMPOSE_ENV_FILE" ]; then
  pass "compose env-file present ($COMPOSE_ENV_FILE)"
else
  fail "compose env-file present" "not found/readable: $COMPOSE_ENV_FILE — docker-compose.prod.yml requires POSTGRES_USER/POSTGRES_PASSWORD/SRH_TOKEN from it"
fi

if [ -n "$PGUSER_SMOKE" ] && [ -n "$PGPASSWORD_SMOKE" ]; then
  pass "postgres credentials resolved (user=$PGUSER_SMOKE db=$PGDATABASE_SMOKE)"
else
  fail "postgres credentials resolved" "POSTGRES_USER/POSTGRES_PASSWORD not found — set them in $COMPOSE_ENV_FILE or export PGUSER_SMOKE/PGPASSWORD_SMOKE"
fi

if [ -n "$KV_REST_API_TOKEN" ]; then
  pass "SRH token resolved"
else
  fail "SRH token resolved" "SRH_TOKEN not found in $COMPOSE_ENV_FILE — export KV_REST_API_TOKEN instead"
fi

if [ -n "$SUPERSET_SMOKE_PASSWORD" ]; then
  pass "SUPERSET_SMOKE_PASSWORD is set"
else
  fail "SUPERSET_SMOKE_PASSWORD is set" \
    "export SUPERSET_SMOKE_PASSWORD='<password printed by db:seed-teams>' and re-run"
fi

# ---------------------------------------------------------------------------
# LAYER 1 — Docker backing services
# ---------------------------------------------------------------------------

layer 1 "Docker services"

if ! healthy; then
  skip_layer "docker service checks"
else
  # -- postgres:17 --------------------------------------------------------
  PG_CID="$(dc ps -q postgres 2>/dev/null)"
  if [ -n "$PG_CID" ]; then
    pass "postgres container running"
    PG_HEALTH="$(docker inspect --format '{{.State.Health.Status}}' "$PG_CID" 2>/dev/null)"
    info "container health: ${PG_HEALTH:-unknown}"
    # Same probe as docker-compose.prod.yml's healthcheck.
    if dc exec -T postgres pg_isready -U "$PGUSER_SMOKE" -d "$PGDATABASE_SMOKE" > /dev/null 2>&1; then
      pass "postgres accepting connections (pg_isready -U $PGUSER_SMOKE)"
    else
      fail "postgres accepting connections" "pg_isready failed inside the container"
    fi
  else
    fail "postgres container running" "docker compose ps -q postgres returned nothing"
  fi

  # -- neon-proxy ---------------------------------------------------------
  # Exact probe from .superset/setup.local.sh: a real SQL round trip over the
  # Neon HTTP protocol. A ready proxy answers with a body containing "command".
  if healthy; then
    NEON_BODY="$(curl -s --max-time 5 -X POST "http://127.0.0.1:$LOCAL_NEON_PROXY_PORT/sql" \
      -H "Neon-Connection-String: postgres://$PGUSER_SMOKE:$PGPASSWORD_SMOKE@db.localtest.me:$LOCAL_NEON_PROXY_PORT/$PGDATABASE_SMOKE" \
      -H "Content-Type: application/json" \
      -d '{"query":"select 1","params":[]}' 2>/dev/null)"
    if echo "$NEON_BODY" | grep -q '"command"'; then
      pass "neon-proxy answered a real SQL query on :$LOCAL_NEON_PROXY_PORT"
    else
      fail "neon-proxy answered a real SQL query on :$LOCAL_NEON_PROXY_PORT" \
        "response: ${NEON_BODY:-<empty>}"
    fi
  else
    skip_layer "neon-proxy SQL probe"
  fi

  # -- redis:7-alpine -----------------------------------------------------
  if healthy; then
    REDIS_CID="$(dc ps -q redis 2>/dev/null)"
    if [ -n "$REDIS_CID" ] && dc exec -T redis redis-cli ping 2>/dev/null | grep -q "PONG"; then
      pass "redis responding (redis-cli ping -> PONG)"
    else
      fail "redis responding" "redis-cli ping did not return PONG"
    fi
  else
    skip_layer "redis ping"
  fi

  # -- serverless-redis-http ---------------------------------------------
  # Also from setup.local.sh. The Content-Type header is required — SRH
  # rejects the request without it.
  if healthy; then
    SRH_BODY="$(curl -s --max-time 5 -X POST "http://127.0.0.1:$LOCAL_SRH_PORT/" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $KV_REST_API_TOKEN" \
      -d '["PING"]' 2>/dev/null)"
    if echo "$SRH_BODY" | grep -q "PONG"; then
      pass "serverless-redis-http answered PING over HTTP on :$LOCAL_SRH_PORT"
    else
      fail "serverless-redis-http answered PING over HTTP on :$LOCAL_SRH_PORT" \
        "response: ${SRH_BODY:-<empty>} (check KV_REST_API_TOKEN matches SRH_TOKEN)"
    fi
  else
    skip_layer "serverless-redis-http PING"
  fi
fi

# ---------------------------------------------------------------------------
# LAYER 2 — Local services listening
# ---------------------------------------------------------------------------

layer 2 "Local ports"

if ! healthy; then
  skip_layer "local port checks"
else
  check_port() {
    if port_open 127.0.0.1 "$2"; then
      pass "$1 listening on 127.0.0.1:$2"
    else
      fail "$1 listening on 127.0.0.1:$2" "nothing accepted a TCP connection there"
    fi
  }
  check_port "postgres"              "$LOCAL_PG_PORT"
  check_port "neon-proxy"            "$LOCAL_NEON_PROXY_PORT"
  check_port "redis"                 "$LOCAL_REDIS_PORT"
  check_port "serverless-redis-http" "$LOCAL_SRH_PORT"
  check_port "api (apps/api)"        "$API_PORT"
  check_port "web (apps/web)"        "$WEB_PORT"
  check_port "relay (apps/relay)"    "$RELAY_PORT"
fi

# ---------------------------------------------------------------------------
# LAYER 3 — Public hostnames: DNS + TLS
# ---------------------------------------------------------------------------

layer 3 "Public DNS + TLS"

if ! healthy; then
  skip_layer "DNS/TLS checks"
else
  resolve_host() {
    if require_cmd dig; then
      dig +short "$1" 2>/dev/null | grep -v '\.$' | head -n 3
    elif require_cmd host; then
      host "$1" 2>/dev/null | awk '/has address|has IPv6/ {print $NF}' | head -n 3
    else
      # Last resort: ping resolves the name without sending traffic we care about.
      ping -c 1 -t 2 "$1" 2>/dev/null | head -n 1 | sed -n 's/.*(\([0-9.]*\)).*/\1/p'
    fi
  }

  for h in "$API_HOST" "$WEB_HOST" "$RELAY_HOST"; do
    ADDRS="$(resolve_host "$h")"
    if [ -n "$ADDRS" ]; then
      pass "$h resolves"
      info "$(echo "$ADDRS" | tr '\n' ' ')"
    else
      fail "$h resolves" "no A/AAAA record returned"
      continue
    fi

    # TLS termination: a completed handshake is what we are asserting. Any HTTP
    # status counts — 404 from the app still proves the tunnel + cert worked.
    TLS_CODE="$(curl -s -o /dev/null --max-time "$CURL_TIMEOUT" -w '%{http_code}' "https://$h/" 2>/dev/null)"
    TLS_RC=$?
    if [ "$TLS_RC" -eq 0 ] && [ -n "$TLS_CODE" ] && [ "$TLS_CODE" != "000" ]; then
      pass "$h terminates TLS (HTTP $TLS_CODE)"
    else
      fail "$h terminates TLS" "curl exit $TLS_RC, http_code ${TLS_CODE:-none} — check the Cloudflare Tunnel route and that the hostname is one label deep (Universal SSL)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# LAYER 4 — API through the tunnel
# ---------------------------------------------------------------------------

layer 4 "API through the tunnel"

if ! healthy; then
  skip_layer "API checks"
else
  # apps/api has no /health route. These two are real routes in the repo:
  #   apps/api/src/app/.well-known/openid-configuration/route.ts
  #   apps/api/src/app/api/auth/[...all]/route.ts  (better-auth jwt plugin -> /jwks,
  #   the same URL apps/relay/src/auth.ts fetches to verify tokens)
  OIDC_FILE="$(mktemp -t superset-smoke-oidc)"
  OIDC_CODE="$(curl -s -o "$OIDC_FILE" --max-time "$CURL_TIMEOUT" -w '%{http_code}' \
    "https://$API_HOST/.well-known/openid-configuration" 2>/dev/null)"
  if [ "$OIDC_CODE" = "200" ]; then
    pass "GET /.well-known/openid-configuration -> 200"
    if grep -q "$API_HOST" "$OIDC_FILE"; then
      pass "OIDC issuer points at $API_HOST"
    else
      fail "OIDC issuer points at $API_HOST" \
        "metadata does not mention the public hostname — NEXT_PUBLIC_API_URL is probably still localhost"
    fi
  else
    fail "GET /.well-known/openid-configuration -> 200" "got HTTP ${OIDC_CODE:-none}"
  fi
  rm -f "$OIDC_FILE"

  if healthy; then
    JWKS_FILE="$(mktemp -t superset-smoke-jwks)"
    JWKS_CODE="$(curl -s -o "$JWKS_FILE" --max-time "$CURL_TIMEOUT" -w '%{http_code}' \
      "https://$API_HOST/api/auth/jwks" 2>/dev/null)"
    if [ "$JWKS_CODE" = "200" ] && grep -q '"keys"' "$JWKS_FILE"; then
      pass "GET /api/auth/jwks -> 200 with a key set (relay JWT verification path)"
    else
      fail "GET /api/auth/jwks -> 200 with a key set" "got HTTP ${JWKS_CODE:-none}"
    fi
    rm -f "$JWKS_FILE"
  else
    skip_layer "jwks probe"
  fi
fi

# ---------------------------------------------------------------------------
# LAYER 5 — WebSocket upgrade against the relay
# ---------------------------------------------------------------------------

layer 5 "Relay WebSocket upgrade"

if ! healthy; then
  skip_layer "relay checks"
else
  # apps/relay/src/index.ts:99 — app.get("/health", ...) -> {"ok":true,...}
  RELAY_HEALTH="$(curl -s --max-time "$CURL_TIMEOUT" "https://$RELAY_HOST/health" 2>/dev/null)"
  if echo "$RELAY_HEALTH" | grep -q '"ok":true'; then
    pass "relay /health -> ok"
  else
    fail "relay /health -> ok" "response: ${RELAY_HEALTH:-<empty>}"
  fi

  if healthy; then
    # apps/relay/src/index.ts:230 — app.get("/tunnel", upgradeWebSocket(...)).
    # No auth middleware guards the upgrade itself: the handshake completes
    # (HTTP 101) and the socket is then closed with 1008 "Missing hostId or
    # token" inside onOpen. A 101 is therefore exactly the assertion we want —
    # it proves Cloudflare forwarded the Upgrade and the relay answered it.
    WS_KEY="$(head -c 16 /dev/urandom | base64 2>/dev/null | tr -d '\n')"
    WS_OUT="$(curl -s -i --http1.1 --max-time 8 \
      -H "Connection: Upgrade" \
      -H "Upgrade: websocket" \
      -H "Sec-WebSocket-Version: 13" \
      -H "Sec-WebSocket-Key: $WS_KEY" \
      "https://$RELAY_HOST/tunnel" 2>/dev/null)"
    WS_RC=$?
    # curl holds the socket open after the 101, so a timeout (exit 28) here is
    # the normal, healthy outcome. Judge on the status line, not the exit code.
    if echo "$WS_OUT" | grep -qi "HTTP/1.1 101"; then
      pass "wss://$RELAY_HOST/tunnel upgraded (HTTP 101 Switching Protocols)"
      if echo "$WS_OUT" | grep -qi "sec-websocket-accept"; then
        info "Sec-WebSocket-Accept present"
      fi
    else
      fail "wss://$RELAY_HOST/tunnel upgraded (HTTP 101)" \
        "curl exit $WS_RC; status line was: $(echo "$WS_OUT" | head -n 1)"
    fi
  else
    skip_layer "WebSocket upgrade"
  fi
fi

# ---------------------------------------------------------------------------
# LAYER 6 — Credential sign-in
# ---------------------------------------------------------------------------

layer 6 "Sign-in (invitation-only email/password)"

if ! healthy; then
  skip_layer "sign-in check"
else
  SIGNIN_FILE="$(mktemp -t superset-smoke-signin)"
  SIGNIN_CODE="$(curl -s -o "$SIGNIN_FILE" --max-time "$CURL_TIMEOUT" -w '%{http_code}' \
    -X POST "https://$API_HOST/api/auth/sign-in/email" \
    -H "Content-Type: application/json" \
    -H "Origin: https://$WEB_HOST" \
    --data-binary "$(printf '{"email":"%s","password":"%s"}' "$SUPERSET_SMOKE_EMAIL" "$SUPERSET_SMOKE_PASSWORD")" \
    2>/dev/null)"
  if [ "$SIGNIN_CODE" = "200" ] && grep -q '"token"' "$SIGNIN_FILE"; then
    pass "POST /api/auth/sign-in/email -> 200 with a session token"
    info "account: $SUPERSET_SMOKE_EMAIL"
  else
    # Never echo the body verbatim — it can carry a token on partial success.
    fail "POST /api/auth/sign-in/email -> 200 with a session token" \
      "HTTP ${SIGNIN_CODE:-none}; no \"token\" field in the response. Check the password, that db:seed-teams has run, and that BETTER_AUTH_SECRET / NEXT_PUBLIC_API_URL match the deployed hostnames."
  fi
  rm -f "$SIGNIN_FILE"
fi

# ---------------------------------------------------------------------------
# LAYER 7 — The unlock: active enterprise subscription per organization
# ---------------------------------------------------------------------------

layer 7 "Subscriptions (three orgs, active enterprise)"

if ! healthy; then
  skip_layer "subscription check"
else
  # Table locations, from the schema:
  #   auth.organizations     packages/db/src/schema/auth.ts   (pgSchema("auth"))
  #   public.subscriptions   packages/db/src/schema/schema.ts (pgTable)
  # subscriptions.reference_id -> organizations.id; the rows seed-teams.ts
  # writes are status='active', plan='enterprise'.
  SQL="SELECT o.slug || '|' || s.plan || '|' || s.status || '|' || COALESCE(s.seats::text,'null')
       FROM auth.organizations o
       JOIN public.subscriptions s ON s.reference_id = o.id
       WHERE s.status = 'active' AND s.plan = '${EXPECTED_PLAN}';"

  ROWS="$(dc exec -T -e PGPASSWORD="$PGPASSWORD_SMOKE" postgres psql -U "$PGUSER_SMOKE" -d "$PGDATABASE_SMOKE" -tAc "$SQL" 2>/dev/null | tr -d '\r')"
  PSQL_RC=$?

  if [ "$PSQL_RC" -ne 0 ]; then
    fail "query subscriptions table" "psql inside the postgres container exited $PSQL_RC"
  else
    for slug in $EXPECTED_ORG_SLUGS; do
      LINE="$(echo "$ROWS" | grep "^${slug}|" | head -n 1)"
      if [ -n "$LINE" ]; then
        pass "$slug has an active $EXPECTED_PLAN subscription"
        info "$LINE  (slug|plan|status|seats)"
      else
        fail "$slug has an active $EXPECTED_PLAN subscription" \
          "no matching row — re-run from the repo root: SUPERSET_ALLOW_SIGNUP=true SEED_TEAMS_CONFIRM=yes NODE_ENV=development bun run db:seed-teams  (NODE_ENV=development is required: packages/auth/src/server.ts afterCreateOrganization calls Stripe on the auto-created personal org whenever NODE_ENV != development)"
      fi
    done

    ROW_COUNT="$(echo "$ROWS" | grep -c '|' )"
    EXPECTED_COUNT="$(echo "$EXPECTED_ORG_SLUGS" | wc -w | tr -d ' ')"
    if [ "$ROW_COUNT" -eq "$EXPECTED_COUNT" ]; then
      pass "exactly $EXPECTED_COUNT active $EXPECTED_PLAN subscriptions on the instance"
    else
      info "note: found $ROW_COUNT active $EXPECTED_PLAN rows, expected $EXPECTED_COUNT (extra orgs are not fatal)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=============================================================="
echo "SUMMARY"
echo "=============================================================="
echo "  passed:  $PASS_COUNT"
echo "  failed:  $FAIL_COUNT"
echo "  skipped: $SKIP_COUNT"

if [ "$FAIL_COUNT" -eq 0 ]; then
  echo ""
  echo "RESULT: OK — all $PASS_COUNT checks passed."
  exit 0
fi

echo ""
echo "RESULT: BROKEN — first failure: $FIRST_FAILURE"
echo "Fix that layer, then re-run; checks below it were not attempted."
exit 1

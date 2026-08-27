# Cloudflare Tunnel setup — `ms1`

Publishes the three Superset self-host services on `ms1` (macOS, home network) through a
new Cloudflare Tunnel named **`ms1`**, without disturbing the existing `rc-hub` tunnel
already running on the same machine.

| Public hostname | Origin | Source of truth for the port |
|---|---|---|
| `superset-api.tom-nguyen.dev` | `http://127.0.0.1:3101` | `apps/api/package.json` → `"start": "next start --port 3101"` |
| `superset-app.tom-nguyen.dev` | `http://127.0.0.1:3100` | `apps/web/package.json` → `"start": "next start"` (Next's default 3100) |
| `superset-relay.tom-nguyen.dev` | `http://127.0.0.1:3102` | `apps/relay/src/env.ts` → `RELAY_PORT` default `3102` |

All three are one subdomain level deep, so Cloudflare Universal SSL (`*.tom-nguyen.dev`)
covers them without an Advanced Certificate.

Files here:

- `config.yml` — install as `~/.cloudflared/ms1.yml` (**not** `config.yml`; see below)
- `ws-verify.ts` — Bun harness that proves a WebSocket survives past the edge idle timeout

> **What is actually live on ms1 (2026-08-27).** The tunnel ended up as the system
> LaunchDaemon `com.cloudflare.cloudflared` running
> `/usr/local/bin/cloudflared --config /etc/cloudflared/config.yml tunnel run`, and that
> file carries the ssh/dashboard hostnames *as well as* the Superset rules below — it is a
> superset of this `config.yml`, so **merge rule changes into it, never copy over it**.
> `/etc/cloudflared/` is root-owned but `config.yml` is owned by the deploy user: edit it
> with `cat new > /etc/cloudflared/config.yml` (in-place tools can't create their temp file
> there), validate with `cloudflared --config /etc/cloudflared/config.yml tunnel ingress
> validate`, then `sudo launchctl kickstart -k system/com.cloudflare.cloudflared` — this
> cloudflared build does not hot-reload ingress rules. ssh to ms1 rides the same tunnel, so
> expect a few seconds of disconnect. Keep a copy of the live file in `~` before editing.

---

## 1. Keeping `ms1` and `rc-hub` from colliding

Three separate collisions to avoid. Only the first is obvious.

### 1a. The config file

`cloudflared` reads `~/.cloudflared/config.yml` by default, and on ms1 that file already
pins `tunnel: rc-hub`. Do **not** edit it and do **not** add the Superset ingress rules to
it — that would put four unrelated hostnames on one tunnel's lifecycle, so restarting for
a Superset change would drop rc-hub.

Instead the ms1 tunnel gets its own file at a **named path**, selected explicitly:

```sh
cloudflared --config ~/.cloudflared/ms1.yml tunnel run ms1
```

`--config` overrides the default search path and is supported for locally-managed tunnels
(which this is — the config lives on disk, not in the Zero Trust dashboard).

### 1b. The launchd service label

This is the one that bites. `cloudflared service install` always uses the fixed label
`com.cloudflare.cloudflared` — a LaunchAgent without `sudo`, a LaunchDaemon at
`/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` with it. There is no
`--name`/`--label` flag. **Running `cloudflared service install` a second time on ms1 will
clobber or conflict with whatever is already running rc-hub.**

So: do not run `cloudflared service install` for ms1. Hand-write a second LaunchDaemon
with a distinct label (§4).

### 1c. The metrics port

Each `cloudflared` process binds a local metrics/diagnostics listener. `config.yml` here
pins ms1 to `127.0.0.1:20251` rather than leaving it to the default (20241), because the
rc-hub process may already hold that. Confirm before installing:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -i cloudflared
```

If 20251 is taken, pick another free port and change `metrics:` in `config.yml` and the
verification commands below to match.

---

## 2. About the existing `ms1.tom-nguyen.dev` A record

`ms1.tom-nguyen.dev` currently exists as a **proxied A record**, not a tunnel CNAME. What
that implies:

- **It does not conflict with this setup and does not need to change.** The three
  hostnames we are creating (`superset-api`, `superset-app`, `superset-relay`) are
  different names. `cloudflared tunnel route dns` only touches the name you hand it.
- A proxied A record means Cloudflare's edge is forwarding to a **routable origin IP** —
  i.e. that path depends on a port-forward / public IP at the house, and the origin IP is
  sitting in the DNS record. That is the exact exposure a tunnel exists to remove. It is
  out of scope here, but worth retiring separately.
- **If** you later want `ms1.tom-nguyen.dev` itself to ride the tunnel, `cloudflared
  tunnel route dns` will refuse, because it will not silently replace an existing record
  of a different type. You would delete the A record first, then re-run the route command
  to get the `CNAME → <UUID>.cfargotunnel.com`.
- Practical consequence for §5: if `curl` against a Superset hostname behaves oddly, do
  not reason from `ms1.tom-nguyen.dev`'s behaviour — it is a different origin path
  entirely.

---

## 3. Create the tunnel and DNS records

Run these as the login user on ms1 (they use `~/.cloudflared/cert.pem`, which is already
present and authenticated).

```sh
# 3.1 — create the tunnel. Prints a UUID and writes ~/.cloudflared/<UUID>.json
cloudflared tunnel create ms1

# 3.2 — capture the UUID for the steps below
cloudflared tunnel list
MS1_UUID=$(cloudflared tunnel list --output json | jq -r '.[] | select(.name=="ms1") | .id')
echo "$MS1_UUID"

# 3.3 — install the config, substituting <USER> and <MS1_TUNNEL_UUID>
cp config.yml ~/.cloudflared/ms1.yml
sed -i '' "s|<USER>|$(whoami)|g; s|<MS1_TUNNEL_UUID>|${MS1_UUID}|g" ~/.cloudflared/ms1.yml

# 3.4 — sanity-check the config BEFORE routing DNS or installing a service
cloudflared --config ~/.cloudflared/ms1.yml tunnel ingress validate
cloudflared --config ~/.cloudflared/ms1.yml tunnel ingress rule https://superset-relay.tom-nguyen.dev/tunnel
```

`ingress rule` prints which rule a given URL matches — use it to confirm the relay URL
resolves to `http://127.0.0.1:3102` and not the `http_status:404` catch-all.

```sh
# 3.5 — one DNS route per hostname. Each creates a proxied CNAME to
#        <MS1_UUID>.cfargotunnel.com. Run once per hostname; re-running is a no-op
#        for a record this tunnel already owns, and an error for one it does not.
cloudflared tunnel route dns ms1 superset-api.tom-nguyen.dev
cloudflared tunnel route dns ms1 superset-app.tom-nguyen.dev
cloudflared tunnel route dns ms1 superset-relay.tom-nguyen.dev

# 3.6 — confirm the records exist and are CNAMEs into the tunnel
for h in superset-api superset-app superset-relay; do
  echo "== $h"; dig +short CNAME "$h.tom-nguyen.dev" @1.1.1.1
done
```

Then a foreground smoke run before making it a service — start the three Superset
processes first, otherwise every rule 502s:

```sh
cloudflared --config ~/.cloudflared/ms1.yml tunnel run ms1
```

Leave it running and do §5's checks. Ctrl-C when satisfied, then install the service.

---

## 4. Install as a per-tunnel LaunchDaemon

Because `cloudflared service install` is single-slot (§1b), write the job by hand with a
distinct label. Save as `/Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cloudflare.cloudflared.ms1</string>

  <!-- Runs as the login user, not root: cloudflared is outbound-only and needs
       no privileged ports. This also keeps ~/.cloudflared readable. -->
  <key>UserName</key>
  <string>REPLACE_WITH_USER</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>--config</string>
    <string>/Users/REPLACE_WITH_USER/.cloudflared/ms1.yml</string>
    <string>--no-autoupdate</string>
    <string>tunnel</string>
    <string>run</string>
    <string>ms1</string>
  </array>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>

  <key>StandardOutPath</key>
  <string>/Users/REPLACE_WITH_USER/Library/Logs/cloudflared-ms1.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/REPLACE_WITH_USER/Library/Logs/cloudflared-ms1.err.log</string>
</dict>
</plist>
```

Adjust the `cloudflared` path if it is not Homebrew-on-Apple-Silicon (`which cloudflared`).
`--no-autoupdate` is there so an unattended binary swap never restarts the tunnel
mid-session; update it deliberately instead.

```sh
sudo sed -i '' "s|REPLACE_WITH_USER|$(whoami)|g" \
  /Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist
sudo chown root:wheel /Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist
sudo chmod 644       /Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist

sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist
sudo launchctl kickstart -p system/com.cloudflare.cloudflared.ms1

# Both tunnels should now be listed, each with its own label
sudo launchctl list | grep -i cloudflared
```

To reload after a config edit — note the tunnel must be **restarted**, it does not hot-reload:

```sh
sudo launchctl kickstart -k system/com.cloudflare.cloudflared.ms1
```

Because this is a MacBook acting as a server, also confirm it will not sleep, or the
tunnel drops with it:

```sh
sudo pmset -a sleep 0 disablesleep 1
pmset -g | grep -E 'sleep|disablesleep'
```

---

## 5. Verify

Work outward: origin → tunnel process → edge → real client.

### 5.1 Tunnel process is healthy

```sh
curl -sS http://127.0.0.1:20251/ready ; echo
```

Expect HTTP 200 with a nonzero count of connections to the edge. This is the check to
alert on — it is true only when cloudflared has live registrations, unlike `launchctl list`.

Confirm the negotiated edge protocol is **quic**, not http2 (see §6):

```sh
grep -iE 'quic|http2|Registered tunnel connection' ~/Library/Logs/cloudflared-ms1.out.log | tail -20
```

### 5.2 Origins answer directly (bypassing Cloudflare entirely)

```sh
curl -sS http://127.0.0.1:3102/health ; echo     # relay
curl -sSi http://127.0.0.1:3101/api | head -1    # api
curl -sSI http://127.0.0.1:3100/ | head -1       # web
```

Grounded expectations:

- Relay `/health` returns `{"ok":true,"region":"ms1"}`. The route is registered in
  `apps/relay/src/index.ts` *before* the auth middleware, so it is unauthenticated.
  `FLY_REGION` defaults to `"local"` in `apps/relay/src/env.ts`, but the relay is not
  started bare here: `deploy/launchd/dev.tom-nguyen.superset.relay.plist` sets
  `FLY_REGION=ms1` (and `FLY_MACHINE_ID=ms1`, `FLY_APP_NAME=superset-relay-selfhost`).
  Only `"ok":true` matters for liveness — `smoke-test.sh` asserts exactly that and
  nothing about the region string.
- API `/api` returns **401** with a `WWW-Authenticate: Bearer realm="superset"` header —
  that is `apps/api/src/app/api/route.ts` doing its job. A 401 here is success, not failure.
- I did not find a dedicated health/liveness route in `apps/api` or `apps/web`; use the
  401 above and a root-page 200 respectively.

### 5.3 The three hostnames route through the edge

```sh
curl -sS https://superset-relay.tom-nguyen.dev/health ; echo
curl -sSi https://superset-api.tom-nguyen.dev/api | head -1
curl -sSI https://superset-app.tom-nguyen.dev/ | head -1
```

Same responses as 5.2. Error decoding:

| Symptom | Meaning |
|---|---|
| `1033` / `530` | Tunnel is not registered — cloudflared is down or `/ready` is failing |
| `502` from Cloudflare | Tunnel is up, origin is not — that app's process is down or on a different port |
| `404` body | Hostname did not match an ingress rule; hit the `http_status:404` catch-all |
| `403`, Cloudflare branded | A Zero Trust Access policy is in front of the hostname (see §6) |

### 5.4 Prove the WebSocket actually upgrades — do not assume it

A 200 on `/health` proves nothing about WebSockets. Force a real handshake and look for
`101 Switching Protocols`.

First at the origin, to establish the baseline:

```sh
curl -isS -N --max-time 5 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  http://127.0.0.1:3102/tunnel | head -12
```

Then the identical handshake through Cloudflare:

```sh
curl -isS -N --max-time 5 --http1.1 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  https://superset-relay.tom-nguyen.dev/tunnel | head -12
```

`--http1.1` is required: curl negotiates HTTP/2 with Cloudflare's edge by default, and a
raw `Upgrade:` handshake is not expressible over HTTP/2. Without it you get a confusing
non-101 that looks like a tunnel fault.

**Pass:** `HTTP/1.1 101 Switching Protocols` plus a `Sec-WebSocket-Accept:` header, on
*both*. Note the relay will then close the socket almost immediately with code 1008 —
that is correct and expected. `/tunnel` in `apps/relay/src/index.ts` upgrades first and
validates `hostId`/`token` in `onOpen`, so the 101 is the thing under test; the close
proves auth is also working.

**Fail modes:** a `426` or `400` means the origin rejected it (relay not running, or the
request hit a non-WS route). A `502` when the origin baseline passed means the failure is
between the edge and cloudflared — go to §6.

### 5.5 Prove the socket *survives* — the check people skip

The 101 above proves the path opens. It does not prove a session lasts. Cloudflare's edge
closes a proxied WebSocket after **~100 seconds with no frames in either direction** (100s
on Free/Pro; Enterprise can raise it). A terminal left idle for two minutes is exactly
that case.

The relay's own routes cannot be used for this test — `/tunnel` closes on an invalid token
and `/hosts/:hostId/*` is 401'd before it upgrades — so use `ws-verify.ts` with a scratch
origin and a **temporary** ingress rule.

Add this rule to `~/.cloudflared/ms1.yml` *above* the existing relay rule, restart, and
remove it when done (it is deliberately not in the shipped `config.yml`):

```yaml
  - hostname: superset-relay.tom-nguyen.dev
    path: ^/__wstest
    service: http://127.0.0.1:8099
```

```sh
# on ms1
bun ws-verify.ts serve

# from anywhere
bun ws-verify.ts client wss://superset-relay.tom-nguyen.dev/__wstest
```

The harness opens a socket, sends nothing for 150s, and exits 0 only if it is still open.
A close at roughly 100s with code 1006 is the edge idle timeout.

**Then remove the temporary rule and restart the tunnel.**

### 5.6 Real traffic needs a keepalive — the app already has one

Verified in the repo, so no cloudflared setting is required. Both ends ping on a 30s interval:

- `apps/relay/src/tunnel.ts` — `PING_INTERVAL_MS = 30_000`, with
  `PING_TIMEOUT_MISSED = 3` closing the socket at 1001 after three misses
- `packages/host-service/src/tunnel/tunnel-client-v2.ts` — `PING_INTERVAL_MS = 30_000`,
  plus `INBOUND_SILENCE_TIMEOUT_MS = 75_000` forcing a reconnect on silence

So the ordering is **30s ping < 75s app watchdog < 100s Cloudflare idle timeout**, with
the app's own watchdog firing first. Nothing needs to be added to the cloudflared config
for idle handling, and there is no cloudflared setting that would help if it were wrong —
this is an application-layer property.

### 5.7 Browser end-to-end

The final check is a real browser session against `https://superset-app.tom-nguyen.dev`
with DevTools → Network → WS filter. Confirm the relay socket shows status **101** and
stays green. See §6 for the CSP trap that makes this fail even when §5.4 passed.

---

## 6. WebSocket-specific settings — what matters and what does not

Researched and reasoned per setting rather than copied. Summary: **the relay needs almost
nothing exotic, and most of the knobs people reach for are no-ops here.**

| Setting | Default | Verdict for the relay |
|---|---|---|
| `service: ws://…` | — | **Not used, not valid.** cloudflared proxies WebSocket upgrades through an `http://` service automatically: it detects the 101 and switches the response body to bidirectional streaming. `ws://` is not a cloudflared service scheme. |
| `http2Origin` | `false` | **Must stay `false`.** `apps/relay` serves via `@hono/node-server`'s `serve()`, which is `node:http` — HTTP/1.1 only, no h2c. Same for `next start` on api/web. Setting `true` breaks the origin connection outright. |
| `noTLSVerify` | `false` | **No-op.** Only meaningful for an `https://` origin. All three origins are plaintext loopback. |
| `disableChunkedEncoding` | `false` | **Irrelevant.** A WSGI/IIS workaround; does not touch upgrades. |
| `connectTimeout` | `30s` | Set to `10s`. Origin is loopback; the only thing 30s buys is a slower 502 when the process is dead. |
| `tcpKeepAlive` | `30s` | Left at default, restated explicitly on the relay rule. This is TCP-level probing on the origin socket — it prevents a half-open loopback connection stranding a live tunnel. |
| `keepAliveTimeout` | `1m30s` | **Deliberately not set.** Documented as "timeout after which an idle *keepalive connection* can be discarded" — i.e. cloudflared's pooled idle HTTP connections. An upgraded WebSocket is hijacked out of that pool. *(Reasoned from the parameter's documented description; I did not find an explicit Cloudflare statement that it exempts upgraded connections, so treat this as the one inference in this table rather than a confirmed fact.)* |
| `noHappyEyeballs` | `false` | **Made unnecessary.** Origins are written as `127.0.0.1`, not `localhost`, so there is no dual-stack race to disable. |
| `protocol` (edge) | `auto` | **Pinned to `quic` — the one that really matters.** See below. |

### The `protocol` trap

This is the highest-value finding for the relay hostname.

`protocol: auto` starts on QUIC and **silently falls back to `http2`** when outbound
UDP/7844 is blocked — a realistic outcome on a home router. WebSocket upgrades over the
http2 edge transport have a standing report of returning 502 without reaching the
application (`cloudflare/cloudflared#1208`: "This problem occurs only with http2 and not
with quic"). *That issue shows as closed, but the thread does not name a fix version, so I
cannot confirm it is resolved in current cloudflared — which is exactly why pinning is the
safe call rather than trusting the fallback.*

`config.yml` therefore pins `protocol: quic`. The trade is deliberate: if UDP/7844 is
blocked, the tunnel fails loudly at startup instead of coming up healthy with a broken
relay. If that happens, open UDP/7844 outbound on the router rather than switching to
`auto`; if you must switch, re-run §5.4 and §5.5, because they may not pass.

### The CSP trap — reason a browser WS fails after §5.4 passes

`apps/web/next.config.ts` builds the `Content-Security-Policy` `connect-src` list **at
build time** from the `RELAY_URL` environment variable, and when it is unset in a
production build it falls back to the hard-coded `wss://relay.superset.sh`. So a web build
that does not have `RELAY_URL` set will emit a CSP that does not include
`wss://superset-relay.tom-nguyen.dev`, and the browser blocks the socket — while `curl`
still shows a clean 101, because curl ignores CSP.

**And the build command itself must not strip it.** turbo 2.10.9 (repo root
`package.json`) defaults to *strict* env mode and `turbo.jsonc` declares no `envMode`;
its `globalEnv` list contains neither `RELAY_URL` nor `NEXT_PUBLIC_RELAY_URL`, so a plain
`bunx turbo build ...` removes both from the environment `next build` sees — reproducing
this exact CSP fallback from a completely correct `.env`. Build as
`deploy/launchd/README.md` prescribes: export the `.env` first, then
`bunx turbo build --filter=@superset/api --filter=@superset/web --env-mode=loose`.

For the `apps/web` build, both of these must be set:

- `RELAY_URL=https://superset-relay.tom-nguyen.dev` — build-time only; feeds the CSP
  header. Not read at runtime, so setting it after the build does nothing.
- `NEXT_PUBLIC_RELAY_URL=https://superset-relay.tom-nguyen.dev` — the runtime relay base
  URL (`apps/web/src/env.ts`, consumed by `apps/web/src/trpc/relay-url.ts`).

Verify from the deployed header rather than from the build config:

```sh
curl -sSI https://superset-app.tom-nguyen.dev/ | grep -i content-security-policy | tr ';' '\n' | grep connect-src
```

The `connect-src` list must contain `wss://superset-relay.tom-nguyen.dev`. If it shows
`wss://relay.superset.sh` instead, `RELAY_URL` was missing at build time — rebuild, do not
try to patch it at the tunnel layer.

### Two Cloudflare dashboard settings to confirm

- **Network → WebSockets** must be enabled on the `tom-nguyen.dev` zone. It is on by
  default on all plans, but a 400/426 at the edge with a passing origin baseline points here.
- **Zero Trust → Access**: do not put an Access application in front of
  `superset-relay.tom-nguyen.dev`. Access interposes a browser login redirect that a
  WebSocket client cannot complete, and the relay already authenticates every connection
  itself (JWT via `verifyJWT` in `apps/relay/src/auth.ts`, plus `checkHostAccess`). Auth
  for this deployment is invitation-only email/password, seeded by `bun run db:seed-teams`
  — there is no OAuth flow for Access to piggyback on.

---

## 7. Rollback

```sh
sudo launchctl bootout system/com.cloudflare.cloudflared.ms1
sudo rm /Library/LaunchDaemons/com.cloudflare.cloudflared.ms1.plist

# Remove the three CNAMEs in the Cloudflare dashboard, then:
cloudflared tunnel delete ms1
```

`rc-hub` is untouched by all of the above — different config file, different launchd
label, different metrics port. Confirm it survived:

```sh
sudo launchctl list | grep -i cloudflared
```

---

## Unverified / assumptions

Called out explicitly rather than presented as fact:

- **`<USER>` and the `cloudflared` binary path on ms1.** Placeholders. The repo cannot
  tell me the macOS account name on ms1 or whether cloudflared is at
  `/opt/homebrew/bin/cloudflared`. Resolve with `whoami` and `which cloudflared`.
- ~~**Whether `apps/web` is actually started with `PORT` unset.**~~ **Settled by the
  launchd artifacts:** `dev.tom-nguyen.superset.web.plist` explicitly re-exports
  `PORT=3100` *after* sourcing the repo-root `.env` (which may carry a stray `PORT` from
  `.superset/setup.local.sh`, where it means the *streams* port). So the web origin is
  `127.0.0.1:3100` deterministically, and `config.yml` matches.
- **`keepAliveTimeout` not applying to upgraded WebSockets.** Reasoned from the
  parameter's documented meaning, not from an explicit Cloudflare statement. It is left
  unset, so this inference costs nothing if wrong.
- **Whether `cloudflare/cloudflared#1208` (WebSocket 502 on the http2 edge transport) is
  fixed in current cloudflared.** The issue is closed without a stated fix version. The
  config pins `protocol: quic` so the question does not need answering.
- ~~**The relay's public port on ms1.**~~ **Settled by the other artifacts:**
  `deploy/env.production.template` sets `RELAY_PORT=3102`, and
  `dev.tom-nguyen.superset.relay.plist` defaults it to `3102` if the `.env` omits it
  (`: "${RELAY_PORT:=3102}"; export RELAY_PORT`). The `4734` in `.env.local.example` and
  the `SUPERSET_PORT_BASE + 13` in `.superset/setup.local.sh` are dev-workspace values and
  are not used here. `config.yml`'s `127.0.0.1:3102` matches.
- **Whether `superset-api`/`superset-app`/`superset-relay` records already exist** in the
  `tom-nguyen.dev` zone. Only `ms1.tom-nguyen.dev` was given as pre-existing. If any of the
  three already exist as non-CNAME records, step 3.5 will error and the record must be
  removed first.
- **Nothing in the repo references cloudflared.** I grepped `docs/`, `plans/`, `README.md`
  and `.superset/`; the only hits were Cloudflare *Workers/Durable Objects* relay plans,
  unrelated to Tunnel. So there is no prior in-repo convention this had to match, and no
  existing tunnel config to reconcile with.

---

## Sources

- [Tunnel run parameters — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/) — `--config` behaviour, default config path, `protocol: auto` and its http2 fallback
- [originRequest / origin configuration parameters — Cloudflare docs](https://developers.cloudflare.com/tunnel/advanced/local-management/origin-parameters/) — defaults for `connectTimeout`, `tlsTimeout`, `tcpKeepAlive`, `keepAliveTimeout`, `keepAliveConnections`, `noTLSVerify`, `http2Origin`, `disableChunkedEncoding`, `noHappyEyeballs`
- [Run as a service on macOS — Cloudflare docs](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/macos/) — `com.cloudflare.cloudflared` fixed label, LaunchAgent vs LaunchDaemon
- [WebSockets — Cloudflare Network settings docs](https://developers.cloudflare.com/network/websockets/) — zone-level WebSocket support
- [Fix WebSocket Timeout and Silent Dropped Connections — WebSocket.org](https://websocket.org/guides/troubleshooting/timeout/) — ~100s Cloudflare edge idle timeout, 30s heartbeat guidance
- [HTTP and WebSocket Proxying — cloudflare/cloudflared (DeepWiki)](https://deepwiki.com/cloudflare/cloudflared/5.2-http-and-websocket-proxying) — automatic 101 detection and bidirectional streaming over an `http://` service
- [cloudflared#1208 — WebSocket does not work with `--protocol http2`](https://github.com/cloudflare/cloudflared/issues/1208) — the edge-transport 502
- [cloudflared#327 — `cloudflared service install` broken on macOS](https://github.com/cloudflare/cloudflared/issues/327) and [Common errors — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/common-errors/) — single-service-per-machine constraint

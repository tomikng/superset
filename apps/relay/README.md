# @superset/relay — self-hosted tunnel v2 relay

One Bun process that speaks the **tunnel v2** protocol of `apps/relay2`
(Cloudflare Durable Objects) without Cloudflare: every host-service
(`TunnelClientV2` in `packages/host-service`) and every client route is
byte-compatible with relay2, so nothing else in the stack knows the difference.

## Why this exists

Upstream deleted the v1 tunnel client from the host service (4988b7f50) once
`relay.superset.sh` moved to relay2. relay2 only runs on Cloudflare Workers
with Durable Objects, which a self-host on a single machine cannot run. This
app is the v2 wire protocol on the runtime we already have (Bun + Hono +
`@hono/node-server`, started by launchd on ms1 via `bun run src/index.ts`).

The old multi-instance Fly design (Redis host directory, `fly-replay` routing,
relay-to-relay WebSocket bridging, the v1 `/tunnel` protocol) is gone: a single
instance owns every socket, so an in-memory `HostRegistry` is both the routing
table and the presence authority. **Redis is no longer used by the relay.**

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /health` | everyone | `{ ok, region, proto: 2 }` — `proto: 2` is what makes hosts pick the v2 client and the API read `/presence` |
| `GET /v2/control?hostId&token` | host | control WebSocket; JWT verified against the API's JWKS, host access checked via `host.checkAccess` |
| `GET /v2/dial?hostId&ticket` | host | dial-back socket for one stream; the one-time ticket is the credential |
| `GET /presence?hostIds=a,b` | API | `{ hosts: { id: { online, lastSeenAt } } }`; denied/unknown hosts are omitted |
| `GET /hosts/:hostId/_whoowns` | clients | pre-flight: 200 / 401 / 403 / 503 |
| `ALL /hosts/:hostId/trpc/*` | clients | HTTP-over-dial to the host-service's tRPC |
| `GET /hosts/:hostId/*` (upgrade) | clients | WebSocket spliced verbatim to the host-service; the 101 is deferred until the host has dialed |

Close codes on WebSocket upgrades are the typed `RELAY_CLOSE` values from
`@superset/shared/tunnel-v2-protocol` (4401 auth, 4403 forbidden, 4404 unknown
ticket, 4408 stale host, 4409 replaced, 4410 tunnel gone).

## Layout

- `src/app.ts` — the Hono app; auth and access are injected (`createRelayApp`)
- `src/host-tunnel.ts` — `HostTunnel` (one per hostId, in memory) and
  `HostRegistry`; port of relay2's Durable Object with storage/alarms replaced
  by fields and a 45s liveness sweep (90s without a ping closes the host)
- `src/http-exchange.ts` — one HTTP request/response over a dial socket
  (unchanged from relay2)
- `src/auth.ts`, `src/access.ts`, `src/api-client.ts`, `src/trpc-error.ts` —
  shared with the old relay
- `src/index.ts` — env, real auth, `serve()`, SIGTERM drain

## Env

`NEXT_PUBLIC_API_URL` (JWT issuer/audience + JWKS + `host.checkAccess`),
`RELAY_PORT` (default 8080; ms1 uses 3102), `FLY_REGION` (label only).
`KV_REST_API_URL` / `KV_REST_API_TOKEN` are **not** read any more.

## Tests

```bash
cd apps/relay && bun test
```

`src/tunnel-v2.test.ts` is the hermetic version of
`apps/relay2/scripts/e2e-probe.ts`: a fake local host-service, the real
`TunnelClientV2` dialing in, and client probes over the public routes. Auth is
stubbed; everything on the wire is real.

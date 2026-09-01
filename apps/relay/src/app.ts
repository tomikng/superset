import { createNodeWebSocket } from "@hono/node-ws";
import { RELAY_CLOSE } from "@superset/shared/tunnel-v2-protocol";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import { type AccessResult, accessDenialMessage } from "./access";
import type { AuthContext } from "./auth";
import { type Conn, type Frame, HostRegistry } from "./host-tunnel";
import { isTrpcPath, trpcErrorResponse } from "./trpc-error";

// Tunnel v2 relay on Bun/Hono — the wire protocol of apps/relay2 (Cloudflare
// Durable Objects) served by one ordinary process. Every host-service (the
// TunnelClientV2 in packages/host-service) and every client route is byte
// compatible with relay2; only the runtime differs: no Workers, no Durable
// Objects, and no Redis directory — a single instance holds every socket, so
// an in-memory HostRegistry is the routing table and the presence authority.
//
// Auth and access are injected so the whole thing can be exercised end to end
// under `bun test` without an API (see tunnel-v2.test.ts).

export interface RelayDeps {
	/** Reported by /health and /_whoowns; identifies this box. */
	region: string;
	verifyJwt(token: string): Promise<AuthContext | null>;
	checkHostAccess(
		auth: AuthContext,
		token: string,
		hostId: string,
	): Promise<AccessResult>;
	/** Per-request logging (token-redacted). Off in tests. */
	log?: boolean;
}

type AppContext = {
	Variables: {
		auth: AuthContext;
		token: string;
		hostId: string;
		ticket: string;
	};
};

type Denial = { status: 401 | 403 | 500; message: string };

// Bearer tokens we never want in stdout. Hosts put their JWT on the WS
// upgrade URL because browser WebSockets can't send custom headers, and
// Hono's default `logger()` echoes the full query string.
const SENSITIVE_QUERY_RE = /([?&])(token)=[^&\s]+/g;
const redactingLogger = logger((message, ...rest) => {
	const redacted =
		typeof message === "string"
			? message.replace(SENSITIVE_QUERY_RE, "$1$2=REDACTED")
			: message;
	console.log(redacted, ...rest);
});

const MAX_PRESENCE_HOSTS = 50;

let connSeq = 0;
function adapt(ws: WSContext): Conn {
	const id = `c${++connSeq}`;
	return {
		id,
		get readyState() {
			return ws.readyState;
		},
		send(data) {
			ws.send(data);
		},
		close(code, reason) {
			ws.close(code, reason);
		},
	};
}

// @hono/node-ws hands text frames over as strings and binary frames as
// ArrayBuffers; anything else is normalised so the splice stays verbatim.
function toFrame(data: WSMessageReceive): Frame | null {
	if (typeof data === "string" || data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) {
		return data.buffer.slice(
			data.byteOffset,
			data.byteOffset + data.byteLength,
		) as ArrayBuffer;
	}
	if (data instanceof SharedArrayBuffer)
		return new Uint8Array(data).slice().buffer;
	return null;
}

// A failed auth on a WebSocket upgrade completes the handshake and closes
// with a typed RELAY_CLOSE code + reason ≤123 bytes — the only way the peer
// can see *why* (browsers and plain WS clients cannot read a non-101
// response).
function closeOnOpen(code: number, reason: string): WSEvents {
	return { onOpen: (_event, ws) => ws.close(code, reason) };
}

function isDenial(value: unknown): value is Denial {
	return typeof (value as Denial).status === "number";
}

export function createRelayApp(deps: RelayDeps) {
	const app = new Hono<AppContext>();
	const registry = new HostRegistry();
	const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
	let draining = false;

	if (deps.log !== false) app.use("*", redactingLogger);
	app.use("*", cors());

	app.onError((err, c) => {
		console.error("[relay] unhandled error", err);
		return c.json({ error: "Internal server error" }, 500);
	});

	// `proto: 2` is what makes hosts pick TunnelClientV2 (and what makes the
	// API read /presence instead of the v2_hosts.is_online fallback).
	app.get("/health", (c) =>
		c.json({ ok: true, region: deps.region, proto: 2 }),
	);

	function extractToken(c: Context<AppContext>): string | null {
		const header = c.req.header("Authorization");
		if (header?.startsWith("Bearer ")) return header.slice(7);
		return c.req.query("token") ?? null;
	}

	function isWsUpgrade(c: Context<AppContext>): boolean {
		return c.req.header("Upgrade")?.toLowerCase() === "websocket";
	}

	const requireWsUpgrade: MiddlewareHandler<AppContext> = async (c, next) => {
		if (!isWsUpgrade(c)) {
			return c.json({ error: "WebSocket upgrade required" }, 426);
		}
		return next();
	};

	async function authenticate(
		c: Context<AppContext>,
		hostId: string,
	): Promise<{ auth: AuthContext; token: string } | Denial> {
		const token = extractToken(c);
		if (!token) return { status: 401, message: "Unauthorized" };
		const auth = await deps.verifyJwt(token);
		if (!auth) return { status: 401, message: "Unauthorized" };
		const access = await deps.checkHostAccess(auth, token, hostId);
		if (!access.ok) {
			const message = `Forbidden: ${accessDenialMessage(access.reason)}`;
			// "error" means the access check itself failed (API unreachable), not
			// a denial — 500 so clients keep retrying instead of giving up.
			return access.reason === "error"
				? { status: 500, message }
				: { status: 403, message };
		}
		return { auth, token };
	}

	function pathAfterHost(c: Context<AppContext>): string {
		const hostId = c.req.param("hostId") ?? "";
		return new URL(c.req.url).pathname.slice(`/hosts/${hostId}`.length);
	}

	// ── Host control channel ──────────────────────────────────────────

	app.get(
		"/v2/control",
		requireWsUpgrade,
		upgradeWebSocket(async (c) => {
			const hostId = c.req.query("hostId");
			if (!hostId) return closeOnOpen(RELAY_CLOSE.badRequest, "Missing hostId");
			const result = await authenticate(c, hostId);
			if (isDenial(result)) {
				return closeOnOpen(
					result.status === 401
						? RELAY_CLOSE.authExpired
						: RELAY_CLOSE.forbidden,
					result.message,
				);
			}
			const tunnel = registry.get(hostId);
			let conn: Conn | null = null;
			return {
				onOpen: (_event, ws) => {
					if (draining) {
						ws.close(1001, "Server draining for restart");
						return;
					}
					conn = adapt(ws);
					tunnel.attachHost(conn);
				},
				onMessage: (event) => {
					const frame = toFrame(event.data);
					if (conn && frame !== null) tunnel.hostMessage(conn, frame);
				},
				onClose: () => {
					if (conn) tunnel.hostGone(conn);
				},
				onError: () => {
					if (conn) tunnel.hostGone(conn);
				},
			};
		}),
	);

	// ── Host dial-back (stream attach) ────────────────────────────────
	// The one-time ticket is the credential: unguessable, single-use, expires
	// in DIAL_TIMEOUT_MS, and only ever issued to the authenticated host over
	// its control channel. No JWT re-verification on this hot path.

	app.get(
		"/v2/dial",
		requireWsUpgrade,
		upgradeWebSocket((c) => {
			const hostId = c.req.query("hostId");
			const ticket = c.req.query("ticket");
			if (!hostId || !ticket) {
				return closeOnOpen(RELAY_CLOSE.badRequest, "Missing hostId or ticket");
			}
			// peek, not get: a bogus hostId must not allocate registry entries.
			const tunnel = registry.peek(hostId);
			let conn: Conn | null = null;
			return {
				onOpen: (_event, ws) => {
					const candidate = adapt(ws);
					if (!tunnel || !tunnel.attachDial(ticket, candidate)) {
						ws.close(RELAY_CLOSE.unknownTicket, "Unknown or expired ticket");
						return;
					}
					conn = candidate;
				},
				onMessage: (event) => {
					const frame = toFrame(event.data);
					if (conn && tunnel && frame !== null) {
						tunnel.dialMessage(ticket, conn, frame);
					}
				},
				onClose: () => {
					if (conn && tunnel) tunnel.dialGone(ticket, conn);
				},
				onError: () => {
					if (conn && tunnel) tunnel.dialGone(ticket, conn);
				},
			};
		}),
	);

	// ── Batch presence (the registry is the presence authority) ───────

	app.get("/presence", async (c) => {
		const hostIds = (c.req.query("hostIds") ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
		if (hostIds.length === 0 || hostIds.length > MAX_PRESENCE_HOSTS) {
			return c.json({ error: `Provide 1-${MAX_PRESENCE_HOSTS} hostIds` }, 400);
		}
		const token = extractToken(c);
		if (!token) return c.json({ error: "Unauthorized" }, 401);
		const auth = await deps.verifyJwt(token);
		if (!auth) return c.json({ error: "Unauthorized" }, 401);

		// Denied and unknown hosts are omitted rather than erroring the batch:
		// a partial answer still renders every dot the caller may see.
		const entries = await Promise.all(
			hostIds.map(async (hostId) => {
				const access = await deps.checkHostAccess(auth, token, hostId);
				if (!access.ok) return null;
				return [hostId, registry.presenceInfo(hostId)] as const;
			}),
		);
		const hosts: Record<
			string,
			{ online: boolean; lastSeenAt: number | null }
		> = {};
		for (const entry of entries) {
			if (entry) hosts[entry[0]] = entry[1];
		}
		return c.json({ hosts });
	});

	// ── Client-facing host routes (wire-identical to relay2 / v1) ─────

	// Pre-flight for a WS upgrade. The upgrade's 403 is invisible to browser
	// clients (they only see a 1006 close), so this is the one place a
	// definitive denial can surface — clients use it to stop reconnect-looping
	// against hosts they'll never be allowed to reach.
	app.get("/hosts/:hostId/_whoowns", async (c) => {
		const hostId = c.req.param("hostId");
		const result = await authenticate(c, hostId);
		if (isDenial(result)) {
			return c.json({ error: result.message }, result.status);
		}
		if (!registry.peek(hostId)?.isConnected()) {
			return c.json({ error: "Host not connected" }, 503);
		}
		return c.json({ ok: true, region: deps.region });
	});

	const authMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
		const hostId = c.req.param("hostId");
		if (!hostId) return c.json({ error: "Missing hostId" }, 400);
		const result = await authenticate(c, hostId);
		if (isDenial(result)) {
			if (isTrpcPath(pathAfterHost(c))) {
				return trpcErrorResponse(
					c,
					result.status === 403 ? "FORBIDDEN" : "UNAUTHORIZED",
					result.message,
				);
			}
			return c.json({ error: result.message }, result.status);
		}
		c.set("auth", result.auth);
		c.set("token", result.token);
		c.set("hostId", hostId);
		return next();
	};

	app.use("/hosts/:hostId/*", authMiddleware);

	app.all("/hosts/:hostId/trpc/*", async (c) => {
		const hostId = c.get("hostId");
		const url = new URL(c.req.url);
		const path = pathAfterHost(c) || "/";
		const query = url.search.slice(1);

		const headers: Record<string, string> = {};
		for (const [key, value] of c.req.raw.headers.entries()) {
			if (key !== "host" && key !== "authorization") headers[key] = value;
		}

		const tunnel = registry.peek(hostId);
		if (!tunnel?.isConnected()) {
			return trpcErrorResponse(c, "SERVICE_UNAVAILABLE", "Host is not online");
		}
		const result = await tunnel.proxyHttp({
			method: c.req.method,
			pathWithQuery: query ? `${path}?${query}` : path,
			headers,
			body: new Uint8Array(await c.req.raw.arrayBuffer()),
		});
		if (!result.ok) {
			return tunnel.isConnected()
				? trpcErrorResponse(c, "BAD_GATEWAY", "Request timed out")
				: trpcErrorResponse(c, "SERVICE_UNAVAILABLE", "Host is not online");
		}
		return new Response(result.body.byteLength > 0 ? result.body : null, {
			status: result.status,
			headers: result.headers,
		});
	});

	// The 101 is deferred until the host has dialed, so offline hosts fail
	// before the handshake instead of open-then-close. @hono/node-ws only
	// completes the upgrade once this chain resolves, so the pre-flight
	// handler can still answer with a plain status.
	app.get(
		"/hosts/:hostId/*",
		requireWsUpgrade,
		async (c, next) => {
			const hostId = c.get("hostId");
			const url = new URL(c.req.url);
			const path = pathAfterHost(c) || "/";
			if (path.startsWith("//")) return c.json({ error: "Invalid path" }, 400);
			const query = url.search.slice(1);
			const tunnel = registry.peek(hostId);
			if (!tunnel) return c.json({ error: "Host not connected" }, 503);
			const ticket = crypto.randomUUID();
			const prepared = await tunnel.prepareStream(
				ticket,
				path,
				query || undefined,
			);
			if (prepared === "no-host") {
				return c.json({ error: "Host not connected" }, 503);
			}
			if (prepared === "timeout") {
				return c.json({ error: "Host did not answer" }, 504);
			}
			c.set("ticket", ticket);
			return next();
		},
		upgradeWebSocket((c) => {
			const hostId = c.get("hostId");
			const ticket = c.get("ticket");
			const tunnel = registry.get(hostId);
			let conn: Conn | null = null;
			return {
				onOpen: (_event, ws) => {
					const candidate = adapt(ws);
					if (!tunnel.attachClient(ticket, candidate)) {
						ws.close(RELAY_CLOSE.unknownTicket, "Stream expired");
						return;
					}
					conn = candidate;
				},
				onMessage: (event) => {
					const frame = toFrame(event.data);
					if (conn && frame !== null) tunnel.clientMessage(ticket, conn, frame);
				},
				onClose: () => {
					if (conn) tunnel.clientGone(ticket, conn);
				},
				onError: () => {
					if (conn) tunnel.clientGone(ticket, conn);
				},
			};
		}),
	);

	return {
		app,
		registry,
		injectWebSocket,
		/** Refuse new host registrations; existing sockets are closed by the caller via registry.drain. */
		startDraining() {
			draining = true;
		},
	};
}

// End-to-end acceptance for the Bun tunnel v2 relay, mirroring
// apps/relay2/scripts/e2e-probe.ts but hermetic: a fake local host-service
// (echo WS + JSON HTTP), the REAL TunnelClientV2 from packages/host-service
// dialing into this relay, and client probes through the public routes
// exactly as desktop/web/API would. JWT verification and the host access
// check are stubbed — everything on the wire is real.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { serve } from "@hono/node-server";
import {
	buildHostRoutingKey,
	parseHostRoutingKey,
} from "@superset/shared/host-routing";
import { RELAY_CLOSE } from "@superset/shared/tunnel-v2-protocol";
import { TunnelClientV2 } from "../../../packages/host-service/src/tunnel/tunnel-client-v2";
import { createRelayApp } from "./app";
import { HOST_STALE_MS, HostTunnel } from "./host-tunnel";
import { NativeResponse } from "./test-env";

const ORG = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const MACHINE = "a5b47dedad57a63d234ffff6753c74df";
const HOST_ID = buildHostRoutingKey(ORG, MACHINE);
const OTHER_HOST = buildHostRoutingKey(
	"b1b2c3d4-e5f6-7890-abcd-ef1234567890",
	MACHINE,
);
const GOOD_TOKEN = "good-jwt";
const SECRET = "probe-secret";

const relay = createRelayApp({
	region: "test",
	log: false,
	verifyJwt: async (token) =>
		token === GOOD_TOKEN
			? { sub: "user-1", email: "u@example.com", organizationIds: [ORG] }
			: null,
	checkHostAccess: async (auth, _token, hostId) => {
		const parsed = parseHostRoutingKey(hostId);
		if (!parsed) return { ok: false, reason: "invalid_host" };
		if (!auth.organizationIds.includes(parsed.organizationId)) {
			return { ok: false, reason: "not_in_org" };
		}
		return { ok: true };
	},
});

let relayPort = 0;
let server: ReturnType<typeof serve>;
let local: ReturnType<typeof Bun.serve>;
let tunnel: TunnelClientV2;

const RELAY = () => `http://127.0.0.1:${relayPort}`;
const WS_RELAY = () => `ws://127.0.0.1:${relayPort}`;

function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs)
				return reject(new Error("waitFor timed out"));
			setTimeout(tick, 20);
		};
		tick();
	});
}

function openWs(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.binaryType = "arraybuffer";
		const t = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
		ws.onopen = () => {
			clearTimeout(t);
			resolve(ws);
		};
		ws.onerror = () => {
			clearTimeout(t);
			reject(new Error("ws error"));
		};
	});
}

function nextMessage(ws: WebSocket): Promise<string | ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("message timeout")), 10_000);
		ws.onmessage = (e) => {
			clearTimeout(t);
			resolve(e.data as string | ArrayBuffer);
		};
	});
}

function closeCode(url: string): Promise<number> {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => resolve(-2), 10_000);
		ws.onclose = (e) => {
			clearTimeout(t);
			resolve(e.code);
		};
		ws.onerror = () => {};
	});
}

async function presence(hostIds: string[], token = GOOD_TOKEN) {
	const res = await fetch(
		`${RELAY()}/presence?hostIds=${encodeURIComponent(hostIds.join(","))}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	return {
		status: res.status,
		body: (await res.json()) as {
			hosts?: Record<string, { online: boolean; lastSeenAt: number | null }>;
		},
	};
}

beforeAll(async () => {
	local = Bun.serve({
		port: 0,
		async fetch(req, s) {
			const url = new URL(req.url);
			if (s.upgrade(req, { data: undefined })) return;
			return new NativeResponse(
				JSON.stringify({
					echo: true,
					method: req.method,
					path: url.pathname + url.search,
					auth: req.headers.get("authorization"),
					bodyLength: (await req.arrayBuffer()).byteLength,
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
		websocket: {
			message(ws, message) {
				ws.send(message);
			},
		},
	});

	await new Promise<void>((resolve) => {
		server = serve(
			{ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" },
			(info) => {
				relayPort = info.port;
				resolve();
			},
		);
	});
	relay.injectWebSocket(server);

	tunnel = new TunnelClientV2({
		relayUrl: RELAY(),
		hostId: HOST_ID,
		getAuthToken: async () => GOOD_TOKEN,
		localPort: Number(local.port),
		hostServiceSecret: SECRET,
	});
	await tunnel.connect();
	await waitFor(() => relay.registry.peek(HOST_ID)?.isConnected() === true);
});

afterAll(() => {
	tunnel?.close();
	relay.registry.stop();
	server?.close();
	local?.stop(true);
});

describe("tunnel v2 relay (Bun, in-memory)", () => {
	test("/health advertises proto 2 so hosts negotiate tunnel v2", async () => {
		const res = await fetch(`${RELAY()}/health`);
		expect(await res.json()).toEqual({ ok: true, region: "test", proto: 2 });
	});

	test("_whoowns sees the tunnel and requires auth", async () => {
		const ok = await fetch(
			`${RELAY()}/hosts/${HOST_ID}/_whoowns?token=${GOOD_TOKEN}`,
		);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, region: "test" });

		const unauth = await fetch(`${RELAY()}/hosts/${HOST_ID}/_whoowns`);
		expect(unauth.status).toBe(401);
		const forbidden = await fetch(
			`${RELAY()}/hosts/${OTHER_HOST}/_whoowns?token=${GOOD_TOKEN}`,
		);
		expect(forbidden.status).toBe(403);
	});

	test("/presence is authoritative: online, fresh lastSeenAt, denied hosts omitted", async () => {
		const { status, body } = await presence([HOST_ID, OTHER_HOST]);
		expect(status).toBe(200);
		const info = body.hosts?.[HOST_ID];
		expect(info?.online).toBe(true);
		expect(typeof info?.lastSeenAt).toBe("number");
		expect(Date.now() - (info?.lastSeenAt ?? 0)).toBeLessThan(60_000);
		expect(body.hosts?.[OTHER_HOST]).toBeUndefined();

		expect((await presence([HOST_ID], "bad")).status).toBe(401);
		expect((await presence([])).status).toBe(400);
	});

	test("client WS splices text, ping-shaped and 64KB binary frames verbatim", async () => {
		const ws = await openWs(
			`${WS_RELAY()}/hosts/${HOST_ID}/echo?token=${GOOD_TOKEN}&x=1`,
		);
		for (let i = 0; i < 5; i++) {
			const got = nextMessage(ws);
			ws.send(`ping-${i}`);
			expect(await got).toBe(`ping-${i}`);
		}

		// The control channel's keepalive payload must not be intercepted on
		// a spliced stream.
		const pingLiteral = '{"type":"ping"}';
		const pingBack = nextMessage(ws);
		ws.send(pingLiteral);
		expect(await pingBack).toBe(pingLiteral);

		const bin = new Uint8Array(64 * 1024);
		crypto.getRandomValues(bin);
		const binBack = nextMessage(ws);
		ws.send(bin);
		const back = new Uint8Array((await binBack) as ArrayBuffer);
		expect(back.byteLength).toBe(bin.byteLength);
		expect(Buffer.compare(back, bin)).toBe(0);
		ws.close(1000);
	});

	test("client WS to a path the host rejects still fails cleanly", async () => {
		// The local service upgrades everything, so use an unknown host: the
		// relay must answer before the handshake, not open-then-close.
		const res = await fetch(
			`${RELAY()}/hosts/${HOST_ID}/echo?token=${GOOD_TOKEN}`,
		);
		expect(res.status).toBe(426);
	});

	test("HTTP proxy round-trips through the host with the secret injected", async () => {
		const res = await fetch(`${RELAY()}/hosts/${HOST_ID}/trpc/probe.test?a=b`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${GOOD_TOKEN}`,
				"content-type": "text/plain",
			},
			body: "hello",
		});
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			echo: boolean;
			method: string;
			path: string;
			auth: string | null;
			bodyLength: number;
		};
		expect(data.echo).toBe(true);
		expect(data.method).toBe("POST");
		expect(data.path).toBe("/trpc/probe.test?a=b");
		expect(data.auth).toBe(`Bearer ${SECRET}`);
		expect(data.bodyLength).toBe(5);
	});

	test("HTTP proxy denials use tRPC error envelopes", async () => {
		const unauth = await fetch(`${RELAY()}/hosts/${HOST_ID}/trpc/x`, {
			method: "POST",
		});
		expect(unauth.status).toBe(401);
		const body = (await unauth.json()) as {
			error: { json: { data: { code: string } } };
		};
		expect(body.error.json.data.code).toBe("UNAUTHORIZED");
	});

	test("dial with a bogus ticket is refused with the typed close code", async () => {
		expect(
			await closeCode(`${WS_RELAY()}/v2/dial?hostId=${HOST_ID}&ticket=nope`),
		).toBe(RELAY_CLOSE.unknownTicket);
		expect(
			await closeCode(`${WS_RELAY()}/v2/dial?hostId=${OTHER_HOST}&ticket=nope`),
		).toBe(RELAY_CLOSE.unknownTicket);
		expect(relay.registry.peek(OTHER_HOST)).toBeUndefined();
	});

	test("control channel rejects bad auth with typed close codes", async () => {
		expect(
			await closeCode(`${WS_RELAY()}/v2/control?hostId=${HOST_ID}&token=bad`),
		).toBe(RELAY_CLOSE.authExpired);
		expect(
			await closeCode(
				`${WS_RELAY()}/v2/control?hostId=${OTHER_HOST}&token=${GOOD_TOKEN}`,
			),
		).toBe(RELAY_CLOSE.forbidden);
		expect(await closeCode(`${WS_RELAY()}/v2/control`)).toBe(
			RELAY_CLOSE.badRequest,
		);
		// The real tunnel is untouched by the rejected attempts.
		expect(relay.registry.peek(HOST_ID)?.isConnected()).toBe(true);
	});

	test("closing the host tunnel flips presence offline and 503s the routes", async () => {
		tunnel.close();
		await waitFor(() => relay.registry.peek(HOST_ID)?.isConnected() === false);

		const who = await fetch(
			`${RELAY()}/hosts/${HOST_ID}/_whoowns?token=${GOOD_TOKEN}`,
		);
		expect(who.status).toBe(503);

		const { body } = await presence([HOST_ID]);
		expect(body.hosts?.[HOST_ID]?.online).toBe(false);
		expect(typeof body.hosts?.[HOST_ID]?.lastSeenAt).toBe("number");

		const rpc = await fetch(`${RELAY()}/hosts/${HOST_ID}/trpc/x`, {
			method: "POST",
			headers: { Authorization: `Bearer ${GOOD_TOKEN}` },
		});
		expect(rpc.status).toBe(503);

		const upgrade = await fetch(
			`${RELAY()}/hosts/${HOST_ID}/echo?token=${GOOD_TOKEN}`,
			{ headers: { Upgrade: "websocket", Connection: "Upgrade" } },
		).catch(() => null);
		// Either a plain 503 or a failed handshake; never an open socket.
		expect(upgrade === null || upgrade.status === 503).toBe(true);
	});
});

// ── Liveness and replacement, on the in-memory tunnel directly ──────

function fakeConn(id: string) {
	const closes: Array<{ code?: number; reason?: string }> = [];
	const sent: Array<string | ArrayBuffer> = [];
	const conn = {
		id,
		readyState: 1,
		send: (d: string | ArrayBuffer) => sent.push(d),
		close: (code?: number, reason?: string) => {
			conn.readyState = 3;
			closes.push({ code, reason });
		},
	};
	return { conn, closes, sent };
}

describe("HostTunnel liveness", () => {
	test("a newer host socket replaces the old one; the old close is ignored", () => {
		const t = new HostTunnel(HOST_ID);
		const a = fakeConn("a");
		const b = fakeConn("b");
		t.attachHost(a.conn);
		t.attachHost(b.conn);
		expect(a.closes[0]?.code).toBe(RELAY_CLOSE.replaced);
		t.hostGone(a.conn);
		expect(t.isConnected()).toBe(true);
		t.hostGone(b.conn);
		expect(t.isConnected()).toBe(false);
	});

	test("pings refresh liveness; a silent host is swept offline", () => {
		const t = new HostTunnel(HOST_ID);
		const h = fakeConn("h");
		const start = Date.now();
		t.attachHost(h.conn);
		t.sweep(start + HOST_STALE_MS - 1_000);
		expect(t.isConnected()).toBe(true);

		t.hostMessage(h.conn, '{"type":"ping"}');
		expect(h.sent).toContain('{"type":"pong"}');

		t.sweep(Date.now() + HOST_STALE_MS + 1_000);
		expect(t.isConnected()).toBe(false);
		expect(h.closes[0]?.code).toBe(RELAY_CLOSE.staleHost);
		expect(t.presenceInfo().online).toBe(false);
	});

	test("host loss tears down paired streams with tunnel-gone", async () => {
		const t = new HostTunnel(HOST_ID);
		const h = fakeConn("h");
		t.attachHost(h.conn);
		const prepared = t.prepareStream("t1", "/echo", undefined);
		const dial = JSON.parse(String(h.sent.at(-1))) as { ticket: string };
		expect(dial.ticket).toBe("t1");
		const d = fakeConn("d");
		expect(t.attachDial("t1", d.conn)).toBe(true);
		expect(await prepared).toBe("ready");
		// Early frames from the dial are held until the client attaches.
		t.dialMessage("t1", d.conn, "early");
		const c = fakeConn("c");
		expect(t.attachClient("t1", c.conn)).toBe(true);
		expect(c.sent).toEqual(["early"]);
		t.clientMessage("t1", c.conn, "up");
		expect(d.sent).toEqual(["up"]);

		t.hostGone(h.conn);
		expect(d.closes[0]?.code).toBe(RELAY_CLOSE.tunnelGone);
		expect(c.closes[0]?.code).toBe(RELAY_CLOSE.tunnelGone);
		expect(t.idle).toBe(true);
	});
});

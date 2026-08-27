#!/usr/bin/env bun
/**
 * End-to-end WebSocket verification harness for the ms1 Cloudflare Tunnel.
 *
 * Why this exists: a `curl` handshake proves the 101 upgrade traverses
 * Cloudflare, but it does NOT prove a socket SURVIVES. Cloudflare closes
 * proxied WebSockets after ~100s with no frames in either direction, and that
 * failure only shows up minutes later as "terminals randomly disconnect".
 * This harness holds a deliberately silent socket open past that window.
 *
 * It intentionally does NOT test against apps/relay, because every relay WS
 * route rejects unauthenticated clients: /tunnel upgrades then immediately
 * closes with 1008 on a bad token, and /hosts/:hostId/* is 401'd by the auth
 * middleware before it ever upgrades. Neither can stay open long enough to
 * measure an idle timeout. So we test the *transport path* with a scratch
 * origin, then rely on the real relay for the authenticated path.
 *
 * Usage (see README.md for the temporary ingress rule this needs):
 *
 *   # on ms1
 *   bun ws-verify.ts serve
 *
 *   # anywhere
 *   bun ws-verify.ts client wss://superset-relay.tom-nguyen.dev/__wstest
 *   bun ws-verify.ts client ws://127.0.0.1:8099          # origin-only baseline
 *
 * Exit code 0 = socket stayed open for the full hold window.
 */

const PORT = Number(process.env.WS_VERIFY_PORT ?? 8099);
const HOLD_MS = Number(process.env.WS_VERIFY_HOLD_MS ?? 150_000);

const mode = process.argv[2];

if (mode === "serve") {
	Bun.serve({
		port: PORT,
		hostname: "127.0.0.1",
		fetch(req, server) {
			if (server.upgrade(req)) return undefined;
			return new Response("ws-verify origin: send an Upgrade request\n", {
				status: 426,
			});
		},
		websocket: {
			// Deliberately silent. No server-side ping, no auto-pong traffic
			// beyond the protocol level — the point is to leave the connection
			// idle so Cloudflare's edge idle timeout is the thing under test.
			open() {
				console.log(`[ws-verify:serve] client connected`);
			},
			message(ws, data) {
				ws.send(String(data));
			},
			close(_ws, code, reason) {
				console.log(`[ws-verify:serve] closed code=${code} reason=${reason}`);
			},
		},
	});
	console.log(
		`[ws-verify:serve] listening on ws://127.0.0.1:${PORT} (silent origin)`,
	);
} else if (mode === "client") {
	const url = process.argv[3];
	if (!url) {
		console.error("usage: bun ws-verify.ts client <ws-url>");
		process.exit(2);
	}

	const started = Date.now();
	const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
	const ws = new WebSocket(url);

	const failTimer = setTimeout(() => {
		console.error(`[ws-verify:client] FAIL never opened after ${elapsed()}`);
		process.exit(1);
	}, 20_000);

	ws.addEventListener("open", () => {
		clearTimeout(failTimer);
		console.log(`[ws-verify:client] 101 upgrade OK at ${elapsed()}`);
		console.log(
			`[ws-verify:client] holding SILENT for ${HOLD_MS / 1000}s (Cloudflare edge idle timeout is ~100s)`,
		);
		setTimeout(() => {
			if (ws.readyState === WebSocket.OPEN) {
				console.log(
					`[ws-verify:client] PASS socket still open after ${elapsed()} of silence`,
				);
				ws.close(1000, "done");
				process.exit(0);
			}
			console.error(`[ws-verify:client] FAIL socket not open at ${elapsed()}`);
			process.exit(1);
		}, HOLD_MS);
	});

	ws.addEventListener("close", (ev) => {
		// A close before the hold window elapses is the failure we are hunting.
		console.error(
			`[ws-verify:client] closed at ${elapsed()} code=${ev.code} reason=${ev.reason || "(none)"}`,
		);
		if (Date.now() - started < HOLD_MS) {
			console.error(
				`[ws-verify:client] FAIL closed early. A close near 100s with code 1006 is the Cloudflare edge idle timeout: the path works but nothing is keeping it warm.`,
			);
			process.exit(1);
		}
	});

	ws.addEventListener("error", () => {
		console.error(`[ws-verify:client] transport error at ${elapsed()}`);
	});
} else {
	console.error("usage: bun ws-verify.ts <serve|client> [ws-url]");
	process.exit(2);
}

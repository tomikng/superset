import { serve } from "@hono/node-server";
import { checkHostAccess } from "./access";
import { createRelayApp } from "./app";
import { verifyJWT } from "./auth";
import { env } from "./env";

// Self-hosted relay entrypoint: one Bun process, tunnel v2 (see app.ts).
// Historically this was the multi-instance Fly relay with a Redis host
// directory and fly-replay routing; a single instance needs neither, and the
// v1 tunnel protocol it spoke was removed from the host-service upstream.

process.on("uncaughtException", (err) => {
	console.error("[relay] uncaughtException (suppressed)", err);
});
process.on("unhandledRejection", (reason) => {
	console.error("[relay] unhandledRejection (suppressed)", reason);
});

const relay = createRelayApp({
	region: env.FLY_REGION,
	verifyJwt: (token) => verifyJWT(token, env.NEXT_PUBLIC_API_URL),
	checkHostAccess,
});
relay.registry.start();

// Graceful drain on SIGINT/SIGTERM (launchd restarts, Ctrl-C): stop accepting
// connections, then close every host control socket so host-services
// reconnect promptly (partysocket retries within 1-5s) instead of waiting on
// their 75s inbound-silence watchdog after a TCP RST.
let server: ReturnType<typeof serve> | null = null;
let draining = false;
const handleDrain = async (signal: string) => {
	if (draining) return;
	draining = true;
	console.log(`[relay] ${signal} received, draining tunnels`);
	try {
		relay.startDraining();
		server?.close();
		const closed = relay.registry.drain(1001, "Server draining for restart");
		console.log(`[relay] closed ${closed} host tunnels`);
		// Brief tail wait so the close handshakes get a chance to complete
		// before the process exits and RSTs the underlying TCP.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	} catch (err) {
		console.error("[relay] drain failed", err);
	}
	process.exit(0);
};
process.on("SIGINT", () => void handleDrain("SIGINT"));
process.on("SIGTERM", () => void handleDrain("SIGTERM"));

// Bind dual-stack (`::`) so both IPv4 and IPv6 loopback/proxy traffic land.
server = serve(
	{ fetch: relay.app.fetch, port: env.RELAY_PORT, hostname: "::" },
	(info) => {
		console.log(
			`[relay] listening on [::]:${info.port} (region=${env.FLY_REGION}, tunnel v2)`,
		);
	},
);
relay.injectWebSocket(server);

// Disable Nagle's algorithm on every incoming connection. Both the client's
// terminal WebSocket and the host's sockets connect here, so this covers the
// relay's writes in both directions. Nagle interacting with TCP delayed-ACK
// adds tens-to-hundreds of milliseconds to small, sparse interactive frames
// (terminal keystrokes and their echoes). (@hono/node-server returns a Node
// http.Server.)
(server as unknown as import("node:http").Server).on(
	"connection",
	(socket: import("node:net").Socket) => {
		socket.setNoDelay(true);
	},
);

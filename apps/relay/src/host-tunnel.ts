import {
	type ControlPing,
	DIAL_TIMEOUT_MS,
	RELAY_CLOSE,
	type StreamDial,
} from "@superset/shared/tunnel-v2-protocol";
import {
	type HttpExchangeRequest,
	type HttpExchangeResult,
	HttpExchanges,
} from "./http-exchange";

export type Frame = string | ArrayBuffer;

/** The slice of a WebSocket the tunnel needs. app.ts adapts hono's WSContext. */
export interface Conn {
	readonly id: string;
	readonly readyState: number;
	send(data: Frame): void;
	close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;
// Frames a dial may deliver before the client's deferred upgrade completes.
const MAX_EARLY_FRAMES = 256;
// A dial that never pairs with a client (aborted upgrade, late arrival) is
// closed rather than left open.
const UNPAIRED_DIAL_TIMEOUT_MS = 15_000;
// Liveness sweep: abrupt terminations kill sockets without delivering a close
// event, leaving zombie sockets registered. The socket set is the presence
// authority, so the sweep is what keeps it truthful.
export const LIVENESS_SWEEP_MS = 45_000;
// Three missed 30s host keepalives. A host that cannot ping for this long
// cannot serve dials either, so closing it never severs a usable tunnel.
export const HOST_STALE_MS = 90_000;

export type PrepareStreamResult = "ready" | "no-host" | "timeout";

export interface PresenceInfo {
	online: boolean;
	lastSeenAt: number | null;
}

interface Stream {
	dial: Conn;
	client: Conn | null;
	early: Frame[];
	unpairedTimer: ReturnType<typeof setTimeout> | null;
}

// Tunnel v2 for one host, in memory. This is apps/relay2's HostTunnel Durable
// Object with the Workers runtime removed: a single relay process owns every
// socket, so a plain object per hostId replaces the DO and its storage (which
// only ever held lastHostSeenAt and the liveness alarm). Stream traffic is
// never parsed — a dial socket and its client are spliced verbatim.
export class HostTunnel {
	readonly hostId: string;
	private host: Conn | null = null;
	private lastHostSeenAt: number | null = null;
	private readonly pendingDials = new Map<string, (ok: boolean) => void>();
	private readonly streams = new Map<string, Stream>();
	private readonly httpExchanges = new HttpExchanges();

	constructor(hostId: string) {
		this.hostId = hostId;
	}

	// ── Queries (called by the routes) ────────────────────────────────

	isConnected(): boolean {
		return this.host !== null && this.host.readyState === WS_OPEN;
	}

	presenceInfo(): PresenceInfo {
		return { online: this.isConnected(), lastSeenAt: this.lastHostSeenAt };
	}

	/** Nothing attached: the registry may forget this entry. */
	get idle(): boolean {
		return (
			this.host === null &&
			this.streams.size === 0 &&
			this.pendingDials.size === 0 &&
			this.httpExchanges.size === 0
		);
	}

	prepareStream(
		ticket: string,
		path: string,
		query: string | undefined,
	): Promise<PrepareStreamResult> {
		const host = this.liveHost();
		if (!host) return Promise.resolve("no-host");
		const arrived = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingDials.delete(ticket);
				resolve(false);
			}, DIAL_TIMEOUT_MS);
			this.pendingDials.set(ticket, (ok) => {
				clearTimeout(timer);
				this.pendingDials.delete(ticket);
				resolve(ok);
			});
		});
		this.sendDial(host, {
			type: "stream:dial",
			ticket,
			kind: "ws",
			path,
			query,
		});
		return arrived.then((ok) => (ok ? "ready" : "timeout"));
	}

	proxyHttp(request: HttpExchangeRequest): Promise<HttpExchangeResult> {
		const host = this.liveHost();
		if (!host) return Promise.resolve({ ok: false, reason: "timeout" });
		const ticket = crypto.randomUUID();
		const result = this.httpExchanges.begin(ticket, request);
		this.sendDial(host, {
			type: "stream:dial",
			ticket,
			kind: "http",
			path: request.pathWithQuery,
		});
		return result;
	}

	// ── Host control channel ──────────────────────────────────────────

	attachHost(conn: Conn): void {
		const previous = this.host;
		// State first, so the replaced socket's close (delivered any moment)
		// can tell it is no longer the live host and leaves this one alone.
		this.host = conn;
		this.lastHostSeenAt = Date.now();
		// Last-write-wins: the new socket evicts any old one.
		if (previous && previous !== conn) {
			closeQuietly(previous, RELAY_CLOSE.replaced, "Replaced by new tunnel");
		}
		console.log(`[relay] host connected: ${this.hostId}`);
	}

	hostMessage(conn: Conn, message: Frame): void {
		if (typeof message !== "string") return;
		let ping: ControlPing;
		try {
			ping = JSON.parse(message) as ControlPing;
		} catch {
			return;
		}
		if (ping.type !== "ping") return;
		// Only the live host refreshes liveness: a ping in flight from a
		// just-replaced socket must not extend the stale window.
		if (this.host === conn) this.lastHostSeenAt = Date.now();
		conn.send('{"type":"pong"}');
	}

	hostGone(conn: Conn): void {
		// A replaced socket's close lands after the new one registered.
		if (this.host !== conn) return;
		this.host = null;
		for (const [, stream] of this.streams) {
			if (stream.unpairedTimer) clearTimeout(stream.unpairedTimer);
			closeQuietly(stream.dial, RELAY_CLOSE.tunnelGone, "Tunnel disconnected");
			if (stream.client) {
				closeQuietly(
					stream.client,
					RELAY_CLOSE.tunnelGone,
					"Tunnel disconnected",
				);
			}
		}
		this.streams.clear();
		for (const resolve of [...this.pendingDials.values()]) resolve(false);
		this.httpExchanges.abortAll();
		console.log(`[relay] host disconnected: ${this.hostId}`);
	}

	// ── Host dial-back sockets ────────────────────────────────────────

	/** False when the ticket is unknown, expired or consumed; caller closes. */
	attachDial(ticket: string, conn: Conn): boolean {
		if (this.httpExchanges.has(ticket)) {
			this.httpExchanges.onDialConnect(ticket, conn);
			return true;
		}
		const waiting = this.pendingDials.get(ticket);
		if (!waiting) return false;
		const stream: Stream = {
			dial: conn,
			client: null,
			early: [],
			unpairedTimer: null,
		};
		stream.unpairedTimer = setTimeout(() => {
			stream.unpairedTimer = null;
			this.streams.delete(ticket);
			closeQuietly(conn, RELAY_CLOSE.unknownTicket, "Client never attached");
		}, UNPAIRED_DIAL_TIMEOUT_MS);
		this.streams.set(ticket, stream);
		waiting(true);
		return true;
	}

	dialMessage(ticket: string, conn: Conn, message: Frame): void {
		if (this.httpExchanges.has(ticket)) {
			this.httpExchanges.onDialMessage(ticket, conn, message);
			return;
		}
		const stream = this.streams.get(ticket);
		if (!stream || stream.dial !== conn) return;
		if (stream.client) {
			stream.client.send(message);
			return;
		}
		// Unpaired: the client's upgrade is still completing. Overflow tears
		// the stream down rather than silently dropping frames.
		if (stream.early.length >= MAX_EARLY_FRAMES) {
			this.dropStream(ticket);
			closeQuietly(conn, 1011, "Stream never paired");
			return;
		}
		stream.early.push(message);
	}

	dialGone(ticket: string, conn: Conn): void {
		const stream = this.streams.get(ticket);
		if (!stream || stream.dial !== conn) return;
		this.dropStream(ticket);
		if (stream.client) closeQuietly(stream.client, 1001, "Stream closed");
	}

	// ── Client sockets ────────────────────────────────────────────────

	/** False when no dial is waiting under this ticket; caller closes. */
	attachClient(ticket: string, conn: Conn): boolean {
		const stream = this.streams.get(ticket);
		if (!stream || stream.client) return false;
		if (stream.unpairedTimer) {
			clearTimeout(stream.unpairedTimer);
			stream.unpairedTimer = null;
		}
		stream.client = conn;
		for (const frame of stream.early) conn.send(frame);
		stream.early = [];
		return true;
	}

	clientMessage(ticket: string, conn: Conn, message: Frame): void {
		const stream = this.streams.get(ticket);
		if (!stream || stream.client !== conn) return;
		stream.dial.send(message);
	}

	clientGone(ticket: string, conn: Conn): void {
		const stream = this.streams.get(ticket);
		if (!stream || stream.client !== conn) return;
		this.dropStream(ticket);
		closeQuietly(stream.dial, 1001, "Stream closed");
	}

	// ── Liveness ──────────────────────────────────────────────────────

	sweep(now = Date.now()): void {
		const host = this.host;
		if (!host || host.readyState !== WS_OPEN) return;
		if (now - (this.lastHostSeenAt ?? 0) <= HOST_STALE_MS) return;
		console.log(`[relay] host stale, closing: ${this.hostId}`);
		// A dead peer never completes the close handshake, so flip presence
		// now instead of waiting on a close event that may never arrive.
		this.hostGone(host);
		closeQuietly(host, RELAY_CLOSE.staleHost, "No keepalive from host");
	}

	/** Close the host socket (a restart is coming); streams follow via hostGone. */
	closeHost(code: number, reason: string): boolean {
		const host = this.host;
		if (!host) return false;
		this.hostGone(host);
		closeQuietly(host, code, reason);
		return true;
	}

	// ── Internals ─────────────────────────────────────────────────────

	private liveHost(): Conn | null {
		return this.isConnected() ? this.host : null;
	}

	private dropStream(ticket: string): void {
		const stream = this.streams.get(ticket);
		if (!stream) return;
		if (stream.unpairedTimer) clearTimeout(stream.unpairedTimer);
		this.streams.delete(ticket);
	}

	private sendDial(host: Conn, dial: StreamDial): void {
		host.send(JSON.stringify(dial));
	}
}

// All hosts known to this relay process. Entries are created on demand (a
// client may ask about a host before it ever connects) and forgotten by the
// sweep once nothing is attached, so the map tracks live interest, not history.
export class HostRegistry {
	private readonly tunnels = new Map<string, HostTunnel>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	get(hostId: string): HostTunnel {
		let tunnel = this.tunnels.get(hostId);
		if (!tunnel) {
			tunnel = new HostTunnel(hostId);
			this.tunnels.set(hostId, tunnel);
		}
		return tunnel;
	}

	peek(hostId: string): HostTunnel | undefined {
		return this.tunnels.get(hostId);
	}

	presenceInfo(hostId: string): PresenceInfo {
		return (
			this.tunnels.get(hostId)?.presenceInfo() ?? {
				online: false,
				lastSeenAt: null,
			}
		);
	}

	get connectedCount(): number {
		let n = 0;
		for (const tunnel of this.tunnels.values()) if (tunnel.isConnected()) n++;
		return n;
	}

	sweep(now = Date.now()): void {
		for (const [hostId, tunnel] of this.tunnels) {
			tunnel.sweep(now);
			if (tunnel.idle) this.tunnels.delete(hostId);
		}
	}

	start(intervalMs = LIVENESS_SWEEP_MS): void {
		if (this.sweepTimer) return;
		this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
		this.sweepTimer.unref?.();
	}

	stop(): void {
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	/** Close every host control socket; returns how many were open. */
	drain(code: number, reason: string): number {
		let closed = 0;
		for (const tunnel of this.tunnels.values()) {
			if (tunnel.closeHost(code, reason)) closed++;
		}
		return closed;
	}
}

function closeQuietly(conn: Conn, code: number, reason: string): void {
	try {
		conn.close(code, reason);
	} catch {}
}

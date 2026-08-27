/**
 * Static file server for the self-hosted desktop update feed.
 *
 * Serves RELEASES_DIR (default ~/superset-releases) under /releases/ on
 * RELEASES_PORT (default 3103). cloudflared routes
 * https://superset-app.tom-nguyen.dev/releases/* here, which is what the
 * desktop app's DESKTOP_UPDATE_FEED_URL and the web "Download for Mac" button
 * point at. electron-updater fetches `latest-mac.yml` then the zip it names;
 * humans fetch the stable-named `Superset-arm64.dmg`.
 *
 * Run: bun run deploy/releases-server.ts (the `releases` launchd job does).
 */
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";

const dir = resolve(
	process.env.RELEASES_DIR ?? join(homedir(), "superset-releases"),
);
const port = Number(process.env.RELEASES_PORT ?? 3103);
const prefix = "/releases/";

const types: Record<string, string> = {
	".yml": "text/yaml; charset=utf-8",
	".zip": "application/zip",
	".dmg": "application/x-apple-diskimage",
	".blockmap": "application/octet-stream",
	".txt": "text/plain; charset=utf-8",
};

Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(req) {
		const url = new URL(req.url);
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("method not allowed", { status: 405 });
		}
		if (!url.pathname.startsWith(prefix)) {
			return new Response("not found", { status: 404 });
		}
		// Reject traversal before touching the filesystem.
		const rel = normalize(
			decodeURIComponent(url.pathname.slice(prefix.length)),
		);
		if (
			rel.startsWith("..") ||
			rel.includes("/../") ||
			rel === "" ||
			rel === "."
		) {
			return new Response("not found", { status: 404 });
		}
		const path = join(dir, rel);
		if (
			!path.startsWith(`${dir}/`) ||
			!existsSync(path) ||
			!statSync(path).isFile()
		) {
			return new Response("not found", { status: 404 });
		}
		const ext = path.slice(path.lastIndexOf("."));
		const file = Bun.file(path);
		return new Response(req.method === "HEAD" ? null : file, {
			headers: {
				"content-type": types[ext] ?? "application/octet-stream",
				"content-length": String(file.size),
				// The yml is the "is there a newer version" answer; never cache it.
				"cache-control": ext === ".yml" ? "no-store" : "public, max-age=3600",
			},
		});
	},
});

console.log(`[releases] serving ${dir} at http://127.0.0.1:${port}${prefix}`);

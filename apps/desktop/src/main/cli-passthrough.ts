// biome-ignore lint/style/noRestrictedImports: runs before the app boots and exits right after; blocking is what keeps the app from starting
import { spawnSync } from "node:child_process";
import { app } from "electron";
import { resolveBundledCliPath } from "./lib/bundled-cli";
import { isCliInvocation } from "./lib/cli-argv";

// `/usr/bin/superset` is this app, so `superset hosts list` from a shell that
// lacks the CLI shim on PATH lands here. Booting the whole app for it never
// exits and spins a core, so hand the arguments to the bundled CLI instead.
// Imported first by index.ts so it runs before any other startup side effect.
const args = process.argv.slice(1);
if (app.isPackaged && isCliInvocation(args)) {
	const cliPath = resolveBundledCliPath();
	if (!cliPath) {
		process.stderr.write("superset: bundled CLI not found in this install\n");
		process.exit(1);
	}
	const result = spawnSync(cliPath, args, { stdio: "inherit" });
	if (result.error) {
		process.stderr.write(`superset: ${result.error.message}\n`);
	}
	process.exit(result.status ?? 1);
}

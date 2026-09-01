import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Guards the bun patch on expo-modules-jsi (patches/README.md). Xcode 26.2
// (Swift 6.2.3) refuses SWIFT_RETURNS_RETAINED on the constructors of a
// SWIFT_SHARED_REFERENCE class, so an unpatched package fails to compile
// every iOS build on this toolchain. patchedDependencies is keyed to an exact
// version; an Expo SDK bump silently drops the patch. If this fails after a
// bump, regenerate per patches/README.md (or delete the patch only once
// upstream has removed the annotations); do NOT delete the test.
const repoRoot = join(import.meta.dir, "../..");
const patched: Record<string, string> =
	JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
		.patchedDependencies ?? {};
const lockfile = readFileSync(join(repoRoot, "bun.lock"), "utf8");
// The isolated linker does not hoist transitive packages, so reach
// expo-modules-jsi the way the iOS build does: through expo-modules-core.
const expoModulesCore = dirname(
	Bun.resolveSync("expo-modules-core/package.json", import.meta.dir),
);
const expoModulesJsi = dirname(
	Bun.resolveSync("expo-modules-jsi/package.json", expoModulesCore),
);
const header = readFileSync(
	join(
		expoModulesJsi,
		"apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h",
	),
	"utf8",
);

describe("expo-modules-jsi Xcode 26.2 constructor patch", () => {
	test("every resolved expo-modules-jsi version is patched", () => {
		const resolved = [
			...lockfile.matchAll(/"expo-modules-jsi": \["expo-modules-jsi@([^"]+)"/g),
		].map((match) => `expo-modules-jsi@${match[1]}`);

		expect(resolved.length).toBeGreaterThan(0);
		for (const version of resolved) {
			expect(patched[version]).toBeString();
		}
	});

	test("RuntimeScheduler constructors carry no SWIFT_RETURNS_RETAINED", () => {
		expect(header).toContain("SWIFT_SHARED_REFERENCE(retainRuntimeScheduler");
		expect(header).not.toMatch(/SWIFT_RETURNS_RETAINED\s+RuntimeScheduler\(/);
	});
});

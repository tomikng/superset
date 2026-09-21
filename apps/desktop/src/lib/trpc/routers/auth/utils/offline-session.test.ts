import {
	afterAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalSupersetHomeDir = process.env.SUPERSET_HOME_DIR;
const testSupersetHomeDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "offline-session-test-"),
);
process.env.SUPERSET_HOME_DIR = testSupersetHomeDir;
const sessionFile = path.join(testSupersetHomeDir, "offline-session.enc");

// Same reversible storage boundary as auth-functions.test.ts, so the file
// contents can be inspected.
mock.module("./crypto-storage", () => ({
	encrypt: (plaintext: string) => Buffer.from(plaintext),
	decrypt: (data: Buffer) => data.toString("utf8"),
}));

const { clearOfflineSession, loadOfflineSession, saveOfflineSession } =
	await import("./offline-session");

const createdAt = new Date("2026-08-01T10:00:00.000Z");

function sessionFor(token: string) {
	return {
		user: { id: "user-1", email: "me@example.com", createdAt },
		session: {
			token,
			activeOrganizationId: "org-1",
			organizationIds: ["org-1", "org-2"],
		},
	};
}

beforeEach(() => {
	process.env.SUPERSET_HOME_DIR = testSupersetHomeDir;
	for (const entry of fs.readdirSync(testSupersetHomeDir)) {
		fs.rmSync(path.join(testSupersetHomeDir, entry), {
			recursive: true,
			force: true,
		});
	}
});

afterAll(() => {
	fs.rmSync(testSupersetHomeDir, { recursive: true, force: true });
	if (originalSupersetHomeDir === undefined) {
		delete process.env.SUPERSET_HOME_DIR;
	} else {
		process.env.SUPERSET_HOME_DIR = originalSupersetHomeDir;
	}
});

describe("offline session cache", () => {
	test("round-trips the session for the token it was saved with, dates intact", async () => {
		await saveOfflineSession({
			token: "token-a",
			session: sessionFor("token-a"),
		});

		const loaded = await loadOfflineSession("token-a");
		expect(loaded?.session).toEqual(sessionFor("token-a"));
		expect(loaded?.session.user.createdAt).toBeInstanceOf(Date);
		expect(Date.parse(loaded?.savedAt ?? "")).not.toBeNaN();
	});

	test("never writes the bearer token to disk", async () => {
		await saveOfflineSession({
			token: "token-a",
			session: sessionFor("token-a"),
		});

		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain("token-a");
		expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
	});

	test("is inert for any other sign-in", async () => {
		await saveOfflineSession({
			token: "token-a",
			session: sessionFor("token-a"),
		});

		expect(await loadOfflineSession("token-b")).toBeNull();
	});

	test("reports nothing cached without logging", async () => {
		const warnSpy = spyOn(console, "warn");
		try {
			expect(await loadOfflineSession("token-a")).toBeNull();
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("discards an unreadable cache", async () => {
		fs.writeFileSync(sessionFile, "not json");
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await loadOfflineSession("token-a")).toBeNull();
		} finally {
			warnSpy.mockRestore();
		}
		expect(fs.existsSync(sessionFile)).toBe(false);
	});

	test("sign-out clears it, and clearing twice is fine", async () => {
		await saveOfflineSession({
			token: "token-a",
			session: sessionFor("token-a"),
		});

		await clearOfflineSession();
		await clearOfflineSession();
		expect(await loadOfflineSession("token-a")).toBeNull();
	});
});

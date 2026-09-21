import { describe, expect, mock, test } from "bun:test";
import { createAuthClient } from "better-auth/react";
import { createOfflineSession, type SessionAtom } from "./offline-session";

// Offline mode rests on how better-auth's own session atom treats failures.
// These run the real client so a better-auth upgrade that changes it fails here.

interface TestSession {
	user: { id: string };
	session: { token?: string | null; activeOrganizationId: string };
}

const liveSession: TestSession = {
	user: { id: "user-1" },
	session: { token: "token-a", activeOrganizationId: "org-live" },
};
const cachedSession: TestSession = {
	user: { id: "user-1" },
	session: { token: "token-a", activeOrganizationId: "org-cached" },
};

function setup() {
	let respond: () => Promise<Response> = async () => Response.json(liveSession);
	const client = createAuthClient({
		baseURL: "http://api.test",
		fetchOptions: { customFetchImpl: () => respond() },
	});
	const atom = client.$store.atoms.session as SessionAtom<TestSession>;
	const persistSession = mock(async () => {});
	const offline = createOfflineSession<TestSession>({
		sessionAtom: atom,
		getAuthToken: () => "token-a",
		loadCachedSession: async () => ({ session: cachedSession }),
		persistSession,
	});
	return {
		atom,
		offline,
		persistSession,
		refetch: () => atom.get().refetch(),
		serverDown: () => {
			respond = async () => {
				throw new TypeError("Failed to fetch");
			};
		},
		serverAnswers: (status: number, body: unknown) => {
			respond = async () => Response.json(body, { status });
		},
	};
}

describe("better-auth session atom", () => {
	test("keeps the session through a network failure and a 5xx", async () => {
		const { atom, refetch, serverDown, serverAnswers } = setup();
		await refetch();
		expect(atom.get().data).toEqual(liveSession);

		serverDown();
		await refetch();
		expect(atom.get().data).toEqual(liveSession);
		expect(atom.get().error).toBeTruthy();

		serverAnswers(530, { message: "origin unreachable" });
		await refetch();
		expect(atom.get().data).toEqual(liveSession);
	});

	test("drops the session on a 401", async () => {
		const { atom, refetch, serverAnswers } = setup();
		await refetch();

		serverAnswers(401, { message: "Unauthorized" });
		await refetch();
		expect(atom.get().data).toBeNull();
	});
});

describe("offline mode on the real client", () => {
	test("opens on the cached session, then hands over to the server", async () => {
		const { atom, offline, persistSession, refetch, serverDown } = setup();
		offline.startSync();
		serverDown();
		await refetch();

		expect(await offline.restoreIfUnreachable("token-a")).toBe(true);
		expect(atom.get().data).toEqual(cachedSession);

		await refetch();
		expect(atom.get().data).toEqual(cachedSession);
		expect(offline.isOffline()).toBe(true);
		expect(persistSession).not.toHaveBeenCalled();
	});

	test("leaves offline mode and caches the session once the server answers", async () => {
		const {
			atom,
			offline,
			persistSession,
			refetch,
			serverDown,
			serverAnswers,
		} = setup();
		offline.startSync();
		serverDown();
		await refetch();
		await offline.restoreIfUnreachable("token-a");

		serverAnswers(200, liveSession);
		await refetch();
		expect(atom.get().data).toEqual(liveSession);
		expect(offline.isOffline()).toBe(false);
		expect(persistSession).toHaveBeenCalledWith({
			token: "token-a",
			session: liveSession,
		});
	});

	test("a 401 while offline still signs you out", async () => {
		const { atom, offline, refetch, serverDown, serverAnswers } = setup();
		offline.startSync();
		serverDown();
		await refetch();
		await offline.restoreIfUnreachable("token-a");

		serverAnswers(401, { message: "Unauthorized" });
		await refetch();
		expect(atom.get().data).toBeNull();
		expect(offline.isOffline()).toBe(false);
	});
});

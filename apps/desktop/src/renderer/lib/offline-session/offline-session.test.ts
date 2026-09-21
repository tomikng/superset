import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	createOfflineSession,
	isServerUnreachableError,
	type SessionAtom,
	type SessionAtomState,
	SessionFetchTimeoutError,
} from "./offline-session";

interface TestSession {
	user: { id: string };
	session: { token?: string | null; activeOrganizationId: string };
}

function sessionFor(token: string, org = "org-1"): TestSession {
	return {
		user: { id: "user-1" },
		session: { token, activeOrganizationId: org },
	};
}

/** Just enough of a nanostores atom: get/set/listen, listeners on set. */
function createAtom(
	initial: Partial<SessionAtomState<TestSession>> = {},
): SessionAtom<TestSession> {
	let value: SessionAtomState<TestSession> = {
		data: null,
		error: null,
		isPending: true,
		isRefetching: false,
		refetch: async () => {},
		...initial,
	};
	const listeners = new Set<(next: SessionAtomState<TestSession>) => void>();
	return {
		get: () => value,
		set: (next) => {
			value = next;
			for (const listener of listeners) listener(value);
		},
		listen: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function setup({
	atom = createAtom(),
	token = "token-a",
	cached = sessionFor("token-a") as TestSession | null,
}: {
	atom?: SessionAtom<TestSession>;
	token?: string | null;
	cached?: TestSession | null;
} = {}) {
	let currentToken = token;
	const persistSession = mock(async () => {});
	const loadCachedSession = mock(async () =>
		cached ? { session: cached } : null,
	);
	const offline = createOfflineSession<TestSession>({
		sessionAtom: atom,
		getAuthToken: () => currentToken,
		loadCachedSession,
		persistSession,
	});
	return {
		atom,
		offline,
		persistSession,
		loadCachedSession,
		setToken: (next: string | null) => {
			currentToken = next;
		},
	};
}

const networkError = new TypeError("Failed to fetch");
const settled = { isPending: false, isRefetching: false };

describe("isServerUnreachableError", () => {
	test("treats thrown fetches, timeouts and 5xx as the server not answering", () => {
		expect(isServerUnreachableError(networkError)).toBe(true);
		expect(isServerUnreachableError(new SessionFetchTimeoutError())).toBe(true);
		expect(isServerUnreachableError({ status: 0 })).toBe(true);
		expect(isServerUnreachableError({ status: 408 })).toBe(true);
		expect(isServerUnreachableError({ status: 502 })).toBe(true);
		expect(isServerUnreachableError({ status: 530 })).toBe(true);
	});

	test("treats real answers as answers", () => {
		expect(isServerUnreachableError(null)).toBe(false);
		expect(isServerUnreachableError({ status: 401 })).toBe(false);
		expect(isServerUnreachableError({ status: 403 })).toBe(false);
		expect(isServerUnreachableError({ status: 429 })).toBe(false);
	});
});

describe("restoreIfUnreachable", () => {
	test("opens on the cached session when the server can't be reached", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, error: networkError }),
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(true);
		expect(atom.get().data).toEqual(sessionFor("token-a"));
		expect(atom.get().error).toBe(networkError);
		expect(atom.get().isPending).toBe(false);
		expect(offline.isOffline()).toBe(true);
	});

	test("opens on the cached session when the fetch never came back", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ isPending: true, isRefetching: true }),
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(true);
		expect(atom.get().error).toBeInstanceOf(SessionFetchTimeoutError);
		expect(atom.get().isRefetching).toBe(false);
	});

	test("respects a 401: a revoked session still signs you out", async () => {
		const { atom, offline, loadCachedSession } = setup({
			atom: createAtom({ ...settled, error: { status: 401 } }),
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		expect(atom.get().data).toBeNull();
		expect(loadCachedSession).not.toHaveBeenCalled();
		expect(offline.isOffline()).toBe(false);
	});

	test("respects the server saying there is no session", async () => {
		const { offline } = setup({ atom: createAtom({ ...settled }) });

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
	});

	test("leaves a live session alone", async () => {
		const live = sessionFor("token-a", "org-live");
		const { atom, offline, loadCachedSession } = setup({
			atom: createAtom({ ...settled, data: live }),
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		expect(atom.get().data).toBe(live);
		expect(loadCachedSession).not.toHaveBeenCalled();
	});

	test("does nothing without a cached session", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, error: networkError }),
			cached: null,
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		expect(atom.get().data).toBeNull();
	});

	test("yields to a server answer that lands while the cache loads", async () => {
		const atom = createAtom({ ...settled, error: networkError });
		const live = sessionFor("token-a", "org-live");
		const { offline, loadCachedSession } = setup({ atom });
		loadCachedSession.mockImplementationOnce(async () => {
			atom.set({ ...atom.get(), ...settled, data: live, error: null });
			return { session: sessionFor("token-a") };
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		expect(atom.get().data).toBe(live);
	});

	test("does not seed under a token that changed while the cache loaded", async () => {
		const atom = createAtom({ ...settled, error: networkError });
		const { offline, loadCachedSession, setToken } = setup({ atom });
		loadCachedSession.mockImplementationOnce(async () => {
			setToken("token-b");
			return { session: sessionFor("token-a") };
		});

		expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		expect(atom.get().data).toBeNull();
	});

	test("stays signed out when the cache can't be read", async () => {
		const { offline, loadCachedSession } = setup({
			atom: createAtom({ ...settled, error: networkError }),
		});
		loadCachedSession.mockImplementationOnce(async () => {
			throw new Error("ipc down");
		});
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(await offline.restoreIfUnreachable("token-a")).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});
});

describe("startSync", () => {
	test("caches each session the server confirms, once", async () => {
		const { atom, offline, persistSession } = setup();
		offline.startSync();

		atom.set({ ...atom.get(), ...settled, data: sessionFor("token-a") });
		atom.set({ ...atom.get(), ...settled, data: sessionFor("token-a") });
		expect(persistSession).toHaveBeenCalledTimes(1);
		expect(persistSession).toHaveBeenCalledWith({
			token: "token-a",
			session: sessionFor("token-a"),
		});

		atom.set({
			...atom.get(),
			...settled,
			data: sessionFor("token-a", "org-2"),
		});
		expect(persistSession).toHaveBeenCalledTimes(2);
	});

	test("never caches a session under another sign-in's token", () => {
		const { atom, offline, persistSession } = setup({ token: "token-b" });
		offline.startSync();

		atom.set({ ...atom.get(), ...settled, data: sessionFor("token-a") });
		expect(persistSession).not.toHaveBeenCalled();
	});

	test("does not re-cache the seeded copy", async () => {
		const { atom, offline, persistSession } = setup({
			atom: createAtom({ ...settled, error: networkError }),
		});
		offline.startSync();

		await offline.restoreIfUnreachable("token-a");
		expect(atom.get().data).toEqual(sessionFor("token-a"));
		expect(persistSession).not.toHaveBeenCalled();
	});

	test("goes offline when a refetch can't reach the server, and back when it can", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, data: sessionFor("token-a") }),
		});
		offline.startSync();
		const changes = mock(() => {});
		offline.subscribe(changes);

		// In flight: better-auth clears `error` during a refetch.
		atom.set({ ...atom.get(), isRefetching: true, error: null });
		expect(offline.isOffline()).toBe(false);
		atom.set({ ...atom.get(), ...settled, error: networkError });
		expect(offline.isOffline()).toBe(true);

		atom.set({ ...atom.get(), isRefetching: true, error: null });
		expect(offline.isOffline()).toBe(true);
		atom.set({ ...atom.get(), ...settled, error: { status: 403 } });
		expect(offline.isOffline()).toBe(true);

		atom.set({ ...atom.get(), ...settled, error: null });
		expect(offline.isOffline()).toBe(false);
		expect(changes).toHaveBeenCalledTimes(2);
	});

	test("leaves offline mode when the server signs you out", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, error: networkError }),
		});
		offline.startSync();
		await offline.restoreIfUnreachable("token-a");

		atom.set({ ...atom.get(), ...settled, data: null, error: { status: 401 } });
		expect(offline.isOffline()).toBe(false);
	});

	test("stops listening when unsubscribed", () => {
		const { atom, offline, persistSession } = setup();
		const stop = offline.startSync();
		stop();

		atom.set({ ...atom.get(), ...settled, data: sessionFor("token-a") });
		expect(persistSession).not.toHaveBeenCalled();
	});
});

describe("drop", () => {
	test("clears the cached session on an offline sign-out", async () => {
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, error: networkError }),
		});
		await offline.restoreIfUnreachable("token-a");

		offline.drop();
		expect(atom.get().data).toBeNull();
		expect(offline.isOffline()).toBe(false);
	});

	test("leaves a live session to the normal sign-out flow", () => {
		const live = sessionFor("token-a");
		const { atom, offline } = setup({
			atom: createAtom({ ...settled, data: live }),
		});

		offline.drop();
		expect(atom.get().data).toBe(live);
	});
});

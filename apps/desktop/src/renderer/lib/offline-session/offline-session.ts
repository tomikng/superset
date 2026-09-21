/**
 * SELF-HOSTED: offline mode. When the API can't be reached at launch, open on
 * the last session it confirmed instead of bouncing to sign-in.
 *
 * better-auth's session atom keeps its data through every non-401 failure, so
 * seeding it once reaches every `useSession()` reader, and the server's first
 * real answer — a session or a 401 — replaces it.
 */

interface CachedSessionShape {
	user: { id: string };
	session: { token?: string | null };
}

export interface SessionAtomState<Data extends CachedSessionShape> {
	data: Data | null;
	error: unknown;
	isPending: boolean;
	isRefetching: boolean;
	refetch: (...args: never[]) => Promise<unknown>;
}

/** The slice of better-auth's nanostores session atom this module touches. */
export interface SessionAtom<Data extends CachedSessionShape> {
	get(): SessionAtomState<Data>;
	set(value: SessionAtomState<Data>): void;
	listen(listener: (value: SessionAtomState<Data>) => void): () => void;
}

interface OfflineSessionDeps<Data extends CachedSessionShape> {
	sessionAtom: SessionAtom<Data>;
	getAuthToken: () => string | null;
	loadCachedSession: () => Promise<{ session: Data } | null>;
	persistSession: (input: { token: string; session: Data }) => Promise<unknown>;
}

export class SessionFetchTimeoutError extends Error {
	constructor() {
		super("The Superset server did not respond");
		this.name = "SessionFetchTimeoutError";
	}
}

/** 5xx included: a proxy in front of a dead origin answers 502/52x/530. */
export function isServerUnreachableError(error: unknown): boolean {
	if (!error) return false;
	const status = (error as { status?: unknown }).status;
	if (typeof status !== "number" || status === 0) return true;
	return status === 408 || status >= 500;
}

export function createOfflineSession<Data extends CachedSessionShape>(
	deps: OfflineSessionDeps<Data>,
) {
	const { sessionAtom } = deps;
	let offline = false;
	const listeners = new Set<() => void>();

	function setOffline(next: boolean) {
		if (offline === next) return;
		offline = next;
		for (const listener of listeners) listener();
	}

	function serverHasAnswered(state: SessionAtomState<Data>): boolean {
		if (state.data) return true;
		const settled = !state.isPending && !state.isRefetching;
		return settled && !isServerUnreachableError(state.error);
	}

	return {
		isOffline: () => offline,

		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		async restoreIfUnreachable(token: string): Promise<boolean> {
			if (serverHasAnswered(sessionAtom.get())) return false;

			let cached: { session: Data } | null;
			try {
				cached = await deps.loadCachedSession();
			} catch (error) {
				console.warn(
					"[offline-session] failed to load the cached session",
					error,
				);
				return false;
			}
			if (!cached || deps.getAuthToken() !== token) return false;

			// The server may have answered while the cache was loading.
			const current = sessionAtom.get();
			if (serverHasAnswered(current)) return false;

			sessionAtom.set({
				...current,
				data: cached.session,
				error: current.error ?? new SessionFetchTimeoutError(),
				isPending: false,
				isRefetching: false,
			});
			setOffline(true);
			return true;
		},

		/** Without this, signing out offline leaves the cached session showing. */
		drop(): void {
			if (!offline) return;
			sessionAtom.set({
				...sessionAtom.get(),
				data: null,
				error: null,
				isPending: false,
				isRefetching: false,
			});
			setOffline(false);
		},

		retry(): void {
			void sessionAtom
				.get()
				.refetch()
				.catch((error: unknown) => {
					console.warn("[offline-session] session retry failed", error);
				});
		},

		startSync(): () => void {
			let lastPersisted: string | null = null;
			return sessionAtom.listen((value) => {
				// In flight: better-auth clears `error` while a refetch runs, which
				// says nothing about whether the server is back.
				if (value.isPending || value.isRefetching) return;
				if (!value.data) {
					setOffline(false);
					return;
				}
				if (value.error) {
					if (isServerUnreachableError(value.error)) setOffline(true);
					return;
				}

				setOffline(false);
				const token = deps.getAuthToken();
				// Mid token swap the atom can still hold the previous sign-in.
				if (!token || value.data.session.token !== token) return;
				const serialized = JSON.stringify(value.data);
				if (serialized === lastPersisted) return;
				lastPersisted = serialized;
				deps
					.persistSession({ token, session: value.data })
					.catch((error: unknown) => {
						lastPersisted = null;
						console.warn(
							"[offline-session] failed to cache the session",
							error,
						);
					});
			});
		},
	};
}

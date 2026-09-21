import { useEffect, useRef, useSyncExternalStore } from "react";
import {
	authClient,
	ensureFreshJwt,
	getAuthToken,
} from "renderer/lib/auth-client";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { createOfflineSession, type SessionAtom } from "./offline-session";

type SessionData = NonNullable<
	ReturnType<typeof authClient.useSession>["data"]
>;

const OFFLINE_RETRY_INTERVAL_MS = 30_000;

function getSessionAtom(): SessionAtom<SessionData> {
	return authClient.$store.atoms.session as SessionAtom<SessionData>;
}

// Resolved per call, never at import: test files mock `auth-client` with a
// stub that has no `$store`, and bun's module mocks leak into later files.
const sessionAtom: SessionAtom<SessionData> = {
	get: () => getSessionAtom().get(),
	set: (value) => getSessionAtom().set(value),
	listen: (listener) => getSessionAtom().listen(listener),
};

export const offlineSession = createOfflineSession<SessionData>({
	sessionAtom,
	getAuthToken,
	loadCachedSession: async () => {
		const cached = await electronTrpcClient.auth.getOfflineSession.query();
		return cached
			? { session: cached.session as unknown as SessionData }
			: null;
	},
	persistSession: (input) =>
		electronTrpcClient.auth.persistOfflineSession.mutate(input),
});

export function useIsOfflineMode(): boolean {
	return useSyncExternalStore(
		offlineSession.subscribe,
		offlineSession.isOffline,
		() => false,
	);
}

/** Mount once, at the root. */
export function useOfflineSessionSync(): void {
	useEffect(() => offlineSession.startSync(), []);

	const isOffline = useIsOfflineMode();
	const wasOfflineRef = useRef(isOffline);
	useEffect(() => {
		if (!isOffline) {
			if (wasOfflineRef.current) void ensureFreshJwt();
			wasOfflineRef.current = false;
			return;
		}
		wasOfflineRef.current = true;
		const interval = window.setInterval(
			() => offlineSession.retry(),
			OFFLINE_RETRY_INTERVAL_MS,
		);
		return () => window.clearInterval(interval);
	}, [isOffline]);
}

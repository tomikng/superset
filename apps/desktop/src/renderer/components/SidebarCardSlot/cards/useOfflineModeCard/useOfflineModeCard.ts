import { offlineSession, useIsOfflineMode } from "renderer/lib/offline-session";
import type { SidebarCardEntry } from "../../types";

/** SELF-HOSTED: offline mode (renderer/lib/offline-session). */
export function useOfflineModeCard(): SidebarCardEntry | null {
	const isOfflineMode = useIsOfflineMode();
	if (!isOfflineMode) return null;

	return {
		id: "offline-mode",
		badge: "Offline",
		title: "Can't reach the Superset server",
		description:
			"Local workspaces, terminals and agents keep working. Cloud features come back when the server does.",
		actionLabel: "Retry now",
		onAction: () => offlineSession.retry(),
		className: "border-warning/50",
	};
}

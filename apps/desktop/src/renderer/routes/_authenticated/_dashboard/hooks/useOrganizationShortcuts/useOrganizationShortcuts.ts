import { useCallback } from "react";
import { useHotkey } from "renderer/hotkeys";
import { cloudTrpc } from "renderer/lib/cloud-trpc";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

/** Wrap `index` into `[0, length)` so cycling passes both ends. */
export function wrapIndex(index: number, length: number): number {
	return ((index % length) + length) % length;
}

/**
 * Cycle the window's active organization with the prev/next hotkeys, in the
 * same order the top bar's switcher lists them. Mount once — the dropdown
 * renders in both the top bar and the sidebar, so registering there would
 * step twice per press.
 */
export function useOrganizationShortcuts(): void {
	const { activeOrganizationId, switchOrganization } = useCollections();
	const { data: organizations } =
		cloudTrpc.organization.list.useQuery(undefined);

	const step = useCallback(
		(delta: number) => {
			if (!organizations || organizations.length < 2) return;
			const current = organizations.findIndex(
				(organization) => organization.id === activeOrganizationId,
			);
			if (current === -1) return;
			const next =
				organizations[wrapIndex(current + delta, organizations.length)];
			if (next) void switchOrganization(next.id);
		},
		[organizations, activeOrganizationId, switchOrganization],
	);

	useHotkey("PREV_ORGANIZATION", () => step(-1));
	useHotkey("NEXT_ORGANIZATION", () => step(1));
}

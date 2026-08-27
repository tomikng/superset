import crypto from "node:crypto";
import { AUTH_PROVIDERS } from "@superset/shared/constants";
import { getHostId, getHostName } from "@superset/shared/host-info";
import { observable } from "@trpc/server/observable";
import { shell } from "electron";
import { env } from "main/env.main";
import { getHostServiceCoordinator } from "main/lib/host-service-coordinator";
import { PLATFORM, PROTOCOL_SCHEME } from "shared/constants";
import { env as sharedEnv } from "shared/env.shared";
import { z } from "zod";
import { publicProcedure, router } from "../..";
import {
	authEvents,
	clearToken,
	loadToken,
	saveOrganizationIds,
	saveToken,
	stateStore,
} from "./utils/auth-functions";

const PASSWORD_TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

export const createAuthRouter = () => {
	return router({
		getStoredToken: publicProcedure.query(() => loadToken()),

		getDeviceInfo: publicProcedure.query(() => ({
			deviceId: getHostId(),
			deviceName: getHostName(),
		})),

		persistToken: publicProcedure
			.input(
				z.object({
					token: z.string(),
					expiresAt: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				await saveToken(input);
				return { success: true };
			}),

		persistOrganizationIds: publicProcedure
			.input(
				z.object({
					token: z.string(),
					organizationIds: z.array(z.string()),
					expectedRevision: z.number().int().nonnegative(),
				}),
			)
			.mutation(async ({ input }) => {
				return await saveOrganizationIds(input);
			}),

		/**
		 * Subscribe to auth events. Only fires for actual changes:
		 * - New authentication (OAuth callback) -> { token, expiresAt }
		 * - Sign out -> null
		 *
		 * Does NOT emit on subscribe - use getStoredToken for initial hydration.
		 */
		onTokenChanged: publicProcedure.subscription(() => {
			return observable<{ token: string; expiresAt: string } | null>((emit) => {
				const handleSaved = (data: { token: string; expiresAt: string }) => {
					emit.next(data);
				};

				const handleCleared = () => {
					emit.next(null);
				};

				authEvents.on("token-saved", handleSaved);
				authEvents.on("token-cleared", handleCleared);

				return () => {
					authEvents.off("token-saved", handleSaved);
					authEvents.off("token-cleared", handleCleared);
				};
			});
		}),

		/**
		 * Start OAuth sign-in flow.
		 * Opens browser for OAuth, token delivered via deep link on macOS
		 * or localhost callback on Linux (where deep links are unreliable).
		 */
		signIn: publicProcedure
			.input(z.object({ provider: z.enum(AUTH_PROVIDERS) }))
			.mutation(async ({ input }) => {
				try {
					const state = crypto.randomBytes(32).toString("base64url");
					stateStore.set(state, Date.now());

					// Clean up expired states (10 minutes)
					const cutoff = Date.now() - 10 * 60 * 1000;
					for (const [s, ts] of stateStore) {
						if (ts < cutoff) stateStore.delete(s);
					}

					const connectUrl = new URL(
						`${env.NEXT_PUBLIC_API_URL}/api/auth/desktop/connect`,
					);
					connectUrl.searchParams.set("provider", input.provider);
					connectUrl.searchParams.set("state", state);
					connectUrl.searchParams.set("protocol", PROTOCOL_SCHEME);
					// Only send local_callback on Linux where deep links are unreliable
					if (PLATFORM.IS_LINUX) {
						connectUrl.searchParams.set(
							"local_callback",
							`http://127.0.0.1:${sharedEnv.DESKTOP_NOTIFICATIONS_PORT}/auth/callback`,
						);
					}
					await shell.openExternal(connectUrl.toString());
					return { success: true };
				} catch (err) {
					return {
						success: false,
						error:
							err instanceof Error ? err.message : "Failed to open browser",
					};
				}
			}),

		/**
		 * SELF-HOSTED: credential sign-in, performed from the main process.
		 *
		 * The packaged renderer is served from file://, so a browser fetch to
		 * the API carries `Origin: null` plus Sec-Fetch-* headers and Better
		 * Auth's CSRF middleware rejects it ("Missing or null Origin"). A Node
		 * fetch sends neither, which Better Auth treats as a non-browser client
		 * and validates on credentials alone. The token is persisted here so the
		 * renderer only has to hydrate it.
		 */
		signInWithPassword: publicProcedure
			.input(z.object({ email: z.string(), password: z.string() }))
			.mutation(async ({ input }) => {
				const response = await fetch(
					`${env.NEXT_PUBLIC_API_URL}/api/auth/sign-in/email`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							email: input.email.trim(),
							password: input.password,
						}),
					},
				);
				const data = (await response.json().catch(() => ({}))) as {
					token?: string;
					code?: string;
					message?: string;
				};

				if (!response.ok) {
					// Never distinguish "no such account" from "wrong password" —
					// on a closed instance that difference tells an outsider whether
					// an address is on the allow-list.
					return {
						success: false as const,
						error:
							data.code === "INVALID_EMAIL_OR_PASSWORD"
								? "Incorrect email or password."
								: (data.message ?? `Sign-in failed (${response.status})`),
					};
				}
				if (!data.token) {
					return {
						success: false as const,
						error: "Sign-in did not return a token",
					};
				}

				const expiresAt = new Date(
					Date.now() + PASSWORD_TOKEN_LIFETIME_MS,
				).toISOString();
				await saveToken({ token: data.token, expiresAt });
				return { success: true as const, token: data.token, expiresAt };
			}),

		signOut: publicProcedure.mutation(async () => {
			getHostServiceCoordinator().stopAll();
			await clearToken();
			return { success: true };
		}),
	});
};

export type AuthRouter = ReturnType<typeof createAuthRouter>;

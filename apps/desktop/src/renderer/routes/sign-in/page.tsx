/**
 * SELF-HOSTED: credential sign-in only.
 *
 * Upstream offered GitHub, Google, and a hardcoded dev-account button. This
 * instance is invitation-only — accounts exist only because an operator ran
 * `db:seed-teams` — so the page is a plain email/password form. The token
 * exchange below is the same one the dev button used: POST the credentials,
 * persist the returned token, navigate.
 */
import { COMPANY } from "@superset/shared/constants";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { Spinner } from "@superset/ui/spinner";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Redirect } from "renderer/components/Redirect";
import { env } from "renderer/env.renderer";
import { useDelayElapsed } from "renderer/hooks/useDelayElapsed";
import { track } from "renderer/lib/analytics";
import { setAuthToken } from "renderer/lib/auth-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { SupersetLogo } from "./components/SupersetLogo";
import { useSessionRecovery } from "./hooks/useSessionRecovery";

export const Route = createFileRoute("/sign-in/")({
	component: SignInPage,
});

const workspaceRedirect = <Redirect to="/workspace" replace />;

const SESSION_PENDING_TIMEOUT_MS = 15_000;

const TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24 * 30;

function SignInPage() {
	const persistToken = electronTrpc.auth.persistToken.useMutation();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { hasLocalToken, isPending, session } = useSessionRecovery();
	// A session fetch that never settles must not trap the user on a spinner —
	// fall through to the form after a while (#5729).
	const pendingTimedOut = useDelayElapsed(
		isPending,
		SESSION_PENDING_TIMEOUT_MS,
	);

	// Dev bypass: skip sign-in entirely
	if (env.SKIP_ENV_VALIDATION) {
		return workspaceRedirect;
	}

	// Show loading while session is being fetched
	if (isPending && !pendingTimedOut) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-background">
				<Spinner className="size-8" />
			</div>
		);
	}

	// If already signed in, redirect to workspace
	if (session?.user) {
		return workspaceRedirect;
	}

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isSubmitting) return;

		setIsSubmitting(true);
		setError(null);
		track("auth_started", { provider: "password" });

		try {
			const response = await fetch(
				`${env.NEXT_PUBLIC_API_URL}/api/auth/sign-in/email`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					credentials: "omit",
					body: JSON.stringify({
						email: email.trim(),
						password,
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
				throw new Error(
					data.code === "INVALID_EMAIL_OR_PASSWORD"
						? "Incorrect email or password."
						: (data.message ?? `Sign-in failed (${response.status})`),
				);
			}

			const token = data.token;
			if (!token) throw new Error("Sign-in did not return a token");

			const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString();
			await persistToken.mutateAsync({ token, expiresAt });
			setAuthToken(token);
			await navigate({ to: "/workspace", replace: true });
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : "Sign-in failed",
			);
			setIsSubmitting(false);
		}
	};

	return (
		<div className="flex flex-col h-full w-full bg-background">
			<div className="h-12 w-full drag shrink-0" />

			<div className="flex flex-1 items-center justify-center">
				<div className="flex flex-col items-center w-full max-w-md px-8">
					<div className="mb-8">
						<SupersetLogo className="h-12 w-auto" />
					</div>

					<div className="text-center mb-8">
						<h1 className="text-xl font-semibold text-foreground mb-2">
							Sign in to Superset
						</h1>
						<p className="text-sm text-muted-foreground">
							{hasLocalToken
								? "Restoring your session"
								: "Use the credentials your administrator issued"}
						</p>
					</div>

					<form
						onSubmit={handleSubmit}
						className="flex flex-col gap-4 w-full max-w-xs"
					>
						<div className="flex flex-col gap-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								autoComplete="username"
								required
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								disabled={isSubmitting}
							/>
						</div>

						<div className="flex flex-col gap-2">
							<Label htmlFor="password">Password</Label>
							<Input
								id="password"
								type="password"
								autoComplete="current-password"
								required
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								disabled={isSubmitting}
							/>
						</div>

						{error && (
							<p className="text-xs text-destructive text-center select-text cursor-text">
								{error}
							</p>
						)}

						<Button
							type="submit"
							size="lg"
							className="w-full"
							disabled={isSubmitting}
						>
							{isSubmitting ? "Signing in..." : "Sign in"}
						</Button>
					</form>

					<p className="mt-8 text-xs text-muted-foreground/70 text-center max-w-xs">
						By signing in, you agree to our{" "}
						<a
							href={COMPANY.TERMS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-muted-foreground transition-colors"
						>
							Terms of Service
						</a>{" "}
						and{" "}
						<a
							href={COMPANY.PRIVACY_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="underline hover:text-muted-foreground transition-colors"
						>
							Privacy Policy
						</a>
					</p>
				</div>
			</div>
		</div>
	);
}

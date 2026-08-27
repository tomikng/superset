"use client";

/**
 * SELF-HOSTED: credential sign-in only.
 *
 * This page is also where the CLI's OAuth flow lands — better-auth's
 * oauthProvider is configured with `loginPage: ${NEXT_PUBLIC_WEB_URL}/sign-in`
 * — so `superset auth login` depends on this form working.
 *
 * Upstream offered GitHub, Google, and a hardcoded dev button. This instance
 * is invitation-only: accounts exist only because an operator ran
 * `db:seed-teams`, and there is no self-service sign-up to link to.
 */

import { authClient } from "@superset/auth/client";
import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { env } from "@/env";

export default function SignInPage() {
	const searchParams = useSearchParams();
	const redirect = searchParams.get("redirect");
	const callbackURL = redirect
		? `${env.NEXT_PUBLIC_WEB_URL}${redirect}`
		: env.NEXT_PUBLIC_WEB_URL;

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (isLoading) return;

		setIsLoading(true);
		setError(null);

		try {
			const result = await authClient.signIn.email({
				email: email.trim(),
				password,
			});

			if (result.error) {
				// Never distinguish "no such account" from "wrong password" — on a
				// closed instance that difference reveals who is on the allow-list.
				throw new Error(
					result.error.code === "INVALID_EMAIL_OR_PASSWORD"
						? "Incorrect email or password."
						: (result.error.message ?? "Sign-in failed."),
				);
			}

			window.location.href = callbackURL;
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Sign-in failed.");
			setIsLoading(false);
		}
	};

	return (
		<div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[350px]">
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
				<p className="text-muted-foreground text-sm">
					Sign in to continue to Superset
				</p>
			</div>
			<form onSubmit={handleSubmit} className="grid gap-4">
				{error && (
					<p className="text-destructive text-center text-sm">{error}</p>
				)}
				<div className="grid gap-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						type="email"
						autoComplete="username"
						required
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						disabled={isLoading}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						type="password"
						autoComplete="current-password"
						required
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						disabled={isLoading}
					/>
				</div>
				<Button type="submit" disabled={isLoading} className="w-full">
					{isLoading ? "Signing in..." : "Sign in"}
				</Button>
				<p className="text-muted-foreground px-8 text-center text-sm">
					Accounts on this instance are created by an administrator. If you
					need access, ask them to add you.
				</p>
				<p className="text-muted-foreground px-8 text-center text-sm">
					By continuing, you agree to our{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/terms`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Terms of Service
					</a>{" "}
					and{" "}
					<a
						href={`${env.NEXT_PUBLIC_MARKETING_URL}/privacy`}
						target="_blank"
						rel="noopener noreferrer"
						className="hover:text-primary underline underline-offset-4"
					>
						Privacy Policy
					</a>
					.
				</p>
			</form>
		</div>
	);
}

import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { signIn } from "@/lib/auth/client";
import { env } from "@/lib/env";

import { DevSignInOptions } from "./components/DevSignInOptions";

/**
 * Self-host sign-in. The deployment is invitation-only with password accounts
 * (see packages/auth/src/server.ts — no social providers, sign-up disabled),
 * so this is a plain credential form; the OAuth / Apple buttons that upstream
 * shows would all fail against this server.
 */
export function SignInScreen() {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const canSubmit = email.trim().length > 0 && password.length > 0;

	const handleSubmit = async () => {
		if (!canSubmit || isLoading) return;
		setError(null);
		setIsLoading(true);
		try {
			const res = await signIn.email({ email: email.trim(), password });
			if (res.error) throw new Error(res.error.message);
		} catch (err) {
			console.error("[sign-in] Error:", err);
			setError(err instanceof Error ? err.message : "Something went wrong");
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<KeyboardAvoidingView
			behavior={Platform.OS === "ios" ? "padding" : undefined}
			className="flex-1 items-center justify-center gap-8 bg-background p-6"
		>
			<Image
				source={require("@/assets/icon.png")}
				style={{ width: 80, height: 80, borderRadius: 16 }}
			/>

			<View className="items-center gap-2">
				<Text className="text-2xl font-semibold text-foreground">
					<Trans id="mobile.signIn.title">Welcome to Superset</Trans>
				</Text>
				<Text className="text-base text-muted-foreground">
					{new URL(env.EXPO_PUBLIC_API_URL).host}
				</Text>
			</View>

			<View className="w-4/5 gap-3">
				<Input
					value={email}
					onChangeText={setEmail}
					placeholder="Email"
					autoCapitalize="none"
					autoCorrect={false}
					autoComplete="email"
					keyboardType="email-address"
					textContentType="username"
					returnKeyType="next"
					editable={!isLoading}
					testID="sign-in-email"
				/>
				<Input
					value={password}
					onChangeText={setPassword}
					placeholder="Password"
					secureTextEntry
					autoCapitalize="none"
					autoCorrect={false}
					autoComplete="password"
					textContentType="password"
					returnKeyType="go"
					onSubmitEditing={() => void handleSubmit()}
					editable={!isLoading}
					testID="sign-in-password"
				/>
				<Button
					onPress={() => void handleSubmit()}
					disabled={!canSubmit || isLoading}
					size="lg"
					className="w-full"
					testID="sign-in-submit"
				>
					<Text>{isLoading ? "Signing in..." : "Sign in"}</Text>
				</Button>
				{(__DEV__ || env.EXPO_PUBLIC_E2E === "1") && <DevSignInOptions />}
			</View>

			{error && (
				<Text className="text-center text-sm text-destructive">{error}</Text>
			)}
		</KeyboardAvoidingView>
	);
}

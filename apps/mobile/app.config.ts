import path from "node:path";
import { config } from "dotenv";
import type { ConfigContext } from "expo/config";
import { withIosAccentColor } from "./config-plugins/withIosAccentColor";

// Load .env file
config({
	path: path.resolve(__dirname, "../../.env"),
	override: true,
	quiet: true,
});
// Self-host settings: public URLs, bundle id, Apple team. The file is
// gitignored (copy selfhost.env.example); CI passes the same names as
// repository secrets. Never overrides the shell or the root .env.
config({
	path: path.resolve(__dirname, "selfhost.env"),
	override: false,
	quiet: true,
});

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`${name} is not set — copy apps/mobile/selfhost.env.example to selfhost.env and fill it in`,
		);
	}
	return value;
}

// Bundle identifier (iOS) / package name (Android) and the Apple team that
// signs it. Upstream's `sh.superset.mobile` belongs to Superset's own team; a
// personal build needs an App ID this team can sign for.
const MOBILE_APP_ID = required("MOBILE_APP_ID");
const APPLE_TEAM_ID = required("APPLE_TEAM_ID");

// Sentry's config plugin adds an Xcode phase that uploads source maps and
// needs an auth token; without one the phase only logs a warning, but there is
// no Sentry project on the self-host, so leave the plugin out entirely.
const sentryPlugin = process.env.SENTRY_AUTH_TOKEN
	? [
			[
				"@sentry/react-native/expo",
				{
					organization: "superset-sh",
					project: "mobile",
				},
			],
		]
	: [];

export default ({ config }: ConfigContext) => ({
	...config,
	name: "Superset",
	slug: "superset",
	version: "1.0.0",
	orientation: "portrait",
	icon: "./assets/icon.png",
	userInterfaceStyle: "dark",
	scheme: "superset",
	// Over-the-air JS updates (EAS Update). The binary carries this URL and
	// channel; `apps/mobile/scripts/ota.sh` publishes to it. The fingerprint
	// policy hashes the native side, so a binary only accepts updates built
	// from the same native dependencies — an upstream merge that changes a
	// native module needs a TestFlight build, and this makes that automatic.
	updates: {
		url: "https://u.expo.dev/f501cafd-9f75-4f43-99fc-611cce656403",
		requestHeaders: { "expo-channel-name": "selfhost" },
		checkAutomatically: "ON_LOAD" as const,
		fallbackToCacheTimeout: 0,
	},
	runtimeVersion: { policy: "fingerprint" as const },
	splash: {
		image: "./assets/splash-icon.png",
		resizeMode: "contain" as const,
		backgroundColor: "#09090b",
	},
	ios: {
		supportsTablet: false,
		// Apple sign-in is off — the self-host only has password accounts.
		bundleIdentifier: MOBILE_APP_ID,
		appleTeamId: APPLE_TEAM_ID,
		// TestFlight needs a unique, increasing build number per upload.
		// scripts/testflight.sh sets a timestamp; local runs default to 1.
		buildNumber: process.env.MOBILE_BUILD_NUMBER ?? "1",
		infoPlist: {
			ITSAppUsesNonExemptEncryption: false,
			// Dictation is native now (`modules/composer`), so no config plugin
			// contributes this any more — `expo-speech-recognition` used to, and
			// went with `GlassComposer`. Without it `SFSpeechRecognizer`'s
			// authorization request terminates the app.
			NSSpeechRecognitionUsageDescription:
				"Superset uses speech recognition to turn your voice into text.",
		},
	},
	android: {
		adaptiveIcon: {
			foregroundImage: "./assets/adaptive-icon.png",
			backgroundColor: "#ffffff",
		},
		package: MOBILE_APP_ID,
		predictiveBackGestureEnabled: false,
	},
	web: {
		favicon: "./assets/favicon.png",
		bundler: "metro",
	},
	plugins: [
		[withIosAccentColor, { color: "#FFFFFF" }],
		"expo-router",
		...sentryPlugin,
		"expo-localization",
		[
			"expo-image-picker",
			{
				photosPermission:
					"Superset needs access to your photo library so you can attach images to chat messages.",
				cameraPermission:
					"Superset uses the camera so you can attach photos to chat messages.",
				microphonePermission:
					"Superset uses the microphone so you can dictate chat messages.",
			},
		],
		"expo-document-picker",
		// The composer is built on Liquid Glass, which silently no-ops before
		// iOS 26 — an iOS 26 floor means one visual language instead of a glass
		// path plus a solid fallback. See plans/20260821-native-composer.md.
		[
			"expo-build-properties",
			{
				ios: { deploymentTarget: "26.0" },
			},
		],
		// SDK 57 no longer autolinks config plugins; every installed plugin has
		// to be listed or its native setup is silently skipped.
		"expo-asset",
		"expo-font",
		"expo-image",
		"expo-secure-store",
		"expo-status-bar",
		"expo-updates",
		"expo-web-browser",
	],
	extra: {
		router: {},
		eas: {
			projectId: "f501cafd-9f75-4f43-99fc-611cce656403",
		},
	},
	owner: "tomikng",
});

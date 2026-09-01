import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		RELAY_PORT: z.coerce.number().int().positive().default(8080),
		// Must match the API's JWT issuer/audience exactly — a mismatch 401s
		// every connection.
		NEXT_PUBLIC_API_URL: z.url(),
		// Reported by /health and /_whoowns. The name is a Fly leftover kept so
		// existing deploy configs (launchd plist, fly.toml) need no change.
		FLY_REGION: z.string().default("local"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

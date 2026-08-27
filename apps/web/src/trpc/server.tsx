import "server-only";

import type { AppRouter } from "@superset/trpc";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { headers } from "next/headers";
import { cache } from "react";
import SuperJSON from "superjson";

import { env } from "../env";

export const api = cache(async () => {
	const heads = new Headers(await headers());
	// Hop-by-hop and origin-bound headers must not be replayed to the API. Bun's fetch
	// (unlike Node's) honours a caller-set Host, which would route the request to
	// whatever the inbound host resolves to (the web app itself behind a tunnel).
	for (const name of ["host", "connection", "content-length", "transfer-encoding"]) {
		heads.delete(name);
	}
	heads.set("x-trpc-source", "rsc");

	return createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				transformer: SuperJSON,
				url: `${env.NEXT_PUBLIC_API_URL}/api/trpc`,
				headers() {
					return Object.fromEntries(heads.entries());
				},
			}),
		],
	});
});

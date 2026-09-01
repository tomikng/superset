// Imported first by every test file so modules that read env at load time
// (env.ts via access.ts / api-client.ts) see a complete dummy environment.
// Nothing here reaches the network: the tests stub auth and access.
process.env.SKIP_ENV_VALIDATION = "1";
process.env.NEXT_PUBLIC_API_URL ??= "http://127.0.0.1:1";

// @hono/node-server swaps globalThis.Response for a lightweight class when it
// loads; Bun.serve only accepts the native one, so the fake host-service in
// the tests builds its replies from this reference captured beforehand.
export const NativeResponse = globalThis.Response;

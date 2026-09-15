import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	SANDBOX_PATHS,
	sandboxManagedEnvSchema,
} from "@superset/shared/sandbox-contract";
import { TRPCError } from "@trpc/server";
import {
	hasManagedEnv,
	setManagedEnv,
} from "../../../runtime/sandbox-managed-env/sandbox-managed-env.ts";
import {
	readSandboxIdentity,
	runSandboxStartHook,
} from "../../../runtime/sandbox-self-seed";
import { protectedProcedure, router } from "../../index";

const BOOT_LOG_TAIL_LINES = 200;

function sandboxOnly(): void {
	if (process.env.SUPERSET_HOST_RUN_MODE !== "sandbox") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Only a cloud workspace sandbox has a managed environment",
		});
	}
}

function readTrimmed(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

/** What the boot log and the runtime pointer say about this box. */
export function readSandboxBootStatus(): {
	bundle: string | null;
	runtime: string | null;
	bootLog: string[];
	ready: Record<string, boolean>;
	/** Whether the control plane has pushed the managed environment this process. */
	environmentPushed: boolean;
} {
	const log = readTrimmed(SANDBOX_PATHS.bootLog);
	return {
		environmentPushed: hasManagedEnv(),
		bundle: readTrimmed(`${SANDBOX_PATHS.bundleRoot}/current.bundle-hash`),
		runtime: readTrimmed(`${SANDBOX_PATHS.hostRoot}/current.version`),
		bootLog: log ? log.split("\n").slice(-BOOT_LOG_TAIL_LINES) : [],
		ready: Object.fromEntries(
			["host-service", "display", "checkout"].map((flag) => [
				flag,
				existsSync(join(SANDBOX_PATHS.run, `${flag}.ready`)),
			]),
		),
	};
}

export const sandboxRouter = router({
	/**
	 * Replaces the managed environment. The control plane calls it after
	 * every boot with the full set (claim and wake) and with an empty set on
	 * release; the agent launched at boot waits for the first call.
	 */
	setEnvironment: protectedProcedure
		.input(sandboxManagedEnvSchema)
		.mutation(({ input }) => {
			sandboxOnly();
			setManagedEnv(input.variables);
			return { count: Object.keys(input.variables).length };
		}),

	status: protectedProcedure.query(() => {
		sandboxOnly();
		return readSandboxBootStatus();
	}),

	/**
	 * Runs the repository's `start` hook with the managed environment. The
	 * boot runner calls it once host-service answers, the environment has
	 * been pushed and the checkout is in, so every boot-time action is
	 * sequenced from one place and reads in one log.
	 */
	runStartHook: protectedProcedure.mutation(() => {
		sandboxOnly();
		const identity = readSandboxIdentity();
		if (!identity) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "This host-service has no sandbox identity",
			});
		}
		return runSandboxStartHook(identity);
	}),
});

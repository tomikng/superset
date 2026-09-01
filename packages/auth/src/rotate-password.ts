/**
 * Rotates the credential password for one seeded account.
 *
 *   ROTATE_EMAIL=someone@example.com bun run db:rotate-password
 *
 * Generates a new password, hashes it with better-auth's own hasher (so the
 * stored format matches exactly what sign-in verifies against), updates the
 * `credential` account row, and writes the plaintext ONCE to a 0600 file.
 *
 * It never prints the password to stdout: this is normally run by an agent or
 * from CI, and stdout ends up in transcripts and log files.
 *
 * Adding a brand-new person is still db:seed-teams — this only replaces the
 * password of an account that already exists.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "@superset/db/client";
import { accounts, users } from "@superset/db/schema";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { env } from "./env";

const CREDENTIAL_PROVIDER = "credential";
const OUT_FILE = join(homedir(), "superset-credentials.txt");

function generatePassword(): string {
	// 24 url-safe characters — no ambiguity about shell quoting or charset rules.
	return randomBytes(18).toString("base64url");
}

async function main(): Promise<void> {
	const email = process.env.ROTATE_EMAIL;
	if (!email) {
		throw new Error("set ROTATE_EMAIL to the account you want to rotate");
	}

	const user = await db.query.users.findFirst({
		where: eq(users.email, email),
	});
	if (!user) {
		throw new Error(
			`no account for ${email} — create it with db:seed-teams first`,
		);
	}

	const account = await db.query.accounts.findFirst({
		where: and(
			eq(accounts.userId, user.id),
			eq(accounts.providerId, CREDENTIAL_PROVIDER),
		),
	});
	if (!account) {
		throw new Error(
			`${email} has no credential account — it may be an OAuth-only user`,
		);
	}

	const password = process.env.ROTATE_PASSWORD ?? generatePassword();
	const hash = await hashPassword(password);

	// Confirm the hash verifies before writing it, so a hasher change upstream
	// can never lock the account out silently.
	if (!(await verifyPassword({ hash, password }))) {
		throw new Error("generated hash failed self-verification — aborting");
	}

	await db
		.update(accounts)
		.set({ password: hash, updatedAt: new Date() })
		.where(eq(accounts.id, account.id));

	const stamp = new Date().toISOString();
	writeFileSync(
		OUT_FILE,
		`Superset self-host credentials\n` +
			`rotated: ${stamp}\n\n` +
			`url:      ${env.NEXT_PUBLIC_WEB_URL}\n` +
			`email:    ${email}\n` +
			`password: ${password}\n`,
		{ mode: 0o600 },
	);
	chmodSync(OUT_FILE, 0o600);

	console.log(`Rotated the password for ${email}.`);
	console.log(
		`Written to ${OUT_FILE} (mode 600). Not printed here on purpose.`,
	);
	console.log("Existing sessions stay valid; sign-in now needs the new one.");
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("rotate-password failed:", error.message ?? error);
		process.exit(1);
	});

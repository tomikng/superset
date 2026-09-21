/**
 * SELF-HOSTED: offline mode. The last session the API confirmed, for opening
 * the app while it is unreachable (renderer/lib/offline-session).
 *
 * Not stored in `auth-token.enc`: every write there rebuilds the record field
 * by field and would silently drop it. superjson, because better-auth revives
 * ISO strings into Dates and a cached session must look like a live one.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	SUPERSET_HOME_DIR,
	SUPERSET_HOME_DIR_MODE,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "main/lib/app-environment";
import superjson from "superjson";
import { decrypt, encrypt } from "./crypto-storage";

const OFFLINE_SESSION_FILE_NAME = "offline-session.enc";

export interface OfflineSessionPayload {
	user: { id: string } & Record<string, unknown>;
	session: Record<string, unknown>;
	[key: string]: unknown;
}

export interface LoadedOfflineSession {
	session: OfflineSessionPayload;
	savedAt: string;
}

interface StoredOfflineSession extends LoadedOfflineSession {
	tokenHash: string;
}

function getOfflineSessionFile(): string {
	return join(
		process.env.SUPERSET_HOME_DIR || SUPERSET_HOME_DIR,
		OFFLINE_SESSION_FILE_NAME,
	);
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function isStoredOfflineSession(value: unknown): value is StoredOfflineSession {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	const session = candidate.session as Record<string, unknown> | undefined;
	const user = session?.user as Record<string, unknown> | undefined;
	return (
		typeof candidate.tokenHash === "string" &&
		typeof candidate.savedAt === "string" &&
		typeof user?.id === "string" &&
		!!session?.session &&
		typeof session.session === "object"
	);
}

export async function saveOfflineSession({
	token,
	session,
}: {
	token: string;
	session: OfflineSessionPayload;
}): Promise<void> {
	const { token: _bearer, ...sessionWithoutToken } = session.session;
	const stored: StoredOfflineSession = {
		tokenHash: hashToken(token),
		savedAt: new Date().toISOString(),
		session: { ...session, session: sessionWithoutToken },
	};

	const file = getOfflineSessionFile();
	const directory = dirname(file);
	await fs.mkdir(directory, { recursive: true, mode: SUPERSET_HOME_DIR_MODE });
	const temporaryFile = join(
		directory,
		`.${basename(file)}.${process.pid}-${randomUUID()}.tmp`,
	);
	try {
		await fs.writeFile(temporaryFile, encrypt(superjson.stringify(stored)), {
			mode: SUPERSET_SENSITIVE_FILE_MODE,
			flag: "wx",
		});
		await fs.chmod(temporaryFile, SUPERSET_SENSITIVE_FILE_MODE);
		await fs.rename(temporaryFile, file);
	} catch (error) {
		await fs.unlink(temporaryFile).catch(() => {});
		throw error;
	}
}

export async function loadOfflineSession(
	token: string,
): Promise<LoadedOfflineSession | null> {
	const file = getOfflineSessionFile();
	let encrypted: Buffer;
	try {
		encrypted = await fs.readFile(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("[auth] Failed to read the offline session", error);
		}
		return null;
	}

	let stored: unknown;
	try {
		stored = superjson.parse(decrypt(encrypted));
	} catch {
		stored = null;
	}
	if (!isStoredOfflineSession(stored)) {
		console.warn("[auth] Discarding an unreadable offline session");
		await clearOfflineSession();
		return null;
	}
	if (stored.tokenHash !== hashToken(token)) return null;

	return {
		savedAt: stored.savedAt,
		session: {
			...stored.session,
			session: { ...stored.session.session, token },
		},
	};
}

export async function clearOfflineSession(): Promise<void> {
	await fs.rm(getOfflineSessionFile(), { force: true });
}

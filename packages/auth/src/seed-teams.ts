/**
 * Seeds the three organizations, their allow-listed members, and an unlocked
 * subscription for each. Modelled on packages/auth/src/seed-dev.ts.
 *
 * Drop this at packages/auth/src/seed-teams.ts and add to package.json:
 *   "db:seed-teams": "bun run src/seed-teams.ts"
 *
 * PREREQUISITE — signup must be temporarily open for this script to run.
 * `auth.api.signUpEmail` goes through the same guard as the public endpoint,
 * and packages/auth/src/server.ts:179-183 disables signup outside development.
 * Make that guard env-driven:
 *
 *   emailAndPassword: {
 *     enabled: true,
 *     disableSignUp: process.env.SUPERSET_ALLOW_SIGNUP !== "true",
 *     autoSignIn: true,
 *   }
 *
 * Then run this once with SUPERSET_ALLOW_SIGNUP=true, and never set it again.
 * That is the whole invitation-only model: the only path to an account is an
 * operator running this script.
 *
 *   SUPERSET_ALLOW_SIGNUP=true SEED_TEAMS_CONFIRM=yes bun run db:seed-teams
 */

import { randomBytes } from "node:crypto";
import { db } from "@superset/db/client";
import {
	members,
	oauthClients,
	organizations,
	subscriptions,
	users,
} from "@superset/db/schema";
import { and, eq } from "drizzle-orm";
import { env } from "./env";
import { auth } from "./server";

// ---------------------------------------------------------------------------
// Configuration — the allow-list. Editing this file is how you add a person.
// ---------------------------------------------------------------------------

interface SeedMember {
	email: string;
	name: string;
	role: "owner" | "admin" | "member";
	/** Omit to auto-generate one and print it once. */
	password?: string;
}

interface SeedTeam {
	name: string;
	slug: string;
	/**
	 * Domains auto-enrolled at signup (packages/auth/src/server.ts:209-212).
	 * Leave empty when teams share an email domain — otherwise one address
	 * matches several orgs and the user lands in all of them.
	 */
	allowedDomains: string[];
	members: SeedMember[];
	/** Informational only; nothing enforces it on a self-hosted instance. */
	seats: number;
}

const TEAMS: SeedTeam[] = [
	{
		name: "Team One",
		slug: "team-one",
		allowedDomains: [],
		seats: 10,
		members: [
			{ email: "tomasnguyen43@gmail.com", name: "Tom Nguyen", role: "owner" },
			// { email: "teammate@example.com", name: "Teammate", role: "member" },
		],
	},
	{
		name: "Team Two",
		slug: "team-two",
		allowedDomains: [],
		seats: 10,
		members: [
			{ email: "tomasnguyen43@gmail.com", name: "Tom Nguyen", role: "owner" },
		],
	},
	{
		name: "Team Three",
		slug: "team-three",
		allowedDomains: [],
		seats: 10,
		members: [
			{ email: "tomasnguyen43@gmail.com", name: "Tom Nguyen", role: "owner" },
		],
	},
];

const PLAN = "enterprise" as const;

// ---------------------------------------------------------------------------

const generatedCredentials: Array<{ email: string; password: string }> = [];

function generatePassword(): string {
	// 24 url-safe chars. Printed once, then only the hash is retained.
	return randomBytes(18).toString("base64url");
}

async function upsertOrganization(team: SeedTeam): Promise<string> {
	const existing = await db.query.organizations.findFirst({
		where: eq(organizations.slug, team.slug),
	});

	if (existing) {
		await db
			.update(organizations)
			.set({ name: team.name, allowedDomains: team.allowedDomains })
			.where(eq(organizations.id, existing.id));
		console.log(`  org exists: ${team.slug}`);
		return existing.id;
	}

	const [created] = await db
		.insert(organizations)
		.values({
			name: team.name,
			slug: team.slug,
			allowedDomains: team.allowedDomains,
		})
		.returning({ id: organizations.id });

	if (!created) throw new Error(`failed to create organization ${team.slug}`);
	console.log(`  org created: ${team.slug}`);
	return created.id;
}

/**
 * Creates the account if absent. Every new user gets an organization from the
 * create hook — either domain-matched or a personal "X's Team" fallback
 * (packages/auth/src/server.ts:243-252). We drop that fallback so the only
 * orgs on the instance are the three defined above.
 */
async function upsertUser(member: SeedMember): Promise<string> {
	const existing = await db.query.users.findFirst({
		where: eq(users.email, member.email),
	});

	if (existing) {
		console.log(`  user exists: ${member.email}`);
		return existing.id;
	}

	const password = member.password ?? generatePassword();

	await auth.api.signUpEmail({
		body: { email: member.email, password, name: member.name },
	});

	const created = await db.query.users.findFirst({
		where: eq(users.email, member.email),
	});
	if (!created) {
		throw new Error(
			`signUpEmail did not create ${member.email} — is SUPERSET_ALLOW_SIGNUP=true set?`,
		);
	}

	// Skip the product onboarding flow for seeded accounts.
	await db
		.update(users)
		.set({ onboardedAt: new Date() })
		.where(eq(users.id, created.id));

	if (!member.password) {
		generatedCredentials.push({ email: member.email, password });
	}

	console.log(`  user created: ${member.email}`);
	return created.id;
}

/** Removes the auto-created personal org, keeping only the three real teams. */
async function dropPersonalOrg(userId: string): Promise<void> {
	const personalSlug = `${userId.slice(0, 8)}-team`;
	const personal = await db.query.organizations.findFirst({
		where: eq(organizations.slug, personalSlug),
	});
	if (!personal) return;

	await db.delete(organizations).where(eq(organizations.id, personal.id));
	console.log(`  removed personal org: ${personalSlug}`);
}

async function upsertMembership(
	organizationId: string,
	userId: string,
	role: SeedMember["role"],
): Promise<void> {
	const existing = await db.query.members.findFirst({
		where: and(
			eq(members.organizationId, organizationId),
			eq(members.userId, userId),
		),
	});

	if (existing) {
		if (existing.role !== role) {
			await db
				.update(members)
				.set({ role })
				.where(eq(members.id, existing.id));
		}
		return;
	}

	await db.insert(members).values({ organizationId, userId, role });
}

/**
 * The unlock. `billing.activePlan` is a pure database read
 * (packages/trpc/src/router/billing/billing.ts:117-141) — no Stripe call —
 * so this row is what every paywall in the desktop app resolves against.
 * `enterprise` specifically, because the seat-sync hooks early-return on it
 * and never reach Stripe (packages/auth/src/server.ts:724, :837).
 */
async function upsertSubscription(
	organizationId: string,
	seats: number,
): Promise<void> {
	const existing = await db.query.subscriptions.findFirst({
		where: and(
			eq(subscriptions.referenceId, organizationId),
			eq(subscriptions.status, "active"),
		),
	});

	if (existing) {
		if (existing.plan !== PLAN) {
			await db
				.update(subscriptions)
				.set({ plan: PLAN })
				.where(eq(subscriptions.id, existing.id));
			console.log(`  subscription upgraded to ${PLAN}`);
		}
		return;
	}

	const periodStart = new Date();
	const periodEnd = new Date(periodStart);
	periodEnd.setFullYear(periodEnd.getFullYear() + 100);

	await db.insert(subscriptions).values({
		plan: PLAN,
		referenceId: organizationId,
		status: "active",
		billingInterval: "yearly",
		seats,
		periodStart,
		periodEnd,
	});
	console.log(`  subscription created: ${PLAN}`);
}

/**
 * Required for `superset auth login` to work against this instance — the CLI
 * authenticates through our own OAuth provider, not GitHub. Lifted verbatim
 * from seed-dev.ts; the redirect URIs are built from the web URL, so
 * NEXT_PUBLIC_WEB_URL must already point at the public hostname.
 */
async function seedCliOAuthClient(): Promise<void> {
	const CLI_CLIENT_ID = "superset-cli";
	const CLI_LOOPBACK_PORTS = [51789, 51790, 51791, 51792, 51793];

	const webUrls = [
		...new Set(
			[process.env.SUPERSET_WEB_URL, env.NEXT_PUBLIC_WEB_URL].filter(
				(url): url is string => Boolean(url),
			),
		),
	];

	const registration = {
		name: "Superset CLI",
		redirectUris: [
			...CLI_LOOPBACK_PORTS.map((port) => `http://127.0.0.1:${port}/callback`),
			...webUrls.map((url) => new URL("/cli/auth/code", url).toString()),
		],
		grantTypes: ["authorization_code", "refresh_token"],
		responseTypes: ["code"],
		scopes: ["openid", "profile", "email", "offline_access"],
		tokenEndpointAuthMethod: "none",
		public: true,
		disabled: false,
		updatedAt: new Date(),
	};

	const existing = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, CLI_CLIENT_ID),
	});

	if (existing) {
		await db
			.update(oauthClients)
			.set(registration)
			.where(eq(oauthClients.clientId, CLI_CLIENT_ID));
		console.log(`Refreshed CLI OAuth client (web: ${webUrls.join(", ")})`);
		return;
	}

	await db
		.insert(oauthClients)
		.values({ clientId: CLI_CLIENT_ID, ...registration, createdAt: new Date() });
	console.log(`Seeded CLI OAuth client (web: ${webUrls.join(", ")})`);
}

async function main(): Promise<void> {
	if (process.env.SEED_TEAMS_CONFIRM !== "yes") {
		throw new Error(
			"refusing to run without SEED_TEAMS_CONFIRM=yes — this writes accounts and subscriptions",
		);
	}

	for (const team of TEAMS) {
		console.log(`\n${team.name} (${team.slug})`);
		const organizationId = await upsertOrganization(team);

		for (const member of team.members) {
			const userId = await upsertUser(member);
			await dropPersonalOrg(userId);
			await upsertMembership(organizationId, userId, member.role);
		}

		await upsertSubscription(organizationId, team.seats);
	}

	console.log("");
	await seedCliOAuthClient();

	if (generatedCredentials.length > 0) {
		console.log("\n--- generated passwords, shown once ---");
		for (const { email, password } of generatedCredentials) {
			console.log(`${email}  ${password}`);
		}
		console.log("--- store these now; only the hash is kept ---");
	}

	console.log(`\nSeeded ${TEAMS.length} organizations on ${PLAN}.`);
	console.log("Unset SUPERSET_ALLOW_SIGNUP before leaving the instance up.");
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error("seed-teams failed:", error);
		process.exit(1);
	});

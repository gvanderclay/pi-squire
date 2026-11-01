// Launch identity is session-local durable state, not the shared tree registry.
// Readers (trust routing, caps and views) use session ids for routing; chain is
// ordered roster names for labels only. A resume retains the original identity.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Agent, Roster } from "./agents.ts";
import { readState, writeState } from "./local-state.ts";
import { assertRootPlacement } from "./window-placement.ts";

export const DELEGATION_TOOLS = ["delegate", "delegation_status", "delegation_close", "delegation_resume"] as const;
export type Identity = {
	parent: string;
	root: string;
	/** Original root project's preferred companion base, inherited unchanged. */
	rootPlacement: string;
	depth: number;
	agent: string;
	chain: string[];
	autoExit: boolean;
};
/** Public, immutable exact-session observation; no internal placement or exit state. */
export type IdentityNotification =
	| Readonly<{ sessionId: string; status: "root" | "invalid" }>
	| Readonly<{
			sessionId: string;
			status: "delegate";
			identity: Readonly<{
				parent: string;
				root: string;
				agent: string;
				chain: readonly string[];
				depth: number;
			}>;
	  }>;
const pathFor = (session: string): string =>
	join(getAgentDir(), "squire", "identity", `${encodeURIComponent(session)}.json`);
export function readIdentity(session: string): Identity | undefined {
	const value = readState<Identity>(pathFor(session));
	if (value === undefined) return undefined;
	if (
		!value ||
		typeof value.parent !== "string" ||
		!value.parent ||
		typeof value.root !== "string" ||
		!value.root ||
		!Number.isSafeInteger(value.depth) ||
		value.depth < 1 ||
		typeof value.agent !== "string" ||
		!Array.isArray(value.chain) ||
		!value.chain.every((name) => typeof name === "string") ||
		typeof value.autoExit !== "boolean"
	)
		throw new Error(`invalid delegation identity for ${session}; repair its squire/identity record before reopening`);
	assertRootPlacement(value.rootPlacement);
	return value;
}
export const writeIdentity = (session: string, identity: Identity): void => writeState(pathFor(session), identity);

export function maxDepth(): number {
	const file = join(getAgentDir(), "squire", "settings.json");
	let settings: { maxDepth?: unknown };
	try {
		settings = JSON.parse(readFileSync(file, "utf8")) as typeof settings;
	} catch {
		// Match existing settings readers: an unreadable file grants only the
		// safe single-level default; a readable invalid maxDepth refuses.
		return 1;
	}
	const value = settings?.maxDepth ?? 1;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`invalid maxDepth in ${file}: expected a positive integer`);
	return value;
}

export function grantsNesting(agent: Agent, depth: number): boolean {
	return (agent.allowNested === true || (agent.allowNested?.length ?? 0) > 0) && depth < maxDepth();
}

export function createIdentity(pi: ExtensionAPI): {
	current(): Identity | undefined;
	child(agent: Agent, ctx: ExtensionContext, rootPlacement: string): Identity;
	admit(agent: string, roster: Roster): void;
} {
	// Launch writes exact-id identity before spawn. Inherited environment is
	// labels for integrations, never authority for a new/forked session.
	let current: Identity | undefined;
	let problem: unknown;
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		current = undefined;
		problem = undefined;
		try {
			const restored = readIdentity(sessionId);
			if (restored) writeIdentity(sessionId, restored);
			current = restored;
		} catch (error) {
			problem = error;
		}
		const notification: IdentityNotification = current
			? Object.freeze({
					sessionId,
					status: "delegate",
					identity: Object.freeze({
						parent: current.parent,
						root: current.root,
						agent: current.agent,
						chain: Object.freeze([...current.chain]),
						depth: current.depth,
					}),
				})
			: Object.freeze({ sessionId, status: problem ? "invalid" : "root" });
		// Synchronous listeners run before later session_start handlers or async work.
		// This is a notification, not a gate or listener-success acknowledgement.
		pi.events.emit("squire:identity", notification);
		if (problem)
			ctx.ui.notify(
				`delegate: could not restore delegation identity: ${String(problem)}; launches and completion are blocked.`,
				"error",
			);
	});
	return {
		current: () => {
			if (problem) throw problem;
			return current;
		},
		child: (agent: Agent, ctx: ExtensionContext, rootPlacement: string): Identity => ({
			parent: ctx.sessionManager.getSessionId(),
			root: current?.root ?? ctx.sessionManager.getSessionId(),
			rootPlacement: current?.rootPlacement ?? rootPlacement,
			depth: (current?.depth ?? 0) + 1,
			agent: agent.name,
			chain: [...(current?.chain ?? []), agent.name],
			autoExit: agent.autoExit,
		}),
		admit: (agent: string, roster: Roster): void => {
			if (problem) throw problem;
			const limit = maxDepth();
			if (!current) return;
			if (!Number.isSafeInteger(current.depth) || current.depth < 1 || current.depth >= limit)
				throw new Error(
					`nested delegation refused at depth ${current.depth}: maxDepth is ${limit} in squire/settings.json`,
				);
			const own = roster.agents.find((item) => item.name === current?.agent);
			const grant = own?.allowNested;
			if (grant === true || (Array.isArray(grant) && grant.includes(agent))) return;
			throw new Error(
				`agent ${JSON.stringify(current.agent)} does not permit nested agent ${JSON.stringify(agent)}; permitted agents: ${Array.isArray(grant) && grant.length ? grant.join(", ") : "none"}. Set allow_nested_delegation in the parent's current agent definition.`,
			);
		},
	};
}

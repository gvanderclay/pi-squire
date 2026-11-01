// Process-local completion composition. Providers own hold readiness; Squire
// advertises only its active exact-session runtime and never owns provider rows.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY: symbol = Symbol.for("pi.completion-holds.v1");
type Hold = { provider: string; ready: boolean };
type Table = {
	version: 1;
	hosts: Map<string, Map<string, string>>;
	holds: Map<string, Map<string, Hold>>;
};
const shared: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>;

function table(create: boolean): Table | undefined {
	const value: unknown = shared[KEY];
	if (value === undefined) {
		if (!create) return undefined;
		const fresh: Table = { version: 1, hosts: new Map(), holds: new Map() };
		shared[KEY] = fresh;
		return fresh;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("hosts" in value) ||
		!(value.hosts instanceof Map) ||
		!("holds" in value) ||
		!(value.holds instanceof Map)
	)
		throw new Error("invalid pi.completion-holds.v1 table; completion is blocked");
	return value as Table;
}

function validHosts(hosts: unknown): hosts is Map<string, string> {
	return (
		hosts instanceof Map &&
		[...hosts].every(
			([name, runtime]) => typeof name === "string" && !!name && typeof runtime === "string" && !!runtime,
		)
	);
}

/** Missing table/no holds preserves normal completion; malformed data refuses. */
export function externalHoldsReady(sessionId: string): boolean {
	try {
		const current: Table | undefined = table(false);
		if (!current) return true;
		const hosts: unknown = current.hosts.get(sessionId);
		if (hosts !== undefined && !validHosts(hosts)) return false;
		const holds: Map<string, Hold> | undefined = current.holds.get(sessionId);
		if (holds === undefined) return true;
		if (!(holds instanceof Map)) return false;
		for (const [id, hold] of holds) {
			if (
				typeof id !== "string" ||
				!id ||
				typeof hold !== "object" ||
				hold === null ||
				typeof hold.provider !== "string" ||
				!hold.provider ||
				hold.ready !== true
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

function removeHost(sessionId: string, token: string): void {
	// Clean our own token even if another field/version has become malformed.
	const value: unknown = shared[KEY];
	if (typeof value !== "object" || value === null || !("hosts" in value) || !(value.hosts instanceof Map)) return;
	const hosts: unknown = value.hosts.get(sessionId);
	if (!(hosts instanceof Map) || hosts.get("pi-squire") !== token) return;
	hosts.delete("pi-squire");
	if (hosts.size === 0) value.hosts.delete(sessionId);
}

/** Call with ownedAPI: a losing duplicate runtime must never advertise support. */
export function registerCompletionHost(pi: ExtensionAPI): () => boolean {
	const token: string = randomUUID();
	let sessionId: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (sessionId !== undefined) removeHost(sessionId, token);
		sessionId = ctx.sessionManager.getSessionId();
		const current: Table | undefined = table(true);
		if (!current) throw new Error("completion hold table is unavailable");
		const saved: Map<string, string> | undefined = current.hosts.get(sessionId);
		if (saved !== undefined && !validHosts(saved)) throw new Error("invalid completion hold hosts");
		const hosts: Map<string, string> = saved ?? new Map();
		hosts.set("pi-squire", token);
		current.hosts.set(sessionId, hosts);
	});
	pi.on("session_shutdown", () => {
		if (sessionId !== undefined) removeHost(sessionId, token);
		sessionId = undefined;
	});
	return (): boolean => sessionId !== undefined && externalHoldsReady(sessionId);
}

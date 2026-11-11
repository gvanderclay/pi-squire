// A Paseo delegate takes no Pi flags: the host creates it from API fields, so
// the tool list and the project-trust answer arrive as environment variables.
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATION_TOOLS, toolMatches } from "./delegate-composition.ts";

/** The delegate's tool list, as `--tools` would have passed it. */
export const PASEO_TOOLS_ENV = "PI_DELEGATE_PASEO_TOOLS";
/** The delegate's project-trust answer, "yes" or "no", as `--approve` would have passed it. */
export const PASEO_TRUST_ENV = "PI_DELEGATE_PASEO_TRUST";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether Paseo started this Pi: it exports the agent id it chose. */
const hosted = (): boolean => (process.env.PASEO_AGENT_ID ?? "") !== "";

/**
 * Whether `cwd` is the folder Paseo started this agent in. A shell the delegate
 * runs inherits these variables, so a folder that cannot be resolved, or any
 * other folder, gets no answer from them.
 */
function ownFolder(cwd: string): boolean {
	const own = process.env.PASEO_AGENT_CWD;
	if (own === undefined || own === "") return false;
	try {
		return realpathSync(own) === realpathSync(cwd);
	} catch {
		return false;
	}
}

/** The agent id Paseo chose, when it is a UUID; a delegate's launch record is filed under it. */
export function paseoAgentId(): string | undefined {
	const value = process.env.PASEO_AGENT_ID;
	return value !== undefined && UUID.test(value) ? value : undefined;
}

/** The tool list as name patterns, or undefined when this is not a Paseo delegate with one. */
function toolList(): string[] | undefined {
	const value = process.env[PASEO_TOOLS_ENV];
	if (!hosted() || value === undefined) return undefined;
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** Whether `name` is listed; the delegation tools are `src/index.ts`'s to grant. */
const listed = (name: string, patterns: readonly string[]): boolean =>
	!DELEGATION_TOOLS.has(name) && patterns.some((pattern) => toolMatches(pattern, name));

/**
 * A Paseo delegate's tools and trust answer. The list is applied at every
 * start because another extension can add a tool back after `session_start`;
 * a call outside it is refused too, in case a tool comes back after the last
 * start. Trust is asked before `session_start`, so it is registered on
 * `trustApi`, which answers while `pi` still waits for the session owner.
 */
export function registerPaseoChild(pi: ExtensionAPI, trustApi: ExtensionAPI): void {
	const apply = (): void => {
		const patterns = toolList();
		if (patterns === undefined) return;
		const kept = pi
			.getAllTools()
			.map((tool) => tool.name)
			.filter((name) => listed(name, patterns));
		const granted = pi.getActiveTools().filter((name) => DELEGATION_TOOLS.has(name));
		pi.setActiveTools([...new Set([...kept, ...granted])]);
	};
	pi.on("session_start", apply);
	pi.on("before_agent_start", apply);
	pi.on("tool_call", (event): { block: true; reason: string } | undefined => {
		const patterns = toolList();
		if (patterns === undefined || DELEGATION_TOOLS.has(event.toolName)) return undefined;
		if (patterns.some((pattern) => toolMatches(pattern, event.toolName))) return undefined;
		return { block: true, reason: `${event.toolName} is not in this delegate's tool list` };
	});
	trustApi.on("project_trust", (event): { trusted: "yes" | "no" | "undecided" } => {
		const wanted = process.env[PASEO_TRUST_ENV];
		const answer = wanted === "yes" || wanted === "no" ? wanted : "undecided";
		return { trusted: hosted() && ownFolder(event.cwd) ? answer : "undecided" };
	});
}

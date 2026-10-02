// The parent's agent roster: `<agent dir>/agents/<name>/AGENT.md`, read at
// call time so a new agent is usable without a reload. Frontmatter carries
// `description`, `model` and `thinking`, and optionally `auto-exit` (default
// true) and `exclude-tools` (tools the delegate goes without, passed to its Pi
// as `--exclude-tools`; each must be a tool the parent session has); the body
// is the delegate's system prompt. A file that is missing or malformed is left out, with a warning.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** The levels `pi --thinking` accepts. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Thinking = (typeof THINKING_LEVELS)[number];

export function isThinking(value: string): value is Thinking {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** An agent name is one safe path segment and one safe tmux window name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** `provider/id`; the id may itself contain slashes. */
const MODEL = /^[^\s/]+\/\S+$/;

export type Agent = {
	name: string;
	description: string;
	model: string;
	thinking: Thinking;
	/** Whether the delegate closes itself after a normal completion; `auto-exit`, default true. */
	autoExit: boolean;
	/** Tools the delegate goes without, from `exclude-tools`; empty means all of them. */
	excludeTools: string[];
	/** The body of `AGENT.md`: the delegate's system prompt. */
	prompt: string;
};

export type Roster = {
	agents: Agent[];
	/** One line per `AGENT.md` left out, naming its path and the reason. */
	warnings: string[];
};

const field = (frontmatter: Record<string, unknown>, key: string): string | undefined => {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** Parse one `AGENT.md`; undefined with a reason when it cannot be an agent. */
function parseAgent(
	name: string,
	path: string,
	text: string,
	tools: readonly string[] | undefined,
): { agent?: Agent; warning?: string } {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(text) as { frontmatter: Record<string, unknown>; body: string });
	} catch (err) {
		return { warning: `${path} is not readable frontmatter (${(err as Error).message}); skipped` };
	}
	if (frontmatter === null || typeof frontmatter !== "object")
		return { warning: `${path} has no frontmatter fields; skipped` };
	const description = field(frontmatter, "description");
	const model = field(frontmatter, "model");
	const thinking = field(frontmatter, "thinking");
	const missing = [
		description === undefined ? "description" : undefined,
		model === undefined ? "model" : undefined,
		thinking === undefined ? "thinking" : undefined,
	].filter((key): key is string => key !== undefined);
	if (missing.length > 0) return { warning: `${path} has no ${missing.join(", ")}; skipped` };
	if (!MODEL.test(model as string))
		return { warning: `${path} has model ${JSON.stringify(model)}, not provider/id; skipped` };
	if (!isThinking(thinking as string))
		return {
			warning: `${path} has thinking ${JSON.stringify(thinking)}, not one of ${THINKING_LEVELS.join(", ")}; skipped`,
		};
	if (body === "") return { warning: `${path} has no prompt body; skipped` };
	const autoExit = flag(frontmatter["auto-exit"]);
	if (autoExit === null)
		return { warning: `${path} has auto-exit ${JSON.stringify(frontmatter["auto-exit"])}, not true or false; skipped` };
	const listed = toolList(frontmatter["exclude-tools"]);
	if (listed === null)
		return {
			warning: `${path} has exclude-tools ${JSON.stringify(frontmatter["exclude-tools"])}, not a comma-separated list of tool names; skipped`,
		};
	const excludeTools = listed ?? [];
	const unknownTool = tools === undefined ? undefined : excludeTools.find((tool) => !tools.includes(tool));
	if (unknownTool !== undefined)
		return {
			warning: `${path} has exclude-tools ${JSON.stringify(unknownTool)}, not a tool this session has; skipped`,
		};
	return {
		agent: {
			name,
			description: description as string,
			model: model as string,
			thinking: thinking as Thinking,
			autoExit: autoExit ?? true,
			excludeTools,
			prompt: body,
		},
	};
}

/** A tool list, comma-separated or a YAML list of names; undefined when absent, null when it is neither. */
function toolList(value: unknown): string[] | undefined | null {
	if (value === undefined || value === null) return undefined;
	const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
	if (names === null || !names.every((name) => typeof name === "string")) return null;
	return names.map((name) => name.trim()).filter((name) => name !== "");
}

/** A true/false frontmatter value; undefined when absent, null when it is neither. */
function flag(value: unknown): boolean | undefined | null {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

/**
 * Read every agent under `<agentDir>/agents/`, in name order. A directory
 * with no `AGENT.md` is not an agent and is passed over quietly; an
 * `AGENT.md` that cannot be used is warned about and left out. `tools` are
 * the session's tool names, which `exclude-tools` is checked against;
 * undefined skips that check, as before the session's tools are known.
 */
export function readRoster(agentDir: string, tools?: readonly string[]): Roster {
	const dir = join(agentDir, "agents");
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return { agents: [], warnings: [] }; // no agents directory yet
	}
	const agents: Agent[] = [];
	const warnings: string[] = [];
	for (const name of names) {
		const path = join(dir, name, "AGENT.md");
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		if (!NAME.test(name)) {
			warnings.push(`${path} is not under a usable agent name; skipped`);
			continue;
		}
		const { agent, warning } = parseAgent(name, path, text, tools);
		if (agent !== undefined) agents.push(agent);
		else if (warning !== undefined) warnings.push(warning);
	}
	return { agents, warnings };
}

// The parent's agent roster: `<agent dir>/agents/<name>/AGENT.md`, read at
// call time so a new agent is usable without a reload. Frontmatter carries
// `description`, `model` and `thinking`; the body is the delegate's system
// prompt. A file that is missing or malformed is left out, with a warning.
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
function parseAgent(name: string, path: string, text: string): { agent?: Agent; warning?: string } {
	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(text) as { frontmatter: Record<string, unknown>; body: string });
	} catch (err) {
		return { warning: `${path} is not readable frontmatter (${(err as Error).message}); skipped` };
	}
	if (frontmatter === null || typeof frontmatter !== "object") return { warning: `${path} has no frontmatter fields; skipped` };
	const description = field(frontmatter, "description");
	const model = field(frontmatter, "model");
	const thinking = field(frontmatter, "thinking");
	const missing = [
		description === undefined ? "description" : undefined,
		model === undefined ? "model" : undefined,
		thinking === undefined ? "thinking" : undefined,
	].filter((key): key is string => key !== undefined);
	if (missing.length > 0) return { warning: `${path} has no ${missing.join(", ")}; skipped` };
	if (!MODEL.test(model as string)) return { warning: `${path} has model ${JSON.stringify(model)}, not provider/id; skipped` };
	if (!isThinking(thinking as string))
		return { warning: `${path} has thinking ${JSON.stringify(thinking)}, not one of ${THINKING_LEVELS.join(", ")}; skipped` };
	if (body === "") return { warning: `${path} has no prompt body; skipped` };
	return { agent: { name, description: description as string, model: model as string, thinking: thinking as Thinking, prompt: body } };
}

/**
 * Read every agent under `<agentDir>/agents/`, in name order. A directory
 * with no `AGENT.md` is not an agent and is passed over quietly; an
 * `AGENT.md` that cannot be used is warned about and left out.
 */
export function readRoster(agentDir: string): Roster {
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
		const { agent, warning } = parseAgent(name, path, text);
		if (agent !== undefined) agents.push(agent);
		else if (warning !== undefined) warnings.push(warning);
	}
	return { agents, warnings };
}

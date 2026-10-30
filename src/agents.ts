// The parent's agent roster: one file per agent, `<name>.md`, in the agents
// folders Pi agent tooling shares. `<agent dir>/agents/` holds the global
// agents; `<cwd>/.pi/agents/` holds a project's, read only when the project is
// trusted, and a project file replaces the global file of the same name. The
// roster is read at call time, so a new agent is usable without a reload.
//
// Every frontmatter field is optional: `description` (default the name),
// `display_name`, `model` and `fallback` (passed to the child's Pi unchanged;
// absent `model` means the parent's), `thinking` (absent or unknown means the
// parent's level), `tools` (the delegate's complete tool list; absent means the
// parent's tools, empty means none), `extensions` (extra extension paths for the delegate only;
// `~` expands, relative paths resolve against the agent file's folder, and a
// missing path leaves the agent out), `auto-exit` (default true),
// `prompt_mode` (`append`, the default, or `replace`), `enabled` (false leaves
// the agent out) and `locked` (true, or a list of `model` and `thinking`). Any
// other key is ignored, left for whatever else reads the file. The body is the
// delegate's instructions. A file that cannot be read as an agent is disabled:
// left out, with a warning, and a call naming it is refused with the reason.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** The levels `pi --thinking` accepts. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Thinking = (typeof THINKING_LEVELS)[number];

export function isThinking(value: string): value is Thinking {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** The fields an agent file can lock against a call's override. */
export const LOCKABLE = ["model", "thinking"] as const;

export type Lockable = (typeof LOCKABLE)[number];

/** How the body joins the delegate's prompt: wrapped in `<agent_instructions>`, or as it is. */
export type PromptMode = "append" | "replace";

/** An agent name is one safe path segment and one safe tmux window name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Whether `value` holds a control character, which a display name cannot: it names a tmux window. */
const hasControl = (value: string): boolean =>
	[...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

export type Agent = {
	name: string;
	/** Shown instead of the name on the delegate card, `/delegates` and the window title; from `display_name`. */
	displayName?: string;
	description: string;
	/** Passed to the child's `--model` unchanged; undefined means the parent's model. */
	model?: string;
	/** Undefined means the parent's level. */
	thinking?: Thinking;
	/** Whether the delegate closes itself after a normal completion; `auto-exit`, default true. */
	autoExit: boolean;
	/**
	 * The delegate's complete tool list, from a `tools` line of tool names:
	 * undefined when the field is absent or holds only `-name` entries (the
	 * parent's tools), empty when it is empty (no tools).
	 */
	tools?: string[];
	/** The names or `*` patterns a `tools` line of only `-name` entries takes off the parent's tools; empty otherwise. */
	toolsExcept: string[];
	/** Absolute paths of extra extensions the delegate loads, from `extensions`; empty when absent. */
	extensions: string[];
	/** Models to try, in order, when `model` is usage-limited; from `fallback`, empty when absent. */
	fallback: string[];
	/** The fields a call cannot override, from `locked`. */
	locked: Lockable[];
	promptMode: PromptMode;
	/** The body of the agent file: the delegate's instructions; may be empty. */
	prompt: string;
	/** The file the agent was read from. */
	path: string;
};

/** An agent whose file is invalid: left out of the roster, and refused by name with `reason`. */
export type Disabled = { name: string; path: string; reason: string };

export type Roster = {
	agents: Agent[];
	/** The agents whose files are invalid, by name; a call naming one is refused with its reason. */
	disabled: Disabled[];
	/** One line per agent file left out or field ignored, naming its path and the reason. */
	warnings: string[];
};

/** The global agents folder, `<agent dir>/agents`. */
export const globalAgentsDir = (agentDir: string): string => join(agentDir, "agents");

/** A project's agents folder, `<cwd>/.pi/agents`. */
export const projectAgentsDir = (cwd: string): string => join(cwd, ".pi", "agents");

const field = (frontmatter: Record<string, unknown>, key: string): string | undefined => {
	const value = frontmatter[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
};

/** One parsed file: the agent, or why it is invalid; neither for a file with `enabled: false`. */
type Parsed = { agent?: Agent; invalid?: string; notes: string[] };

/** Parse one agent file; no agent, with why it is invalid when it is, when it cannot be an agent or is disabled. */
function parseAgent(name: string, path: string, text: string): Parsed {
	let frontmatter: unknown;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter(text) as { frontmatter: unknown; body: string });
	} catch (err) {
		return { invalid: `${path} is not readable frontmatter (${(err as Error).message})`, notes: [] };
	}
	if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter))
		return { invalid: `${path} has frontmatter that is not a set of fields`, notes: [] };
	const fields = frontmatter as Record<string, unknown>;
	const enabled = flag(fields.enabled);
	if (enabled === null)
		return { invalid: `${path} has enabled ${JSON.stringify(fields.enabled)}, not true or false`, notes: [] };
	if (enabled === false) return { notes: [] };
	const autoExit = flag(fields["auto-exit"]);
	if (autoExit === null)
		return { invalid: `${path} has auto-exit ${JSON.stringify(fields["auto-exit"])}, not true or false`, notes: [] };
	const launch = launchFields(path, fields);
	if ("invalid" in launch) return { ...launch, notes: [] };
	// A field that cannot be used is dropped with a note; it never costs the agent.
	const notes: string[] = [];
	const model = field(fields, "model");
	const thinking = thinkingField(path, fields, notes);
	const fallback = toolList(fields.fallback);
	if (fallback === null)
		notes.push(`${path} has fallback ${JSON.stringify(fields.fallback)}, not a list of models; ignored`);
	if (fields["exclude-tools"] !== undefined)
		notes.push(`${path} has exclude-tools, which is no longer read; list the delegate's tools in tools instead`);
	return {
		notes,
		agent: {
			name,
			...displayName(path, fields, notes),
			description: field(fields, "description") ?? name,
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			autoExit: autoExit ?? true,
			...launch,
			fallback: fallback ?? [],
			locked: lockedFields(path, fields, { model, thinking }, notes),
			promptMode: promptMode(path, fields, notes),
			prompt: body.trim(),
			path,
		},
	};
}

/** The `thinking` field; an unknown level is dropped with a note, so the parent's level applies. */
function thinkingField(path: string, fields: Record<string, unknown>, notes: string[]): Thinking | undefined {
	if (fields.thinking === undefined || fields.thinking === null) return undefined;
	const value = typeof fields.thinking === "string" ? fields.thinking.trim() : undefined;
	if (value !== undefined && isThinking(value)) return value;
	notes.push(
		`${path} has thinking ${JSON.stringify(fields.thinking)}, not one of ${THINKING_LEVELS.join(", ")}; the parent's level applies`,
	);
	return undefined;
}

/** The `display_name` field, as a spread; one with control characters is ignored with a note. */
function displayName(path: string, fields: Record<string, unknown>, notes: string[]): { displayName?: string } {
	const value = field(fields, "display_name");
	if (value === undefined) return {};
	if (!hasControl(value)) return { displayName: value };
	notes.push(`${path} has a display_name with control characters; ignored`);
	return {};
}

/** The `prompt_mode` field; an unknown mode is ignored with a note, so the default applies. */
function promptMode(path: string, fields: Record<string, unknown>, notes: string[]): PromptMode {
	const value = fields.prompt_mode;
	if (value === undefined || value === null || value === "append") return "append";
	if (value === "replace") return "replace";
	notes.push(`${path} has prompt_mode ${JSON.stringify(value)}, not append or replace; append applies`);
	return "append";
}

/** The `locked` field: `true` locks the lockable fields the file sets; a list names them. */
function lockedFields(
	path: string,
	fields: Record<string, unknown>,
	set: { model?: string; thinking?: string },
	notes: string[],
): Lockable[] {
	const value = fields.locked;
	if (value === undefined || value === null || value === false) return [];
	if (value === true) return LOCKABLE.filter((key) => set[key] !== undefined);
	const names = toolList(value);
	if (names === null || names === undefined) {
		notes.push(`${path} has locked ${JSON.stringify(value)}, not true or a list of model and thinking; ignored`);
		return [];
	}
	const locked: Lockable[] = [];
	for (const entry of names) {
		if ((LOCKABLE as readonly string[]).includes(entry)) {
			if (!locked.includes(entry as Lockable)) locked.push(entry as Lockable);
		} else notes.push(`${path} has locked ${JSON.stringify(entry)}, not model or thinking; dropped`);
	}
	return locked;
}

/**
 * The `tools` field: tool names (`*` patterns allowed) are the whole list;
 * only `-name` entries take those off the parent's tools. A `+name` entry, or
 * names and `-name` entries mixed, make the file invalid.
 */
function toolsField(
	path: string,
	frontmatter: Record<string, unknown>,
): { tools?: string[]; toolsExcept: string[] } | { invalid: string } {
	// `tools:` with no value is YAML null: present and empty, unlike an absent field.
	const tools = Object.hasOwn(frontmatter, "tools") && frontmatter.tools === null ? [] : toolList(frontmatter.tools);
	if (tools === null)
		return {
			invalid: `${path} has tools ${JSON.stringify(frontmatter.tools)}, not a comma-separated list of tool names`,
		};
	if (tools === undefined) return { toolsExcept: [] };
	const plus = tools.find((name) => name.startsWith("+"));
	if (plus !== undefined)
		return {
			invalid: `${path} has tools entry ${JSON.stringify(plus)}: +name entries are not accepted; list every tool by name, or only -name entries to take tools off the parent's`,
		};
	const minus = tools.filter((name) => name.startsWith("-"));
	if (minus.length === 0) return { tools, toolsExcept: [] };
	if (minus.length < tools.length)
		return {
			invalid: `${path} has tools that mix tool names with -name entries; list every tool by name, or only -name entries to take tools off the parent's`,
		};
	const bare = minus.find((name) => name.slice(1).trim() === "");
	if (bare !== undefined) return { invalid: `${path} has tools entry ${JSON.stringify(bare)}, which names no tool` };
	return { toolsExcept: minus.map((name) => name.slice(1).trim()) };
}

/** The `tools` and `extensions` fields, or why the agent is invalid. */
function launchFields(
	path: string,
	frontmatter: Record<string, unknown>,
): { tools?: string[]; toolsExcept: string[]; extensions: string[] } | { invalid: string } {
	const tools = toolsField(path, frontmatter);
	if ("invalid" in tools) return tools;
	const paths = toolList(frontmatter.extensions);
	if (paths === null)
		return {
			invalid: `${path} has extensions ${JSON.stringify(frontmatter.extensions)}, not a comma-separated list of paths`,
		};
	const extensions = (paths ?? []).map((entry) => resolveExtension(entry, dirname(path)));
	const absent = extensions.find((entry) => !existsSync(entry));
	if (absent !== undefined) return { invalid: `${path} has extension ${absent}, which does not exist` };
	return { ...tools, extensions };
}

/** An extension path as an absolute one: `~` is the home directory, a relative path is against the agent file's folder. */
function resolveExtension(entry: string, dir: string): string {
	if (entry === "~") return homedir();
	if (entry.startsWith("~/")) return join(homedir(), entry.slice(2));
	return isAbsolute(entry) ? entry : resolve(dir, entry);
}

/** A list of names (tools or models), comma-separated or a YAML list of names; undefined when absent, null when it is neither. */
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

/** The `<name>.md` files directly in `dir`, by name; empty when there is no such folder. */
function agentFiles(dir: string): Map<string, string> {
	const files = new Map<string, string>();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return files; // no agents folder
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		try {
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}
		files.set(entry.slice(0, -".md".length), path);
	}
	return files;
}

/**
 * Read every agent, in name order: the global folder, then `projectDir` when
 * given, whose files replace global ones of the same name. The caller passes
 * `projectDir` only for a trusted project. A file that cannot be used is
 * disabled: left out, warned about and kept in `disabled` with why; a file
 * with `enabled: false` is left out quietly.
 */
export function readRoster(agentDir: string, projectDir?: string): Roster {
	const files = agentFiles(globalAgentsDir(agentDir));
	if (projectDir !== undefined) for (const [name, path] of agentFiles(projectDir)) files.set(name, path);
	const agents: Agent[] = [];
	const disabled: Disabled[] = [];
	const warnings: string[] = [];
	const retired = join(agentDir, "squire", "agents");
	if (existsSync(retired))
		warnings.push(
			`${retired} is no longer read; move each <name>/AGENT.md there to ${join(globalAgentsDir(agentDir), "<name>.md")}`,
		);
	const disable = (name: string, path: string, reason: string): void => {
		disabled.push({ name, path, reason });
		warnings.push(`${reason}; skipped`);
	};
	for (const name of [...files.keys()].sort()) {
		const path = files.get(name) as string;
		if (!NAME.test(name)) {
			disable(name, path, `${path} is not named as a usable agent (letters, digits, _ or -)`);
			continue;
		}
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (err) {
			disable(name, path, `${path} could not be read (${(err as Error).message})`);
			continue;
		}
		const { agent, invalid, notes } = parseAgent(name, path, text);
		warnings.push(...notes);
		if (agent !== undefined) agents.push(agent);
		else if (invalid !== undefined) disable(name, path, invalid);
	}
	return { agents, disabled, warnings };
}

/** The refusal for a call that names a disabled agent; undefined when `name` is not one. */
export function disabledProblem(roster: Roster, name: string): string | undefined {
	const found = roster.disabled.find((item) => item.name === name);
	return found === undefined
		? undefined
		: `agent ${JSON.stringify(name)} is disabled because its file is invalid: ${found.reason}`;
}

/**
 * A call's `model` and `thinking` with every field `agent` locks taken out,
 * so the call runs as if it had passed none of them, and the notice for those
 * it passed with a value other than `locked`, the value the lock keeps (the
 * file's, or the parent's when the file sets none). A locked field passed with
 * that value is no override: it is dropped quietly.
 */
export function withoutLocked<T extends { model?: string; thinking?: string }>(
	agent: Agent,
	request: T,
	locked: { model?: string; thinking?: string },
): { request: T; notice?: string } {
	const passed = agent.locked.filter((key) => request[key] !== undefined);
	if (passed.length === 0) return { request };
	const kept = { ...request };
	for (const key of passed) delete kept[key];
	const refused = passed.filter((key) => request[key] !== locked[key]);
	if (refused.length === 0) return { request: kept };
	const given = refused.map((key) => `${key} ${request[key]}`).join(" and ");
	return {
		request: kept,
		notice: `Agent ${agent.name} locks ${refused.join(" and ")}, so the ${given} given ${refused.length > 1 ? "were" : "was"} not used.`,
	};
}

/**
 * The `delegateTools` setting in `<agent dir>/squire/settings.json`: tool
 * names or `*` patterns added to every delegate's tools, whether they come
 * from the agent's `tools` or the parent. Empty when unset or when the file
 * cannot be read or parsed (the worktree settings report that when a launch
 * needs them); a value that is not a list of names refuses the launch with
 * the file named.
 */
export function delegateTools(agentDir: string): string[] {
	const file = join(agentDir, "squire", "settings.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const value = (parsed as Record<string, unknown>).delegateTools;
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
		throw new Error(
			`invalid delegate tools settings ${file}: delegateTools must be a list of tool names or patterns, not ${JSON.stringify(value)}`,
		);
	}
	const names = value.map((entry: string) => entry.trim());
	const modifier = names.find((name) => name.startsWith("+") || name.startsWith("-"));
	if (modifier !== undefined)
		throw new Error(
			`invalid delegate tools settings ${file}: delegateTools entries are tool names; ${JSON.stringify(modifier)} starts with ${modifier[0]}, which is not accepted there`,
		);
	return names;
}

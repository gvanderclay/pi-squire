// The one reader of `<agent dir>/squire/settings.json`. Every Squire setting is
// read from the file at call time (nothing is cached, so a change applies to
// the next launch) and validated here. A missing file means every default.
//
// What each key does when the file is unreadable, not JSON or not an object,
// and when its own value is invalid:
//
// | Keys | Broken file | Invalid value |
// | --- | --- | --- |
// | `multiplexer`, `windowPlacement`, `companionSuffix`, `maxDepth`, `maxConcurrentDelegates`, `maxDelegatesPerRoot`, `delegateTools`, `worktreeRoot`, `worktreeRootByRepo` | refuses, naming the file | refuses, naming the file |
// | `maxDepth` when only deciding whether to expose the delegation tools | depth 1: no nesting | refuses, naming the file |
// | `toolBundles` | disables each agent that uses a bundle, naming the file | the same |
// | `resultBodyKiB` | throws; the result warns and uses the default | the same |
// | `delegateWidgetPlacement`, `delegateWidgetMaxEntries` | throws; the widget warns once and uses defaults | the same |
//
// Worktree keys are read only for managed worktree creation; `resultBodyKiB`
// when a result arrives, where a refusal warns and uses the default because a
// claimed reply must still be handled; the widget keys only by the widget.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const squireSettingsFile = (agentDir: string): string => join(agentDir, "squire", "settings.json");

/** The file cannot be read, is not JSON, or its top level is not an object. */
export class SettingsFileError extends Error {}

type Read = { file: string; settings: Record<string, unknown> };

/** Read and parse the file once for this call; absent is `{}`. Throws {@link SettingsFileError}, naming the file. */
function read(agentDir: string): Read {
	const file = squireSettingsFile(agentDir);
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, settings: {} };
		throw new SettingsFileError(
			`could not read squire settings ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new SettingsFileError(`invalid squire settings ${file}: expected an object`);
	return { file, settings: parsed as Record<string, unknown> };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// --- multiplexer ---

export type Multiplexer = "tmux" | "herdr";

/** The explicit `multiplexer` setting, or undefined when absent (auto-detect). Refuses. */
export function multiplexerSetting(agentDir: string): Multiplexer | undefined {
	const { file, settings } = read(agentDir);
	const value = settings.multiplexer;
	if (value === undefined) return undefined;
	if (value === "tmux" || value === "herdr") return value;
	throw new Error(
		`invalid multiplexer settings ${file}: multiplexer must be "tmux" or "herdr", not ${JSON.stringify(value)}`,
	);
}

// --- window placement ---

export type WindowPlacement = "companion" | "current";
export const DEFAULT_COMPANION_SUFFIX = "delegates";
/** A tmux-safe name: ASCII letters, digits, `_` and `-`, with no edge hyphen. */
export const SAFE_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/;
/** A name that overlaps numbered companion alternatives. */
export const NUMBERED_ENDING = /(^|-)[0-9]+$/;

/** `windowPlacement` and `companionSuffix` for this call. Refuses. */
export function windowSettings(agentDir: string): { placement: WindowPlacement; companionSuffix: string } {
	const { file, settings } = read(agentDir);
	const { windowPlacement: placement = "companion", companionSuffix = DEFAULT_COMPANION_SUFFIX } = settings;
	if (placement !== "companion" && placement !== "current")
		throw new Error(
			`invalid window placement settings ${file}: windowPlacement must be "companion" or "current", not ${JSON.stringify(placement)}`,
		);
	if (
		typeof companionSuffix !== "string" ||
		companionSuffix.length > 32 ||
		!SAFE_NAME.test(companionSuffix) ||
		NUMBERED_ENDING.test(companionSuffix)
	)
		throw new Error(
			`invalid window placement settings ${file}: companionSuffix must be 1 to 32 ASCII letters, digits, underscores or hyphens, with no edge hyphen or numeric final segment, not ${JSON.stringify(companionSuffix)}`,
		);
	return { placement, companionSuffix };
}

// --- nesting depth and tree caps ---

function depthOf({ file, settings }: Read): number {
	const value = settings.maxDepth ?? 1;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`invalid maxDepth in ${file}: expected a positive integer`);
	return value;
}

/** `maxDepth` for admission: the deepest a delegation may be. Refuses. */
export function maxDepth(agentDir: string): number {
	return depthOf(read(agentDir));
}

/**
 * `maxDepth` for deciding whether to expose the delegation tools: a broken
 * file grants only the safe default of 1, since admission refuses it anyway;
 * an invalid value refuses.
 */
export function exposedDepth(agentDir: string): number {
	let current: Read;
	try {
		current = read(agentDir);
	} catch (error) {
		if (error instanceof SettingsFileError) return 1;
		throw error;
	}
	return depthOf(current);
}

export type TreeCaps = { maxConcurrentDelegates: number; maxDelegatesPerRoot: number };

/** The tree-wide launch budgets; malformed cap state must never silently become unlimited. Refuses. */
export function treeCaps(agentDir: string): TreeCaps {
	const current = read(agentDir);
	const nested: boolean = depthOf(current) > 1;
	const caps: TreeCaps = { maxConcurrentDelegates: nested ? 16 : 0, maxDelegatesPerRoot: nested ? 64 : 0 };
	for (const key of ["maxConcurrentDelegates", "maxDelegatesPerRoot"] as const) {
		const value: unknown = current.settings[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new Error(`invalid ${key} in ${current.file}: expected a nonnegative integer (0 means unlimited)`);
		caps[key] = value;
	}
	return caps;
}

// --- tools ---

/**
 * `delegateTools`: tool names or `*` patterns added to every delegate's tools.
 * Empty when unset; a value that is not a list of names, or an entry holding a
 * comma or starting with `+` or `-`, refuses.
 */
export function delegateTools(agentDir: string): string[] {
	const { file, settings } = read(agentDir);
	const value = settings.delegateTools;
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
		throw new Error(
			`invalid delegate tools settings ${file}: delegateTools must be a list of tool names or patterns, not ${JSON.stringify(value)}`,
		);
	}
	const names = value.map((entry: string) => entry.trim());
	const comma = names.find((name) => name.includes(","));
	if (comma !== undefined)
		throw new Error(
			`invalid delegate tools settings ${file}: delegateTools entry ${JSON.stringify(comma)} holds a comma; give one tool name or pattern per entry`,
		);
	const modifier = names.find((name) => name.startsWith("+") || name.startsWith("-"));
	if (modifier !== undefined)
		throw new Error(
			`invalid delegate tools settings ${file}: delegateTools entries are tool names; ${JSON.stringify(modifier)} starts with ${modifier[0]}, which is not accepted there`,
		);
	return names;
}

/** The `toolBundles` setting: tool lists by bundle name, or why the setting cannot be used. */
export type Bundles = { file: string; names: ReadonlyMap<string, readonly string[]>; problem?: string };

/** A bundle name: the same rule as an agent name. */
const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * `toolBundles`: named lists of tool names or `*` patterns an agent's `tools`
 * field names as `$name`. Empty when the file or setting is absent. A broken
 * file, a setting that is not an object of name lists, or a bundle entry that
 * holds a comma or starts with `+`, `-` or `$` (bundles do not nest), leaves no
 * bundles and says why; the roster disables each agent that uses one.
 */
export function toolBundles(agentDir: string): Bundles {
	const file = squireSettingsFile(agentDir);
	const none = (problem?: string): Bundles => ({ file, names: new Map(), ...(problem ? { problem } : {}) });
	let settings: Record<string, unknown>;
	try {
		settings = read(agentDir).settings;
	} catch (error) {
		if (error instanceof SettingsFileError) return none(`${error.message}, so its toolBundles cannot be read`);
		throw error;
	}
	const value = settings.toolBundles;
	if (value === undefined) return none();
	const invalid = (why: string): Bundles => none(`toolBundles in ${file} is invalid: ${why}`);
	if (!isObject(value)) return invalid("it must be an object of bundle names to lists of tool names");
	const names = new Map<string, string[]>();
	for (const [name, list] of Object.entries(value)) {
		if (!BUNDLE_NAME.test(name)) return invalid(`bundle name ${JSON.stringify(name)} is not letters, digits, _ or -`);
		if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string" && entry.trim() !== ""))
			return invalid(`bundle ${JSON.stringify(name)} must be a list of tool names or patterns`);
		const tools = list.map((entry: string) => entry.trim());
		const bad = tools.find((tool) => tool.includes(",") || /^[+\-$]/.test(tool));
		if (bad !== undefined)
			return invalid(
				`bundle ${JSON.stringify(name)} entry ${JSON.stringify(bad)} must be one tool name or pattern, with no comma and no leading +, - or $`,
			);
		names.set(name, tools);
	}
	return { file, names };
}

// --- worktree placement ---

export type WorktreeSettings = {
	file: string;
	worktreeRoot?: string;
	/** Repository keys exactly as written, each with its validated template. */
	worktreeRootByRepo: [key: string, template: string][];
};

export function worktreeSettingsError(file: string, problem: string): Error {
	return new Error(`invalid worktree placement settings ${file}: ${problem}`);
}

/** Validate a template, including overrides not selected by this launch. */
function validateTemplate(file: string, template: string): void {
	if (template.trim() === "") throw worktreeSettingsError(file, "templates must not be empty");
	const remainder = template.replace(/\{[^{}]*\}/g, (placeholder) => {
		const name = placeholder.slice(1, -1);
		if (name !== "branch" && name !== "repo" && name !== "repoParent") {
			throw worktreeSettingsError(file, `unknown template placeholder ${placeholder}`);
		}
		return "";
	});
	if (/[{}]/.test(remainder)) throw worktreeSettingsError(file, "templates contain an unmatched brace");
	if (!template.includes("{branch}")) throw worktreeSettingsError(file, "every template must contain {branch}");
}

/** `worktreeRoot` and `worktreeRootByRepo`, every template validated. Refuses. */
export function worktreeSettings(agentDir: string): WorktreeSettings {
	const { file, settings } = read(agentDir);
	const worktreeRoot = settings.worktreeRoot;
	if (worktreeRoot !== undefined && typeof worktreeRoot !== "string") {
		throw worktreeSettingsError(file, "worktreeRoot must be a string when provided");
	}
	if (typeof worktreeRoot === "string") validateTemplate(file, worktreeRoot);

	const byRepo = settings.worktreeRootByRepo;
	if (byRepo !== undefined && !isObject(byRepo)) {
		throw worktreeSettingsError(file, "worktreeRootByRepo must be an object when provided");
	}
	const overrides: [string, string][] = [];
	for (const [key, template] of Object.entries(byRepo ?? {})) {
		if (key === "") throw worktreeSettingsError(file, "repository override keys must not be empty");
		if (typeof template !== "string") {
			throw worktreeSettingsError(file, `worktreeRootByRepo[${JSON.stringify(key)}] must be a string`);
		}
		validateTemplate(file, template);
		overrides.push([key, template]);
	}
	return { file, ...(typeof worktreeRoot === "string" ? { worktreeRoot } : {}), worktreeRootByRepo: overrides };
}

// --- result body size ---

/** The default result body budget: 16 KiB, the first 4 KiB and the last 12 KiB. */
export const DEFAULT_RESULT_BODY_BYTES = 16 * 1024;

/**
 * `resultBodyKiB`: the UTF-8 byte budget for a delegate's reply in the result
 * message, a whole number of KiB from 4 to 64. Refuses an invalid value,
 * naming the file.
 */
export function resultBodyBytes(agentDir: string): number {
	const { file, settings } = read(agentDir);
	const value = settings.resultBodyKiB;
	if (value === undefined) return DEFAULT_RESULT_BODY_BYTES;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 4 || value > 64)
		throw new Error(
			`invalid resultBodyKiB in ${file}: expected a whole number of KiB from 4 to 64, not ${JSON.stringify(value)}`,
		);
	return value * 1024;
}

// --- widget (cosmetic) ---

export type WidgetSettings = { placement: "aboveEditor" | "belowEditor"; maxEntries: number };
export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = { placement: "aboveEditor", maxEntries: 3 };

/** The delegate widget's settings. Throws, naming the file; the widget warns and uses the defaults. */
export function widgetSettings(agentDir: string): WidgetSettings {
	const { file, settings } = read(agentDir);
	const placement: unknown =
		settings.delegateWidgetPlacement === undefined ? "above" : settings.delegateWidgetPlacement;
	const cap: unknown = settings.delegateWidgetMaxEntries === undefined ? 3 : settings.delegateWidgetMaxEntries;
	if (placement !== "above" && placement !== "below")
		throw new Error(`invalid delegateWidgetPlacement in ${file}: expected above or below`);
	if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0)
		throw new Error(`invalid delegateWidgetMaxEntries in ${file}: expected a nonnegative integer`);
	return { placement: placement === "above" ? "aboveEditor" : "belowEditor", maxEntries: cap };
}

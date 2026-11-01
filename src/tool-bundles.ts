// Tool bundles: named tool lists in `<agent dir>/squire/settings.json`
// `toolBundles`, which an agent's `tools` field names as `$name`. A bundle is
// only shorthand for tool names; it carries no permission rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A bundle name: the same rule as an agent name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Replace each `$name` entry with the tools of the `toolBundles` bundle it
 * names, keeping the first of any repeated name. An unknown bundle, or any
 * bundle while the setting is invalid, makes the file invalid.
 */
export function expandBundles(
	path: string,
	tools: string[],
	bundles: Bundles,
): { tools: string[]; toolsExcept: string[] } | { invalid: string } {
	const expanded: string[] = [];
	for (const entry of tools) {
		if (!entry.startsWith("$")) {
			expanded.push(entry);
			continue;
		}
		const names = bundles.names.get(entry.slice(1));
		if (names === undefined)
			return {
				invalid:
					bundles.problem === undefined
						? `${path} has tools entry ${JSON.stringify(entry)}, but toolBundles in ${bundles.file} defines no bundle ${JSON.stringify(entry.slice(1))}`
						: `${path} has tools entry ${JSON.stringify(entry)}, but ${bundles.problem}`,
			};
		expanded.push(...names);
	}
	return { tools: [...new Set(expanded)], toolsExcept: [] };
}

/** The `toolBundles` setting: tool lists by bundle name, or why the setting cannot be used. */
export type Bundles = { file: string; names: ReadonlyMap<string, readonly string[]>; problem?: string };

/**
 * The `toolBundles` setting in `<agent dir>/squire/settings.json`: named lists
 * of tool names or `*` patterns an agent's `tools` field names as `$name`.
 * Empty when the file or setting is absent. A setting that is not an object of
 * name lists, or a bundle entry that holds a comma or starts with `+`, `-` or
 * `$` (bundles do not nest), leaves no bundles and says why.
 */
export function toolBundles(agentDir: string): Bundles {
	const file = join(agentDir, "squire", "settings.json");
	const none = (problem?: string): Bundles => ({ file, names: new Map(), ...(problem ? { problem } : {}) });
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return none();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return none(`${file} is not valid JSON, so its toolBundles cannot be read`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return none();
	const value = (parsed as Record<string, unknown>).toolBundles;
	if (value === undefined) return none();
	const invalid = (why: string): Bundles => none(`toolBundles in ${file} is invalid: ${why}`);
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return invalid("it must be an object of bundle names to lists of tool names");
	const names = new Map<string, string[]>();
	for (const [name, list] of Object.entries(value)) {
		if (!NAME.test(name)) return invalid(`bundle name ${JSON.stringify(name)} is not letters, digits, _ or -`);
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

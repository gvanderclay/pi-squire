// Tool bundles: named tool lists in `<agent dir>/squire/settings.json`
// `toolBundles`, which an agent's `tools` field names as `$name`. A bundle is
// only shorthand for tool names; it carries no permission rules.
import type { Bundles } from "./settings.ts";

// The setting itself is read and validated by settings.ts.
export { type Bundles, toolBundles } from "./settings.ts";

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

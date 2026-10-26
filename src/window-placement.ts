// Call-time choice of where delegate windows open. `companion` (the default)
// opens them in a session of their own, `<parent's session>-squire`; `current`
// opens them in the parent's own session, as before. Read from
// `<agent dir>/squire/settings.json` at every launch, like `worktreeRoot`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type WindowPlacement = "companion" | "current";

/**
 * The placement for this call. An unknown value refuses with the file named.
 * A file that cannot be read or parsed is left to the worktree settings,
 * which report it when a launch needs them: it does not stop the launches
 * that never read it, so those keep the default.
 */
export function windowPlacement(agentDir: string): WindowPlacement {
	const file = join(agentDir, "squire", "settings.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return "companion";
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "companion";
	const value = (parsed as Record<string, unknown>).windowPlacement;
	if (value === undefined || value === "companion") return "companion";
	if (value === "current") return "current";
	throw new Error(
		`invalid window placement settings ${file}: windowPlacement must be "companion" or "current", not ${JSON.stringify(value)}`,
	);
}

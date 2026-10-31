// Call-time choice of where delegate windows open. `companion` (the default)
// opens them in a shared project session; `current`
// opens them in the parent's own session, as before. Read from
// `<agent dir>/squire/settings.json` at every launch, like `worktreeRoot`.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { inspectGit } from "./git.ts";

export type WindowPlacement = "companion" | "current";

/** The owning root's project, never the delegate's chosen working directory. */
export function placementProject(cwd: string): { companion: string; notices: string[] } {
	const git = inspectGit(cwd);
	const project = basename(git.kind === "git" ? git.identity.mainRoot : cwd);
	const normalized = project.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	return {
		companion: `${normalized}-delegate-session`,
		notices:
			git.kind === "unknown"
				? [
						`Could not inspect the root project for companion placement: ${git.reason}. Using the root working-directory basename ${JSON.stringify(basename(cwd))}.`,
					]
				: [],
	};
}

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

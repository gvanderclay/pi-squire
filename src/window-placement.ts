// Call-time choice of where delegate windows open. `companion` (the default)
// opens them in a shared project session named `<project>-<companionSuffix>`
// (default suffix `delegates`); `current` opens in the parent's own session. Read from
// `<agent dir>/squire/settings.json` at every launch, like `worktreeRoot`.
import { basename } from "node:path";

import { inspectGit } from "./git.ts";
import {
	DEFAULT_COMPANION_SUFFIX as DEFAULT_SUFFIX,
	NUMBERED_ENDING as numberedEnding,
	SAFE_NAME as safeName,
	type WindowPlacement,
	windowSettings,
} from "./settings.ts";

export { type WindowPlacement, windowSettings };

/** A preferred base, never a selected numbered companion or a tmux locator. */
export function assertRootPlacement(value: unknown): asserts value is string {
	if (typeof value !== "string" || !safeName.test(value) || !value.includes("-") || numberedEnding.test(value))
		throw new Error(
			"invalid or missing rootPlacement in delegation identity; original root companion preference is required",
		);
}

/** The owning root's project, never the delegate's chosen working directory. */
export function placementProject(cwd: string, suffix = DEFAULT_SUFFIX): { companion: string; notices: string[] } {
	const git = inspectGit(cwd);
	const project = basename(git.kind === "git" ? git.identity.mainRoot : cwd);
	const normalized = project.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
	return {
		companion: `${normalized}-${suffix}`,
		notices:
			git.kind === "unknown"
				? [
						`Could not inspect the root project for companion placement: ${git.reason}. Using the root working-directory basename ${JSON.stringify(basename(cwd))}.`,
					]
				: [],
	};
}

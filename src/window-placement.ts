// Call-time choice of where delegate windows open. `companion` (the default)
// opens them in a shared project session named `<project>-<companionSuffix>`
// (default suffix `delegates`); `current` opens in the parent's own session. Read from
// `<agent dir>/squire/settings.json` at every launch, like `worktreeRoot`.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { inspectGit } from "./git.ts";

export type WindowPlacement = "companion" | "current";

const safeName = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/;
const numberedEnding = /(^|-)[0-9]+$/;

/** A preferred base, never a selected numbered companion or a tmux locator. */
export function assertRootPlacement(value: unknown): asserts value is string {
	if (typeof value !== "string" || !safeName.test(value) || !value.includes("-") || numberedEnding.test(value))
		throw new Error(
			"invalid or missing rootPlacement in delegation identity; original root companion preference is required",
		);
}

/** The owning root's project, never the delegate's chosen working directory. */
export function placementProject(cwd: string, suffix = "delegates"): { companion: string; notices: string[] } {
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

/**
 * The placement for this call. An unknown value refuses with the file named.
 * This reader defaults malformed/unreadable files to companion; mandatory
 * tree-cap admission separately refuses those files for every launch/resume.
 */
export function windowSettings(agentDir: string): { placement: WindowPlacement; companionSuffix: string } {
	const file = join(agentDir, "squire", "settings.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return { placement: "companion", companionSuffix: "delegates" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return { placement: "companion", companionSuffix: "delegates" };
	const { windowPlacement: placement = "companion", companionSuffix = "delegates" } = parsed as Record<string, unknown>;
	if (placement !== "companion" && placement !== "current")
		throw new Error(
			`invalid window placement settings ${file}: windowPlacement must be "companion" or "current", not ${JSON.stringify(placement)}`,
		);
	if (
		typeof companionSuffix !== "string" ||
		companionSuffix.length > 32 ||
		!safeName.test(companionSuffix) ||
		numberedEnding.test(companionSuffix)
	)
		throw new Error(
			`invalid window placement settings ${file}: companionSuffix must be 1 to 32 ASCII letters, digits, underscores or hyphens, with no edge hyphen or numeric final segment, not ${JSON.stringify(companionSuffix)}`,
		);
	return { placement, companionSuffix };
}

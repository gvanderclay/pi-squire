// Call-time placement settings for managed worktrees. This module only
// chooses a destination; source, base, trust and lifecycle remain in the
// worktree plan and creation code.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { GitIdentity } from "./git.ts";
import { worktreeSettingsError as settingsError, squireSettingsFile, worktreeSettings } from "./settings.ts";

type Settings = {
	worktreeRoot?: string;
	worktreeRootByRepo: Map<string, string>;
};

const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Resolve existing symlink ancestors while retaining the not-yet-created suffix. */
function canonical(path: string): string {
	const rest: string[] = [];
	let current = resolve(path);
	while (!exists(current) && dirname(current) !== current) {
		rest.unshift(basename(current));
		current = dirname(current);
	}
	return join(realpathSync(current), ...rest);
}

/** Only a leading home marker is expanded; other tildes remain ordinary path characters. */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Canonicalize each repository key, refusing two that name the same checkout. */
function readOverrides(file: string, settingsDir: string, overrides: [string, string][]): Map<string, string> {
	const templates = new Map<string, string>();
	const originalKeys = new Map<string, string>();
	for (const [key, template] of overrides) {
		let canonicalKey: string;
		try {
			canonicalKey = canonical(resolve(settingsDir, expandHome(key)));
		} catch (err) {
			throw settingsError(file, `could not resolve repository key ${JSON.stringify(key)}: ${(err as Error).message}`);
		}
		const previousKey = originalKeys.get(canonicalKey);
		if (previousKey !== undefined) {
			throw settingsError(
				file,
				`ambiguous duplicate canonical repository key ${canonicalKey} (overrides ${JSON.stringify(previousKey)} and ${JSON.stringify(key)})`,
			);
		}
		originalKeys.set(canonicalKey, key);
		templates.set(canonicalKey, template);
	}
	return templates;
}

function readSettings(agentDir: string): Settings {
	const { file, worktreeRoot, worktreeRootByRepo } = worktreeSettings(agentDir);
	return {
		...(worktreeRoot === undefined ? {} : { worktreeRoot }),
		worktreeRootByRepo: readOverrides(file, dirname(file), worktreeRootByRepo),
	};
}

/** Choose and canonicalize the configured or built-in destination for this call. */
export function worktreeDestination(agentDir: string, identity: GitIdentity, branch: string): string {
	const settings = readSettings(agentDir);
	const settingsDir = join(agentDir, "squire");
	const override = settings.worktreeRootByRepo.get(identity.mainRoot);
	const template = override ?? settings.worktreeRoot ?? "{repoParent}/{repo}-worktrees/{branch}";
	const expanded = template.replace(/\{([^{}]+)\}/g, (_placeholder, name: string) => {
		switch (name) {
			case "repoParent":
				return dirname(identity.mainRoot);
			case "repo":
				return basename(identity.mainRoot);
			case "branch":
				return branch.replaceAll("/", "-");
			default:
				throw settingsError(squireSettingsFile(agentDir), `unknown template placeholder {${name}}`);
		}
	});
	return canonical(resolve(settingsDir, expandHome(expanded)));
}

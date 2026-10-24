// Call-time placement settings for managed worktrees. This module only
// chooses a destination; source, base, trust and lifecycle remain in the
// worktree plan and creation code.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import type { GitIdentity } from "./git.ts";

type Settings = {
	worktreeRoot?: string;
	worktreeRootByRepo: Map<string, string>;
};

const SETTINGS_NAME = "settings.json";
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsError(file: string, problem: string): Error {
	return new Error(`invalid worktree placement settings ${file}: ${problem}`);
}

/** Validate all templates, including overrides not selected by this launch. */
function validateTemplate(file: string, template: string): void {
	if (template.trim() === "") throw settingsError(file, "templates must not be empty");
	const remainder = template.replace(/\{[^{}]*\}/g, (placeholder) => {
		const name = placeholder.slice(1, -1);
		if (name !== "branch" && name !== "repo" && name !== "repoParent") {
			throw settingsError(file, `unknown template placeholder ${placeholder}`);
		}
		return "";
	});
	if (/[{}]/.test(remainder)) throw settingsError(file, "templates contain an unmatched brace");
	if (!template.includes("{branch}")) throw settingsError(file, "every template must contain {branch}");
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw settingsError(file, `could not read or parse the file: ${(err as Error).message}`);
	}
}

function readOverrides(
	file: string,
	settingsDir: string,
	value: Record<string, unknown> | undefined,
): Map<string, string> {
	const templates = new Map<string, string>();
	const originalKeys = new Map<string, string>();
	for (const [key, template] of Object.entries(value ?? {})) {
		if (key === "") throw settingsError(file, "repository override keys must not be empty");
		if (typeof template !== "string") {
			throw settingsError(file, `worktreeRootByRepo[${JSON.stringify(key)}] must be a string`);
		}
		validateTemplate(file, template);
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
	const file = join(agentDir, "squire", SETTINGS_NAME);
	const parsed = readJson(file);
	if (!isObject(parsed)) throw settingsError(file, "the top level must be an object");

	const worktreeRoot = parsed.worktreeRoot;
	if (worktreeRoot !== undefined && typeof worktreeRoot !== "string") {
		throw settingsError(file, "worktreeRoot must be a string when provided");
	}
	if (typeof worktreeRoot === "string") validateTemplate(file, worktreeRoot);

	const byRepo = parsed.worktreeRootByRepo;
	if (byRepo !== undefined && !isObject(byRepo)) {
		throw settingsError(file, "worktreeRootByRepo must be an object when provided");
	}
	return {
		...(typeof worktreeRoot === "string" ? { worktreeRoot } : {}),
		worktreeRootByRepo: readOverrides(file, dirname(file), byRepo),
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
				throw settingsError(join(settingsDir, SETTINGS_NAME), `unknown template placeholder {${name}}`);
		}
	});
	return canonical(resolve(settingsDir, expandHome(expanded)));
}

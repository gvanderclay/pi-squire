import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { maxDepth } from "./identity.ts";

export type TreeCaps = { maxConcurrentDelegates: number; maxDelegatesPerRoot: number };

/** Call-time settings; malformed cap state must never silently become unlimited. */
export function treeCaps(): TreeCaps {
	const file: string = join(getAgentDir(), "squire", "settings.json");
	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error(`could not read tree caps in ${file}: ${String(error)}`);
		settings = {};
	}
	if (!settings || typeof settings !== "object" || Array.isArray(settings))
		throw new Error(`invalid tree caps in ${file}: expected an object`);
	const nested: boolean = maxDepth() > 1;
	const caps: TreeCaps = { maxConcurrentDelegates: nested ? 16 : 0, maxDelegatesPerRoot: nested ? 64 : 0 };
	for (const key of ["maxConcurrentDelegates", "maxDelegatesPerRoot"] as const) {
		const value: unknown = settings[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new Error(`invalid ${key} in ${file}: expected a nonnegative integer (0 means unlimited)`);
		caps[key] = value;
	}
	return caps;
}

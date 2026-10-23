import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { StartedRecorded } from "./result-types.ts";

/** The delegate session file in a directory, found by its `_<id>.jsonl` suffix. */
export function findSession(dir: string | undefined, id: string): string | undefined {
	if (dir === undefined) return undefined;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	const name = names.find((candidate) => candidate.endsWith(`_${id}.jsonl`));
	return name === undefined ? undefined : join(dir, name);
}
/** Use a recorded absolute session path, otherwise search its recorded session directory. */
export function locateSession(record: StartedRecorded, fallbackDir: string | undefined): string | undefined {
	const known = record.sessionPath ?? record.result?.sessionPath;
	if (known !== undefined) return known;
	const found = findSession(record.sessionDir ?? fallbackDir, record.id);
	if (found !== undefined && isAbsolute(found)) record.sessionPath = found;
	return found;
}
/** The provider/model of the last assistant message in the delegate session, if available. */
export function finishedModel(sessionPath: string | undefined): string | undefined {
	if (sessionPath === undefined) return undefined;
	let lines: string[];
	try {
		lines = readFileSync(sessionPath, "utf8").split("\n");
	} catch {
		return undefined;
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: { type?: unknown; message?: { role?: unknown; provider?: unknown; model?: unknown } };
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const message = entry?.message;
		if (entry?.type !== "message" || message?.role !== "assistant") continue;
		if (typeof message.provider === "string" && typeof message.model === "string")
			return `${message.provider}/${message.model}`;
	}
	return undefined;
}

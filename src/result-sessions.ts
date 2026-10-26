import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { StartedRecorded } from "./result-types.ts";

/**
 * The Pi session id a delegation's mail, replies, usage-limit marks and file
 * name use. A resumed delegation has its own id but reopens the first one's
 * session; records from before resuming have no `sessionId`, and it is their `id`.
 */
export function sessionIdOf(record: { id: string; sessionId?: string }): string {
	return record.sessionId ?? record.id;
}

/** The delegate session file in a directory, found by its `_<id>.jsonl` suffix, `id` being a session id. */
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
	const found = findSession(record.sessionDir ?? fallbackDir, sessionIdOf(record));
	if (found !== undefined && isAbsolute(found)) record.sessionPath = found;
	return found;
}
/** How much of a session file's start is read to find its header line. */
const HEADER_BYTES = 64 * 1024;

/** The working directory a session file's header stores, which Pi runs the session in; undefined when the file or the field is missing. */
export function sessionHeaderCwd(sessionPath: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(sessionPath, "r");
	} catch {
		return undefined;
	}
	try {
		const buffer = Buffer.alloc(HEADER_BYTES);
		const text = buffer.subarray(0, readSync(fd, buffer, 0, HEADER_BYTES, 0)).toString("utf8");
		const header = JSON.parse(text.split("\n", 1)[0]) as { type?: unknown; cwd?: unknown };
		return header.type === "session" && typeof header.cwd === "string" && header.cwd !== "" ? header.cwd : undefined;
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
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

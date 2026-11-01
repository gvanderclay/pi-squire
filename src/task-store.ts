// Independent of Pi's transcript buffering: a task can arrive before its first
// assistant message. Atomic replacement preserves either the old or new outbox.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TaskState } from "./task-settlement.ts";

export function taskStatePath(session: string): string {
	return join(getAgentDir(), "squire", "task-replies", `${encodeURIComponent(session)}.json`);
}

export function readTaskState(path: string): TaskState | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TaskState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function writeTaskState(path: string, state: TaskState): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary: string = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
	renameSync(temporary, path);
}

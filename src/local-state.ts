// Atomic session-local records independent of Pi's transcript buffering.
// This is not a cross-process registry or a lock; duplicate-open arbitration
// belongs to the tree restoration layer.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readState<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function writeState(path: string, state: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
	renameSync(temporary, path);
}

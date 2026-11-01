// Lamport bakery mutex over atomic local-filesystem files. Each contender owns
// a unique path: dead-owner cleanup never unlinks a successor's lock. There is
// no time lease; a paused/live owner cannot be evicted. Transactions are sync.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readState, writeState } from "./local-state.ts";

type Ticket = { pid: number; choosing: boolean; number: number };
const pause: Int32Array = new Int32Array(new SharedArrayBuffer(4));

/** PID reuse conservatively looks live; only ESRCH proves absence. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function remove(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function tickets(dir: string): [string, Ticket][] {
	const found: [string, Ticket][] = [];
	for (const name of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const path: string = join(dir, name);
		const ticket: Ticket | undefined = readState<Ticket>(path);
		if (ticket === undefined) continue;
		if (
			!Number.isSafeInteger(ticket.pid) ||
			ticket.pid < 1 ||
			!Number.isSafeInteger(ticket.number) ||
			ticket.number < 0 ||
			typeof ticket.choosing !== "boolean"
		)
			throw new Error(`invalid tree lock ticket ${path}; admission blocked`);
		if (!processAlive(ticket.pid)) remove(path);
		else found.push([name, ticket]);
	}
	return found;
}

/** No async work inside: other calls in this process cannot deadlock on us. */
export function withTreeLock<T>(dir: string, work: () => T, timeoutMs = 5000): T {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const name: string = `${process.pid}-${randomUUID()}.json`;
	const path: string = join(dir, name);
	const ticket: Ticket = { pid: process.pid, choosing: true, number: 0 };
	writeState(path, ticket);
	try {
		ticket.number = 1 + Math.max(0, ...tickets(dir).map(([, item]) => item.number));
		if (!Number.isSafeInteger(ticket.number)) throw new Error("tree lock ticket overflow");
		ticket.choosing = false;
		writeState(path, ticket);
		const deadline: number = Date.now() + timeoutMs;
		while (
			tickets(dir).some(
				([other, item]) =>
					other !== name &&
					(item.choosing || item.number < ticket.number || (item.number === ticket.number && other < name)),
			)
		) {
			if (Date.now() >= deadline) throw new Error("tree registry is busy; retry the operation (no launch was queued)");
			Atomics.wait(pause, 0, 0, 5);
		}
		return work();
	} finally {
		remove(path);
	}
}

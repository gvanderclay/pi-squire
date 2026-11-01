// Disposable native-title mirror for unflushed / --no-session runtimes.
// No membership, hierarchy, task state, ownership lock or activity lives here.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeState } from "./local-state.ts";

type Mirror = { version: 1; sessionId: string; generation: string; pid: number; start: string; name: string };
const MAX_BYTES = 16 * 1024;

function processStart(pid: number): string | undefined {
	try {
		const value: string = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1000,
			// Compare identical formatting even across differently configured tmux environments.
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

export function titleMirrorPath(sessionId: string): string {
	const key: string = createHash("sha256").update(sessionId).digest("hex");
	return join(getAgentDir(), "squire", "session-titles", `${key}.json`);
}

function readMirror(sessionId: string): Mirror | undefined {
	try {
		const file: string = titleMirrorPath(sessionId);
		if (statSync(file).size > MAX_BYTES) return undefined;
		const value: Partial<Mirror> = JSON.parse(readFileSync(file, "utf8"));
		if (
			value.version !== 1 ||
			value.sessionId !== sessionId ||
			typeof value.name !== "string" ||
			typeof value.generation !== "string" ||
			!Number.isSafeInteger(value.pid) ||
			typeof value.start !== "string"
		)
			return undefined;
		return value as Mirror;
	} catch {
		return undefined;
	}
}

/** Positive checks expire without sliding on reads; title edits themselves are never cached. */
export const TITLE_LIVENESS_CACHE_MS = 5000;
type Verdict = { matches: boolean; expires: number };
type MirrorChecks = { now: () => number; start: (pid: number) => string | undefined };

export class WidgetTitleMirrors {
	private readonly checks: MirrorChecks;
	private readonly verdicts = new Map<string, Verdict>();

	constructor(checks: Partial<MirrorChecks> = {}) {
		this.checks = { now: (): number => performance.now(), start: processStart, ...checks };
	}

	clear(): void {
		this.verdicts.clear();
	}

	read(sessionId: string): string | undefined {
		const value: Mirror | undefined = readMirror(sessionId);
		// An empty mirror can only fall back to recorded identity; never spawn ps for it.
		if (!value?.name) return undefined;
		const key: string = JSON.stringify([value.pid, value.start]);
		const now: number = this.checks.now();
		let verdict: Verdict | undefined = this.verdicts.get(key);
		if (!verdict || now >= verdict.expires) {
			verdict = { matches: this.checks.start(value.pid) === value.start, expires: now + TITLE_LIVENESS_CACHE_MS };
			this.verdicts.set(key, verdict);
		}
		return verdict.matches ? value.name : undefined;
	}
}

const titleMirrors = new WidgetTitleMirrors();
export function mirroredTitle(sessionId: string): string | undefined {
	return titleMirrors.read(sessionId);
}

/** Best effort only. Runtime generations prevent old shutdown from removing a replacement. */
export function titlePublisher(sessionId: string): { publish(name: string | undefined): void; stop(): void } {
	const generation: string = randomUUID();
	const start: string | undefined = processStart(process.pid);
	return {
		publish(name: string | undefined): void {
			if (!start) return;
			try {
				writeState(titleMirrorPath(sessionId), {
					version: 1,
					sessionId,
					generation,
					pid: process.pid,
					start,
					name: (name ?? "").slice(0, 2048),
				} satisfies Mirror);
			} catch {
				/* Title availability must never affect a delegated task. */
			}
		},
		stop(): void {
			try {
				if (readMirror(sessionId)?.generation === generation) unlinkSync(titleMirrorPath(sessionId));
			} catch {
				/* Already absent or unavailable. */
			}
		},
	};
}

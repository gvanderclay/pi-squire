// Private disposable telemetry, never a registry, owner lock or result store.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, opendir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Activity, activityText } from "./widget-activity.ts";
import { type Liveness, processLiveness, processStart } from "./widget-live-process.ts";

export const LIVE_LAUNCH_ENV = "PI_SQUIRE_LIVE_LAUNCH";
export const LIVE_MAX_BYTES = 8192;
export const LIVE_MAX_GENERATIONS = 16;
type Seed = { version: 1; sessionId: string; launchId: string };
type Snapshot = {
	version: 1;
	sessionId: string;
	launchId?: string;
	generation: string;
	pid: number;
	processStart: string;
	revision: number;
	observedAt: number;
	activity: Activity | null;
};

export function liveLaunch(seed: string | undefined, sessionId: string): string | undefined {
	try {
		if (!seed || seed.length > 4096) return;
		const value: Partial<Seed> = JSON.parse(seed);
		if (value.version === 1 && value.sessionId === sessionId && validString(value.launchId)) return value.launchId;
	} catch {
		// Missing/invalid launch correlation is unavailable, never inferred from stable identity.
	}
	return;
}

function validString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512;
}

export function liveSessionDir(sessionId: string, agentDir = getAgentDir()): string {
	return join(agentDir, "squire", "live-sessions", createHash("sha256").update(sessionId).digest("hex"));
}

async function remove(path: string): Promise<void> {
	await unlink(path).catch(() => {});
}

function validActivity(value: unknown): value is Activity | null {
	if (value === null) return true;
	if (!value || typeof value !== "object") return false;
	const activity = value as Partial<Activity>;
	return (
		(activity.kind === "tools" || activity.kind === "response") &&
		typeof activity.text === "string" &&
		Buffer.byteLength(activity.text) <= 512
	);
}

function validSnapshot(value: Partial<Snapshot>, sessionId: string, generation: string): value is Snapshot {
	return (
		value.version === 1 &&
		value.sessionId === sessionId &&
		value.generation === generation &&
		validString(value.sessionId) &&
		(value.launchId === undefined || validString(value.launchId)) &&
		Number.isSafeInteger(value.pid) &&
		(value.pid ?? 0) > 0 &&
		validString(value.processStart) &&
		Number.isSafeInteger(value.revision) &&
		(value.revision ?? -1) >= 0 &&
		typeof value.observedAt === "number" &&
		Number.isFinite(value.observedAt) &&
		validActivity(value.activity)
	);
}

async function readSnapshot(path: string, sessionId: string, generation: string): Promise<Snapshot | undefined> {
	try {
		const file = await open(path, "r");
		try {
			const buffer = Buffer.alloc(LIVE_MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > LIVE_MAX_BYTES) return;
			const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
			if (value && typeof value === "object" && validSnapshot(value, sessionId, generation)) return value;
		} finally {
			await file.close();
		}
	} catch {
		// Optional metadata is unavailable.
	}
	return;
}

type Probe = (owner: { pid: number; processStart: string }) => Promise<Liveness>;

export class LiveActivityReader {
	private readonly agentDir: string;
	private readonly probe: Probe;

	constructor(agentDir = getAgentDir(), probe: Probe = processLiveness) {
		this.agentDir = agentDir;
		this.probe = probe;
	}

	async read(sessionId: string, launchId: string): Promise<Activity | undefined> {
		try {
			// Cheap absence fast path preserves prompt initial rows; never negatively cache first publication.
			if (!existsSync(liveSessionDir(sessionId, this.agentDir))) return;
			return await this.readSession(sessionId, launchId);
		} catch {
			return;
		}
	}

	private async readSession(sessionId: string, launchId: string): Promise<Activity | undefined> {
		const dir: string = liveSessionDir(sessionId, this.agentDir);
		const directory = await opendir(dir);
		const live: Snapshot[] = [];
		let entries = 0;
		let uncertain = false;
		for await (const entry of directory) {
			if (++entries > LIVE_MAX_GENERATIONS) return;
			if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/.test(entry.name)) continue;
			const generation: string = entry.name.slice(0, -5);
			const path: string = join(dir, entry.name);
			const value: Snapshot | undefined = await readSnapshot(path, sessionId, generation);
			if (!value) {
				uncertain = true;
				continue;
			}
			const verdict: Liveness = await this.probe(value);
			if (verdict === "dead") await remove(path);
			else if (verdict === "live") live.push(value);
			else uncertain = true;
		}
		if (uncertain || live.length !== 1) return;
		return this.project(live[0], launchId);
	}

	private project(value: Snapshot, launchId: string): Activity | undefined {
		if (value.launchId !== launchId || !value.activity) return;
		const text: string = activityText(value.activity.text);
		return text ? { kind: value.activity.kind, text } : undefined;
	}
}

type PublisherOptions = {
	start?: () => Promise<string | undefined>;
	rename?: typeof rename;
};

/** At most one pending snapshot and one in-flight write; stop never blocks task delivery. */
export class LiveActivityPublisher {
	readonly generation: string = randomUUID();
	private readonly sessionId: string;
	private readonly launchId: string | undefined;
	private readonly dir: string;
	private readonly path: string;
	private readonly temporary: string;
	private readonly start: Promise<string | undefined>;
	private readonly replace: typeof rename;
	private activity: Activity | null = null;
	private revision = 0;
	private observedAt = Date.now();
	private dirty = false;
	private urgent = false;
	private lastWrite = 0;
	private stopped = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private writing: Promise<void> | undefined;

	constructor(sessionId: string, launchId?: string, options: PublisherOptions = {}) {
		this.sessionId = sessionId;
		this.launchId = launchId;
		this.dir = liveSessionDir(sessionId);
		this.path = join(this.dir, `${this.generation}.json`);
		this.temporary = `${this.path}.tmp`;
		this.start = (options.start ?? ((): Promise<string | undefined> => processStart(process.pid)))().catch(
			() => undefined,
		);
		this.replace = options.rename ?? rename;
	}

	publish(activity: Activity | undefined, immediate = true): void {
		if (this.stopped) return;
		this.activity = activity ? { kind: activity.kind, text: activityText(activity.text) } : null;
		this.revision++;
		this.observedAt = Date.now();
		this.dirty = true;
		this.urgent ||= immediate;
		if (immediate && this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.schedule();
	}

	private schedule(): void {
		if (this.stopped || !this.dirty || this.timer || this.writing) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.flush();
			},
			this.urgent ? 0 : Math.max(0, 250 - (Date.now() - this.lastWrite)),
		);
		this.timer.unref();
	}

	async flush(): Promise<void> {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.writing) return this.writing;
		this.writing = this.drain().finally(() => {
			this.writing = undefined;
			this.schedule();
		});
		return this.writing;
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.dirty = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		void this.closed();
	}

	async closed(): Promise<void> {
		await this.writing;
		if (this.stopped) await Promise.all([remove(this.path), remove(this.temporary)]);
	}

	private async drain(): Promise<void> {
		const start: string | undefined = await this.start;
		if (!start || this.stopped) {
			this.dirty = false;
			return;
		}
		if (this.dirty && !this.stopped) {
			this.dirty = false;
			this.urgent = false;
			this.lastWrite = Date.now();
			const snapshot: Snapshot = {
				version: 1,
				sessionId: this.sessionId,
				launchId: this.launchId,
				generation: this.generation,
				pid: process.pid,
				processStart: start,
				revision: this.revision,
				observedAt: this.observedAt,
				activity: this.activity,
			};
			await this.write(snapshot);
		}
	}

	private async write(snapshot: Snapshot): Promise<void> {
		try {
			const json: string = JSON.stringify(snapshot);
			if (Buffer.byteLength(json) > LIVE_MAX_BYTES) return;
			await mkdir(this.dir, { recursive: true, mode: 0o700 });
			await writeFile(this.temporary, json, { mode: 0o600 });
			if (!this.stopped) await this.replace(this.temporary, this.path);
		} catch {
			await remove(this.path);
		} finally {
			await remove(this.temporary);
		}
	}
}

// Read-only direct-child adapter. Results remains the task/result authority.
// Rows are keyed by native session id, never by a mutable title or launch id.
import { isStarted, locateSession, type Results, recordedName, type StartedRecorded, sessionIdOf } from "./results.ts";
import type { TmuxWindow } from "./tmux.ts";
import type { Activity } from "./widget-activity.ts";
import { WidgetTitleMirrors } from "./widget-title.ts";
import { WidgetTitleFiles } from "./widget-title-file.ts";
import { windowState } from "./windows.ts";

export type DelegateRow = {
	key: string;
	sessionId: string;
	launchId: string;
	identity: string;
	title: string | undefined;
	state: string;
	running: boolean;
	window: "open" | "gone" | "unknown";
	model: string;
	/** Transcript mtime is a last-active hint, not proof of tool activity. */
	lastActive: number | undefined;
	activity?: Activity;
};

/** All eligible rows remain available; only this viewport incurs metadata I/O. */
export type MetadataViewport = { offset: number; limit: number };
type Metadata = {
	titles: Pick<WidgetTitleFiles, "read" | "clear">;
	mirrors: Pick<WidgetTitleMirrors, "read" | "clear">;
	locate: typeof locateSession;
};
type Located = { locator: string; path: string };
type Entry = { record: StartedRecorded; row: DelegateRow };

function candidates(results: Results): StartedRecorded[] {
	const sessions = new Map<string, StartedRecorded>();
	for (const record of results.list()) {
		if (!isStarted(record)) continue;
		const key: string = sessionIdOf(record);
		sessions.delete(key);
		sessions.set(key, record);
	}
	return [...sessions.values()].reverse().filter((record) => !record.closed && (!record.gone || record.result));
}

/** Independently refreshable metadata cache, with no writes to Results or shared accounting. */
export class DirectDelegateView {
	private readonly metadata: Metadata;
	private readonly paths = new Map<string, Located>();

	constructor(metadata: Partial<Metadata> = {}) {
		this.metadata = {
			titles: new WidgetTitleFiles(),
			mirrors: new WidgetTitleMirrors(),
			locate: locateSession,
			...metadata,
		};
	}

	clear(): void {
		this.metadata.titles.clear();
		this.metadata.mirrors.clear();
		this.paths.clear();
	}

	needsWindows(results: Results): boolean {
		return candidates(results).length > 0;
	}

	read(
		results: Results,
		windows: TmuxWindow[] | undefined,
		sessionDir: string | undefined,
		viewport: MetadataViewport = { offset: 0, limit: 3 },
	): DelegateRow[] {
		const running: Set<string> = new Set(results.running().map((record) => record.id));
		const entries: Entry[] = [];
		for (const record of candidates(results)) {
			const window = windowState(windows, record);
			const working: boolean = running.has(record.id);
			if (window === "gone" || (!working && (!record.result || window !== "open"))) continue;
			entries.push({ record, row: this.row(record, working, window) });
		}
		const ordered: Entry[] = [
			...entries.filter(({ row }) => row.running),
			...entries.filter(({ row }) => !row.running),
		];
		return ordered.map(({ record, row }, index) => {
			if (index >= viewport.offset && index < viewport.offset + viewport.limit) this.enrich(record, row, sessionDir);
			return row;
		});
	}

	private row(record: StartedRecorded, running: boolean, window: DelegateRow["window"]): DelegateRow {
		const sessionId: string = sessionIdOf(record);
		return {
			key: sessionId,
			sessionId,
			launchId: record.id,
			identity: recordedName(record),
			title: undefined,
			lastActive: undefined,
			state: running ? "running" : (record.result?.status ?? "unknown"),
			running,
			window,
			model: record.result?.finishedModel ?? record.model,
		};
	}

	private path(record: StartedRecorded, sessionDir: string | undefined): string | undefined {
		const locator: string = JSON.stringify([
			sessionIdOf(record),
			record.sessionPath,
			record.result?.sessionPath,
			record.sessionDir,
			sessionDir,
		]);
		const cached: Located | undefined = this.paths.get(record.id);
		if (cached?.locator === locator) return cached.path;
		const path: string | undefined = this.metadata.locate({ ...record }, sessionDir);
		if (path) this.paths.set(record.id, { locator, path });
		else this.paths.delete(record.id); // No negative cache: first transcript flush must become discoverable.
		return path;
	}

	private enrich(record: StartedRecorded, row: DelegateRow, sessionDir: string | undefined): void {
		const disk = this.metadata.titles.read(this.path(record, sessionDir), row.sessionId);
		if (!disk) this.paths.delete(record.id); // Missing/replaced/mismatched files are rediscovered next refresh.
		const name: string | undefined = disk?.name ?? this.metadata.mirrors.read(row.sessionId);
		row.title = name && name !== row.identity ? name : undefined;
		row.lastActive = disk?.modified;
	}
}

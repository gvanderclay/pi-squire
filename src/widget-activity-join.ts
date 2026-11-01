import { isStarted, type Results, sessionIdOf } from "./results.ts";
import type { DelegateRow, MetadataViewport } from "./widget-data.ts";
import { LiveActivityReader } from "./widget-live.ts";

type Reader = Pick<LiveActivityReader, "read">;

/** Joins only a known viewport, never discovers membership or changes task facts. */
export async function joinActivities(
	rows: DelegateRow[],
	viewport: MetadataViewport,
	results: Results,
	reader: Reader = new LiveActivityReader(),
): Promise<void> {
	await Promise.all(
		rows.slice(viewport.offset, viewport.offset + viewport.limit).map(async (row) => {
			if (!row.running) return;
			row.activity = await reader.read(row.sessionId, row.launchId).catch(() => undefined);
			// A terminal result/close/new launch may have arrived during I/O.
			const current = results.running().find((record) => record.id === row.launchId);
			const latest = results.list().findLast((record) => isStarted(record) && sessionIdOf(record) === row.sessionId);
			if (!current || latest?.id !== row.launchId) row.activity = undefined;
		}),
	);
}

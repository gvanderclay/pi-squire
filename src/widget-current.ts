// Optional live-window overrides for known local children, never semantic rewrites.
import { isStarted, type Results, type StartedRecorded, sessionIdOf } from "./results.ts";
import type { PaneLocator, TmuxClient, TmuxWindow } from "./tmux.ts";
import type { LiveActivityReader, LiveLocator } from "./widget-live.ts";

export async function currentChildWindows(
	results: Results,
	tmux: TmuxClient,
	windows: TmuxWindow[] | undefined,
	reader: LiveActivityReader,
): Promise<Map<string, { windowId: string; windowName: string }>> {
	const found: Map<string, { windowId: string; windowName: string }> = new Map();
	if (!windows?.length || !tmux.inspectPane) return found;
	const latest: Map<string, StartedRecorded> = new Map(
		results
			.list()
			.filter(isStarted)
			.map((record) => [sessionIdOf(record), record]),
	);
	const candidates: StartedRecorded[] = [...latest.values()].filter((record) => !record.closed);
	if (!candidates.length) return found;
	const own: PaneLocator | undefined = await tmux.inspectPane().catch(() => undefined);
	if (!own) return found;
	await Promise.all(
		candidates.map(async (record): Promise<void> => {
			const live: LiveLocator | undefined = await reader.locator(sessionIdOf(record));
			if (
				!live ||
				live.locator.socket !== own.socket ||
				live.locator.serverPid !== own.serverPid ||
				live.locator.serverStarted !== own.serverStarted
			)
				return;
			const pane: PaneLocator | undefined = await tmux.inspectPane?.(live.locator.paneId).catch(() => undefined);
			if (!pane || pane.exited || JSON.stringify(pane) !== JSON.stringify(live.locator)) return;
			if (windows.some((window) => window.id === pane.windowId && window.name === pane.windowName))
				found.set(record.id, { windowId: pane.windowId, windowName: pane.windowName });
		}),
	);
	return found;
}

// Delegation tracking: the poll that notices a delegate's window going away,
// and the `delegation_status` and `delegation_close` tools. A delegation's
// state comes from `results.ts` (`deriveState`); this module only asks tmux
// about the window and words what it is told.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type Mark, readMarks } from "./limits.ts";
import {
	type DelegationState,
	deriveState,
	findSession,
	type Recorded,
	type Results,
	recordedName,
	type WindowState,
} from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";

/** The hook a tick emits so the provider claims waiting replies before windows are checked. */
const SCAN = "message:scan";
/** How often the parent checks its running delegations. */
const POLL_MS = 5000;

/** What `src/index.ts` needs from tracking. */
export type Tracking = {
	/** Register `delegation_status` and `delegation_close`. */
	registerTools(): void;
	/** Start the poll when something is running. */
	startPolling(): void;
	/** On `session_start`: rebuild the records and restart the poll. */
	restore(ctx: ExtensionContext): void;
	/** On `session_shutdown`: stop the poll, and declare nothing more. */
	stop(): void;
};

/** The one result every tool returns. */
export function toolResult(
	payload: string,
	details: unknown = {},
): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: payload }], details };
}

/** A tool as registered; `execute` takes the tool's own parameters, which the registration call does not check. */
type ToolDef = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (...args: never[]) => Promise<ReturnType<typeof toolResult>>;
};

/** Every window on the server, asked once; a failed ask is `undefined`, never an empty list. */
async function listWindows(tmux: TmuxClient): Promise<TmuxWindow[] | undefined> {
	try {
		return await tmux.listWindows();
	} catch {
		return undefined;
	}
}

/** The window a delegation owns: one with both its recorded id and its recorded name, since ids restart with every tmux server. */
function ownWindow(windows: TmuxWindow[], record: Recorded): TmuxWindow | undefined {
	return windows.find((window) => window.id === record.windowId && window.name === record.windowName);
}

/** What the listing says about a delegation's window; a matching window whose program exited counts as gone. */
function windowState(windows: TmuxWindow[] | undefined, record: Recorded): WindowState {
	if (windows === undefined) return "unknown";
	const own = ownWindow(windows, record);
	return own !== undefined && !own.exited ? "open" : "gone";
}

/** Records from before auto-exit existed kept their windows open, so they read off. */
function autoExitLine(record: Recorded): string {
	return record.autoExit === true
		? "on — the delegate closes its window after a normal completion unless the user took over there"
		: "off — the window stays open after the result";
}

/** The state, worded for the `state:` line. */
function stateLine(state: DelegationState, record: Recorded): string {
	switch (state) {
		case "running":
			return "running — the window is open and no result has arrived";
		case "gone":
			return "closed without a result — the window is gone and no reply arrived; a late reply would make it done";
		case "done":
			return `done — result status: ${record.result?.status ?? "unknown"}`;
		case "closed":
			return "closed — delegation_close recorded it";
		case "window-closed":
			return "closed — the window is gone";
		case "unknown":
			return "unknown — tmux could not be asked whether the window is open";
	}
}

/** One delegation as `delegation_status` reports it; its text and details both read from this. */
type View = { record: Recorded; state: DelegationState; name: string; sessionPath: string | undefined };

/** The view of a delegation: its state and the fields the text and details share. */
function view(record: Recorded, windows: TmuxWindow[] | undefined, ctx: ExtensionContext): View {
	const state = deriveState(record, windowState(windows, record));
	const sessionPath = record.result?.sessionPath ?? findSession(ctx.sessionManager.getSessionDir(), record.id);
	return { record, state, name: recordedName(record), sessionPath };
}

/** The text block for one delegation. */
function viewText({ record, state, name, sessionPath }: View): string {
	const lines = [
		`${record.id} ${record.agent} (${record.model}, thinking ${record.thinking})`,
		`  name: ${name}`,
		`  state: ${stateLine(state, record)}`,
		`  window: ${record.windowName} (${record.windowId})`,
		`  auto-exit: ${autoExitLine(record)}`,
		`  session: ${sessionPath ?? `${record.id} (no session file yet)`}`,
	];
	if (record.result !== undefined) lines.push(`  envelope: ${record.result.envelopePath}`);
	return lines.join("\n");
}

/** The structured details for one delegation. */
function viewDetails({ record, name, sessionPath }: View): Record<string, unknown> {
	return {
		id: record.id,
		name,
		agent: record.agent,
		model: record.model,
		thinking: record.thinking,
		autoExit: record.autoExit === true,
		windowId: record.windowId,
		windowName: record.windowName,
		closed: record.closed === true,
		closedWithoutResult: record.gone === true && record.result === undefined && record.closed !== true,
		status: record.result?.status,
		envelopePath: record.result?.envelopePath,
		sessionPath,
	};
}

/** The usage-limit marks in force now, as `delegation_status` reports them. */
function activeMarks(): { scope: string; source: Mark["source"]; reason: string; clearsAt: string }[] {
	const now = Date.now();
	return readMarks(now)
		.filter((mark) => mark.clearsAt > now)
		.map(({ scope, source, reason, clearsAt }) => ({
			scope,
			source,
			reason: reason.length > 120 ? `${reason.slice(0, 119)}…` : reason,
			clearsAt: new Date(clearsAt).toISOString(),
		}));
}

/** Every delegation, or the one named; throws when a named id is unknown. */
function selectRecords(results: Results, id: string | undefined): Recorded[] {
	const all = results.list();
	const records = id === undefined ? all : all.filter((record) => record.id === id);
	if (id !== undefined && records.length === 0) {
		throw new Error(
			`no delegation ${JSON.stringify(id)}; known: ${all.map((record) => record.id).join(", ") || "none"}`,
		);
	}
	return records;
}

/** The poll over the records and tmux. `arm` readies it for a new session; `stop` ends it for good. */
function createPoll(
	pi: ExtensionAPI,
	results: Results,
	tmux: TmuxClient,
): { start(): void; stop(): void; arm(): void } {
	/** The poll timer; set only while some delegation is running. */
	let poll: ReturnType<typeof setInterval> | undefined;
	let ticking = false;
	/** False once the session shuts down, so a tick still awaiting tmux declares nothing. */
	let live = true;

	function stopPolling(): void {
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
	}

	/** Record gone each running delegation whose window is missing or exited; a failed list declares nothing. */
	function declareGone(windows: TmuxWindow[] | undefined): void {
		if (windows === undefined) return;
		for (const record of results.running()) {
			if (windowState(windows, record) !== "gone" || !live) continue;
			// A reply may have landed while the windows before this one were checked.
			pi.events.emit(SCAN, {});
			results.recordGone(record.id);
		}
	}

	/** Claim waiting replies first, then declare gone every delegation whose window is missing or exited with still no result. */
	async function tick(): Promise<void> {
		if (ticking) return;
		ticking = true;
		try {
			if (results.running().length === 0) return stopPolling();
			const scan: { scanned?: boolean } = {};
			pi.events.emit(SCAN, scan);
			if (scan.scanned !== true) return; // no message:* provider: a waiting reply cannot be ruled out
			declareGone(await listWindows(tmux)); // one ask per tick
			if (results.running().length === 0) stopPolling();
		} finally {
			ticking = false;
		}
	}

	/** Start the timer when something is running; it never keeps the process alive. */
	function startPolling(): void {
		if (poll !== undefined || results.running().length === 0) return;
		poll = setInterval(() => void tick(), POLL_MS);
		poll.unref?.();
	}

	return {
		start: startPolling,
		stop(): void {
			live = false;
			stopPolling();
		},
		arm(): void {
			stopPolling();
			live = true;
		},
	};
}

/** The `delegation_status` tool. */
function statusTool(results: Results, tmux: TmuxClient): ToolDef {
	return {
		name: "delegation_status",
		label: "Delegation status",
		description:
			"The delegations this session started, each reported as running (the window is open and no result has arrived yet), done (with the result envelope's status) or closed (closed with delegation_close, or its window is gone). A delegation whose window went with no reply is reported closed without a result until a late reply makes it done. Names the delegation id, agent, session name, model, thinking, window, delegate session path and result envelope path. A delegate's window being open means it is connected, not that its task is unfinished or finished; only a result means done.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "One delegation id; omit to report every delegation." })),
		}),
		async execute(
			_toolCallId: string,
			params: { id?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const records = selectRecords(results, params.id);
			const windows = await listWindows(tmux);
			const views = records.map((record) => view(record, windows, ctx));
			const marks = activeMarks();
			const details = { delegations: views.map(viewDetails), marks };
			const block =
				marks.length === 0
					? []
					: [
							`Usage-limit marks:\n${marks
								.map((m) => `- ${m.scope} (${m.source}) until ${m.clearsAt}: ${m.reason}`)
								.join("\n")}`,
						];
			const heading = `${views.length} delegation${views.length === 1 ? "" : "s"}:`;
			const parts =
				views.length === 0
					? ["No delegations are recorded in this session.", ...block]
					: [`${heading}\n\n${views.map(viewText).join("\n\n")}`, ...block];
			return toolResult(parts.join("\n\n"), details);
		},
	};
}

/** The `delegation_close` tool. */
function closeTool(results: Results, tmux: TmuxClient): ToolDef {
	return {
		name: "delegation_close",
		label: "Close delegation",
		description:
			"Close one delegation: kill its tmux window through tmux and record the close, so delegation_status reports it closed. The delegate's session file and result envelope stay on disk. An unknown or already closed id returns a message with nothing killed.",
		parameters: Type.Object({
			id: Type.String({ description: "The delegation id to close." }),
		}),
		async execute(
			_toolCallId: string,
			params: { id: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const [record] = selectRecords(results, params.id);
			if (record.closed === true)
				return toolResult(`Delegation ${record.id} is already closed.`, { id: record.id, closed: true });
			let windows: TmuxWindow[];
			try {
				windows = await tmux.listWindows();
			} catch (err) {
				throw new Error(`could not ask tmux about window ${record.windowName}: ${(err as Error).message}`);
			}
			// Only a window with the recorded id and name is ours, exited program or not.
			const alive = ownWindow(windows, record) !== undefined;
			if (alive) {
				try {
					await tmux.kill(record.windowId);
				} catch (err) {
					throw new Error(`could not kill window ${record.windowName} (${record.windowId}): ${(err as Error).message}`);
				}
			}
			results.recordClose(record.id);
			const how = alive
				? `killed window ${record.windowName} (${record.windowId})`
				: `its window ${record.windowName} was already gone`;
			return toolResult(`Closed delegation ${record.id}: ${how}.`, {
				id: record.id,
				windowId: record.windowId,
				killed: alive,
			});
		},
	};
}

/** The poll and the two tools, over the extension API, the records and tmux. */
export function createTracking(pi: ExtensionAPI, results: Results, tmux: TmuxClient): Tracking {
	const poll = createPoll(pi, results, tmux);
	return {
		registerTools(): void {
			pi.registerTool(statusTool(results, tmux) as never);
			pi.registerTool(closeTool(results, tmux) as never);
		},
		startPolling: poll.start,
		restore(ctx: ExtensionContext): void {
			poll.arm();
			results.restore(ctx);
			poll.start();
		},
		stop: poll.stop,
	};
}

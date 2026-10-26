// Delegation tracking: the poll that notices a delegate's window going away,
// and the `delegation_status` and `delegation_close` tools. A delegation's
// state comes from `results.ts` (`deriveState`); this module only asks tmux
// about the window and words what it is told.
import { statSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import { type Mark, readMarks } from "./limits.ts";
import { createPoll } from "./poll.ts";
import type { Popup } from "./popups.ts";
import { attemptLines, cwdLine, modelLabel, snapshotLines, workspaceLine } from "./render.ts";
import {
	type DelegationState,
	deriveState,
	isStarted,
	locateSession,
	type Recorded,
	type Results,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
	type WorkspaceAttempt,
} from "./results.ts";
import { inspectWorkspace, type WorkspaceSnapshot, WorkspaceSnapshotSchema } from "./snapshot.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { AttemptSchema } from "./tracking-attempt.ts";
import { ago, autoExitLine, stateLine } from "./tracking-text.ts";
import type { ReadingError } from "./usage.ts";
import { listWindows, ownWindow, windowState } from "./windows.ts";
import { WorkspaceSchema } from "./workspace.ts";

export { listWindows, ownWindow, windowState };

/** What `src/index.ts` needs from tracking. */
export type Tracking = {
	/** Register `delegation_status` and `delegation_close`. */
	registerTools(): void;
	/** Start the poll when something is running or a popup is open. */
	startPolling(): void;
	/** Remember a popup the parent opened; the poll closes it once its window is gone. */
	trackPopup(popup: Popup): void;
	/** Close one delegation as `delegation_close` does; throws as the tool does. */
	close(id: string): Promise<CloseResult>;
	/** On `session_start`: rebuild the records and restart the poll. */
	restore(ctx: ExtensionContext): void;
	/** On `session_shutdown`: stop the poll, and declare nothing more. */
	stop(): void;
};

/** What closing one delegation did. */
export type CloseResult = { text: string; details: Static<typeof CloseSchema> };

/** The one result every tool returns. `details` doubles as `structuredContent`, so it must match the tool's `outputSchema`; Pi does not check it. */
export function toolResult(
	payload: string,
	details: unknown,
): { content: { type: "text"; text: string }[]; details: unknown; structuredContent: unknown } {
	return { content: [{ type: "text", text: payload }], details, structuredContent: details };
}

/** Every tool here touches only local state: tmux, the session's entries and files under the agent directory. */
const CLOSED_WORLD = { openWorldHint: false } as const;

const STARTED_STATES = ["closed", "done", "gone", "running", "window-closed", "unknown"] as const;

/** One started delegation in `delegation_status`'s structured result; `viewDetails` builds it. */
const StartedSchema = Type.Object({
	kind: Type.Literal("started"),
	id: Type.String(),
	name: Type.String(),
	agent: Type.String(),
	model: Type.String({ description: "The model it was launched on." }),
	finishedModel: Type.Optional(
		Type.String({ description: "The model its result came from, read from its session file; done only." }),
	),
	thinking: Type.String(),
	autoExit: Type.Boolean(),
	resumedFrom: Type.Optional(Type.String({ description: "The delegation whose session this one reopened." })),
	windowId: Type.String(),
	windowName: Type.String(),
	windowSession: Type.Optional(
		Type.String({ description: "The tmux session its window is in now; absent when the window is gone." }),
	),
	cwd: Type.Optional(
		Type.String({ description: "The directory its window opened in; absent for records from before it was kept." }),
	),
	sessionDir: Type.Optional(Type.String({ description: "The session-storage directory it was told to use." })),
	workspace: Type.Optional(WorkspaceSchema),
	workspaceSnapshot: WorkspaceSnapshotSchema,
	state: Type.Union(
		STARTED_STATES.map((state) => Type.Literal(state)),
		{
			description:
				"running: window open, no result. done: a result arrived (see status, envelopePath). gone: the window went with no result; a late reply makes it done. closed: delegation_close recorded it. window-closed: the window is gone. unknown: tmux could not be asked. done and closed are final, though a later delegation_resume continues one as a new delegation; gone and window-closed turn done if a late reply arrives.",
		},
	),
	closed: Type.Boolean(),
	closedWithoutResult: Type.Boolean(),
	status: Type.Optional(Type.String({ description: "The result envelope's status: done, failed or stopped." })),
	envelopePath: Type.Optional(Type.String()),
	sessionPath: Type.Optional(Type.String()),
	lastActiveAt: Type.Optional(
		Type.String({ description: "ISO time the session file was last written; running only." }),
	),
});

const DelegationSchema = Type.Union([StartedSchema, AttemptSchema]);

export const StatusSchema = Type.Object({
	delegations: Type.Array(DelegationSchema),
	marks: Type.Array(
		Type.Object({
			scope: Type.String(),
			source: Type.Union([Type.Literal("reactive"), Type.Literal("proactive")]),
			reason: Type.String(),
			clearsAt: Type.String(),
		}),
	),
	readingErrors: Type.Array(Type.Object({ provider: Type.String(), reason: Type.String(), at: Type.String() })),
});

export const CloseSchema = Type.Object({
	id: Type.String(),
	windowId: Type.String(),
	windowName: Type.String(),
	closed: Type.Literal(true),
	alreadyClosed: Type.Boolean({ description: "An earlier delegation_close had recorded it; nothing was done." }),
	killed: Type.Boolean({ description: "This call killed the delegate's window." }),
});

/** A tool as registered; `execute` takes the tool's own parameters, which the registration call does not check. */
export type ToolDef = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	outputSchema: unknown;
	annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
	execute: (...args: never[]) => Promise<ReturnType<typeof toolResult>>;
};

/** One delegation as `delegation_status` reports it; its text and details both read from this. */
type View = {
	record: StartedRecorded;
	state: DelegationState;
	name: string;
	sessionPath: string | undefined;
	/** When the session file was last written; set only for a running delegation with a file. */
	lastActive: Date | undefined;
	/** The checkout observed for this status call; the recorded result keeps its own. */
	snapshot: WorkspaceSnapshot;
	/** The delegation that resumed this one, if any. */
	resumedAs: string | undefined;
	/** The session its window is in now, looked up; undefined when the window is gone or unknown. */
	windowSession: string | undefined;
};

/** The view of a delegation: its state and the fields the text and details share. */
function view(
	record: StartedRecorded,
	windows: TmuxWindow[] | undefined,
	ctx: ExtensionContext,
	resumedAs: string | undefined,
): View {
	const state = deriveState(record, windowState(windows, record));
	const sessionPath = locateSession(record, ctx.sessionManager.getSessionDir());
	let lastActive: Date | undefined;
	if (state === "running" && sessionPath !== undefined) {
		try {
			lastActive = statSync(sessionPath).mtime;
		} catch {
			// a failed stat counts as no file
		}
	}
	const snapshot = inspectWorkspace(record.workspace?.cwd, record.workspace?.git);
	const windowSession = windows === undefined ? undefined : ownWindow(windows, record)?.session;
	return { record, state, name: recordedName(record), sessionPath, lastActive, snapshot, resumedAs, windowSession };
}

/** The text block for one delegation. */
function viewText({ record, state, name, sessionPath, lastActive, snapshot, resumedAs, windowSession }: View): string {
	const [checkout, ...categories] = snapshotLines(snapshot);
	const seen = lastActive === undefined ? "" : ` (last active ${ago(Date.now() - lastActive.getTime())})`;
	const lines = [
		`${record.id} ${record.agent} (${modelLabel(record.model, record.result?.finishedModel)}, thinking ${record.thinking})`,
		`  name: ${name}`,
		...(record.resumedFrom === undefined ? [] : [`  resumed from ${record.resumedFrom}`]),
		...(resumedAs === undefined ? [] : [`  resumed as ${resumedAs}`]),
		`  state: ${stateLine(state, record)}${seen}`,
		`  window: ${record.windowName} (${record.windowId})${windowSession === undefined || windowSession === "" ? "" : ` in session ${windowSession}`}`,
		`  cwd: ${cwdLine(record.cwd)}`,
		...(record.workspace === undefined ? [] : [`  workspace: ${workspaceLine(record.workspace)}`]),
		`  checkout now: ${checkout}`,
		...categories.map((line) => `    ${line}`),
		`  auto-exit: ${autoExitLine(record)}`,
		`  session: ${sessionPath ?? `${sessionIdOf(record)} (no session file yet)`}`,
	];
	if (record.result !== undefined) lines.push(`  envelope: ${record.result.envelopePath}`);
	return lines.join("\n");
}

/** The structured details for one delegation. */
function viewDetails({
	record,
	state,
	name,
	sessionPath,
	lastActive,
	snapshot,
	windowSession,
}: View): Record<string, unknown> {
	return {
		kind: "started",
		id: record.id,
		name,
		agent: record.agent,
		model: record.model,
		...(record.result?.finishedModel === undefined ? {} : { finishedModel: record.result.finishedModel }),
		thinking: record.thinking,
		autoExit: record.autoExit === true,
		...(record.resumedFrom === undefined ? {} : { resumedFrom: record.resumedFrom }),
		windowId: record.windowId,
		windowName: record.windowName,
		...(windowSession === undefined || windowSession === "" ? {} : { windowSession }),
		...(record.cwd === undefined ? {} : { cwd: record.cwd }),
		...(record.sessionDir === undefined ? {} : { sessionDir: record.sessionDir }),
		...(record.workspace === undefined ? {} : { workspace: record.workspace }),
		workspaceSnapshot: snapshot,
		state,
		closed: record.closed === true,
		closedWithoutResult: record.gone === true && record.result === undefined && record.closed !== true,
		status: record.result?.status,
		envelopePath: record.result?.envelopePath,
		sessionPath,
		...(lastActive === undefined ? {} : { lastActiveAt: lastActive.toISOString() }),
	};
}

/** One unstarted attempt as the status text words it. */
function attemptText(record: WorkspaceAttempt): string {
	return [
		`${record.id} ${record.agent} (${modelLabel(record.model, undefined)}, thinking ${record.thinking})`,
		`  name: ${recordedName(record)}`,
		`  state: ${record.attempt.phase} — no window id/start was recorded; a window may still exist (close requires a verified window id)`,
		...attemptLines(record).map((line) => `  ${line}`),
	].join("\n");
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

/** The `delegation_status` tool. */
function statusTool(results: Results, tmux: TmuxClient, readingErrors: () => ReadingError[]): ToolDef {
	return {
		name: "delegation_status",
		label: "Delegation status",
		description:
			"The delegations this session started, each reported as running (the window is open and no result has arrived yet), done (with the result envelope's status) or closed (closed with delegation_close, or its window is gone). A delegation whose window went with no reply is reported closed without a result until a late reply makes it done. Call it to check on a delegation that seems stuck or to find its files; a result arrives as a message on its own, so there is no need to call it to wait for one. Names the delegation id, agent, session name, model, thinking, window, working directory, delegate session path and result envelope path. A running delegation also shows when its session file was last written; a long gap may mean it is stuck but does not prove it. A delegate's window being open means it is connected, not that its task is unfinished or finished; only a result means done.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "One delegation id; omit to report every delegation." })),
		}),
		outputSchema: StatusSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
		async execute(
			_toolCallId: string,
			params: { id?: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const records = selectRecords(results, params.id);
			const windows = await listWindows(tmux);
			const resumedAs = (id: string) => results.list().find((item) => isStarted(item) && item.resumedFrom === id)?.id;
			const views = records.map((record) =>
				isStarted(record) ? view(record, windows, ctx, resumedAs(record.id)) : record,
			);
			const marks = activeMarks();
			const errors = readingErrors();
			const details = {
				delegations: views.map((item) =>
					"record" in item ? viewDetails(item) : { ...item, state: item.attempt.phase },
				),
				marks,
				readingErrors: errors,
			};
			const block =
				marks.length === 0 && errors.length === 0
					? []
					: [
							[
								"Usage-limit marks:",
								...marks.map((m) => `- ${m.scope} (${m.source}) until ${m.clearsAt}: ${m.reason}`),
								...errors.map((e) => `- could not read ${e.provider} quota at ${e.at}: ${e.reason}`),
							].join("\n"),
						];
			const heading = `${views.length} delegation${views.length === 1 ? "" : "s"}:`;
			const parts =
				views.length === 0
					? ["No delegations are recorded in this session.", ...block]
					: [
							`${heading}\n\n${views.map((item) => ("record" in item ? viewText(item) : attemptText(item))).join("\n\n")}`,
							...block,
						];
			return toolResult(parts.join("\n\n"), details);
		},
	};
}

/** Close one delegation: kill its window when it is open and record the close; throws when it cannot. */
export async function closeDelegation(results: Results, tmux: TmuxClient, id: string): Promise<CloseResult> {
	const [record] = selectRecords(results, id);
	if (!isStarted(record)) {
		throw new Error(
			`delegation ${record.id} is a workspace attempt (${record.attempt.phase}): no verified window id was recorded; a window may still exist, so close is unavailable`,
		);
	}
	const closed = (alreadyClosed: boolean, killed: boolean): CloseResult["details"] => ({
		id: record.id,
		windowId: record.windowId,
		windowName: record.windowName,
		closed: true as const,
		alreadyClosed,
		killed,
	});
	if (record.closed === true)
		return { text: `Delegation ${record.id} is already closed.`, details: closed(true, false) };
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
	return { text: `Closed delegation ${record.id}: ${how}.`, details: closed(false, alive) };
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
		outputSchema: CloseSchema,
		// Kills a window; a second close finds it recorded and does nothing.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...CLOSED_WORLD },
		async execute(
			_toolCallId: string,
			params: { id: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const { text, details } = await closeDelegation(results, tmux, params.id);
			return toolResult(text, details);
		},
	};
}

/** The poll and the two tools, over the extension API, the records and tmux. */
export function createTracking(
	pi: ExtensionAPI,
	results: Results,
	tmux: TmuxClient,
	readingErrors: () => ReadingError[] = () => [],
): Tracking {
	const poll = createPoll(pi, results, tmux);
	return {
		registerTools(): void {
			pi.registerTool(statusTool(results, tmux, readingErrors) as never);
			pi.registerTool(closeTool(results, tmux) as never);
		},
		startPolling: poll.start,
		trackPopup: poll.track,
		close: (id: string): Promise<CloseResult> => closeDelegation(results, tmux, id),
		restore(ctx: ExtensionContext): void {
			poll.arm();
			results.restore(ctx);
			poll.start();
		},
		stop: poll.stop,
	};
}

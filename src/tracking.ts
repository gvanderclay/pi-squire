// Delegation tracking: the poll that notices a delegate's window going away,
// and the `delegation_status` and `delegation_close` tools. A delegation's
// state comes from `results.ts` (`deriveState`); this module only asks tmux
// about the window and words what it is told.

import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DelegateHost } from "./host.ts";
import { readIdentity } from "./identity.ts";
import { type Mark, readMarks } from "./limits.ts";
import { windowPresentation } from "./locators.ts";
import { createPoll } from "./poll.ts";
import {
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
import { routingEvidence } from "./routing-provenance.ts";
import { RoutingEvidenceSchema, RoutingRecordSchema } from "./routing-schema.ts";
import { inspectWorkspace, WorkspaceSnapshotSchema } from "./snapshot.ts";
import { AttemptSchema } from "./tracking-attempt.ts";
import { attemptText, compactText, type View, viewText } from "./tracking-text.ts";
import { type CloseResult, CloseSchema, closeTree } from "./tree-close.ts";
import { accountingFor } from "./tree-view.ts";
import type { ReadingError } from "./usage.ts";
import { askWindowStates, type WindowStates } from "./window-state.ts";
import { WorkspaceSchema } from "./workspace.ts";

export type { CloseResult };
export { CloseSchema };

/** What `src/index.ts` needs from tracking. */
export type Tracking = {
	/** Register `delegation_status` and `delegation_close`. */
	registerTools(): void;
	/** Start the poll when a delegation is running. */
	startPolling(): void;
	/** Close a recorded descendant subtree, with honest complete/partial details. */
	close(id: string, ctx: ExtensionContext): Promise<CloseResult>;
	/** Root-only explicit whole-tree action. */
	closeAll(ctx: ExtensionContext): Promise<CloseResult>;
	/** On `session_start`: rebuild the records and restart the poll. */
	restore(ctx: ExtensionContext): void;
	/** On `session_shutdown`: stop the poll, and declare nothing more. */
	stop(): void;
};

/** The one result every tool returns. `details` doubles as `structuredContent`, so it must match the tool's `outputSchema`; Pi does not check it. */
export function toolResult(
	payload: string,
	details: unknown,
): { content: { type: "text"; text: string }[]; details: unknown; structuredContent: unknown } {
	return { content: [{ type: "text", text: payload }], details, structuredContent: details };
}

/** Every tool here touches only local state: tmux, the session's entries and files under the agent directory. */
const CLOSED_WORLD = { openWorldHint: false } as const;

// Exact string enums keep status evidence explicit without bloating the shared tool declarations.
const STARTED_STATES = ["closed", "done", "gone", "running", "window-closed", "unknown"] as const;

/** One started delegation in `delegation_status`'s structured result; `viewDetails` builds it. */
const StartedSchema = Type.Object({
	sessionId: Type.String(),
	parent: Type.Optional(Type.String()),
	root: Type.Optional(Type.String()),
	depth: Type.Optional(Type.Number()),
	accounting: Type.Optional(Type.String()),
	canResume: Type.Boolean(),
	kind: Type.Literal("started"),
	id: Type.String(),
	name: Type.String(),
	agent: Type.String(),
	model: Type.String(),
	finishedModel: Type.Optional(Type.String()),
	routing: Type.Optional(RoutingRecordSchema),
	routingEvidence: Type.Optional(RoutingEvidenceSchema),
	thinking: Type.String(),
	autoExit: Type.Boolean(),
	resumedFrom: Type.Optional(Type.String()),
	forkedFrom: Type.Optional(Type.String()),
	windowId: Type.String(),
	windowName: Type.String(),
	windowSession: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	sessionDir: Type.Optional(Type.String()),
	workspace: Type.Optional(WorkspaceSchema),
	workspaceSnapshot: WorkspaceSnapshotSchema,
	state: Type.Enum(STARTED_STATES),
	closed: Type.Boolean(),
	closedWithoutResult: Type.Boolean(),
	status: Type.Optional(Type.String()),
	envelopePath: Type.Optional(Type.String()),
	sessionPath: Type.Optional(Type.String()),
	lastActiveAt: Type.Optional(Type.String()),
});

const DelegationSchema = Type.Union([StartedSchema, AttemptSchema]);

export const StatusSchema = Type.Object({
	delegations: Type.Array(DelegationSchema),
	marks: Type.Array(
		Type.Object({
			scope: Type.String(),
			source: Type.Enum(["reactive", "proactive"]),
			reason: Type.String(),
			clearsAt: Type.String(),
		}),
	),
	readingErrors: Type.Array(Type.Object({ provider: Type.String(), reason: Type.String(), at: Type.String() })),
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

/** One row in the status result: a started delegation's view or an unstarted attempt. */
type StatusItem = View | WorkspaceAttempt;

/** The view of a delegation: its state and the fields the text and details share. */
function view(
	record: StartedRecorded,
	windows: WindowStates,
	ctx: ExtensionContext,
	resumedAs: string | undefined,
): View {
	const window = windows.look(record);
	const state = deriveState(record, window.state);
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
	const windowSession = window.session;
	return {
		record,
		...(record.routing ? { routingEvidence: routingEvidence(record.routing, sessionPath) } : {}),
		state,
		name: recordedName(record),
		sessionPath,
		lastActive,
		snapshot,
		resumedAs,
		windowSession,
		canResume: (record.identity?.parent ?? ctx.sessionManager.getSessionId()) === ctx.sessionManager.getSessionId(),
	};
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
	canResume,
	routingEvidence,
}: View): Record<string, unknown> {
	return {
		kind: "started",
		sessionId: sessionIdOf(record),
		parent: record.identity?.parent,
		root: record.identity?.root,
		depth: record.identity?.depth,
		accounting: accountingFor(record),
		canResume,
		id: record.id,
		name,
		agent: record.agent,
		model: record.model,
		...(record.routing ? { routing: record.routing, routingEvidence } : {}),
		...(record.result?.finishedModel === undefined ? {} : { finishedModel: record.result.finishedModel }),
		thinking: record.thinking,
		autoExit: record.autoExit === true,
		...(record.resumedFrom === undefined ? {} : { resumedFrom: record.resumedFrom }),
		...(record.forkedFrom === undefined ? {} : { forkedFrom: record.forkedFrom }),
		windowId: windowPresentation(record).windowId,
		windowName: windowPresentation(record).windowName,
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

/** The structured details for one status row. */
function itemDetails(item: StatusItem): Record<string, unknown> {
	return "record" in item ? viewDetails(item) : { ...item, state: item.attempt.phase };
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

/** How many settled records the default status view keeps, newest first. */
const RECENT_SETTLED = 5;

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

/**
 * The default status selection: every running delegation and unfinished
 * workspace attempt, plus the most recently settled records. A started record
 * with no result, close or gone fact whose state is unknown (the host could not
 * be asked) counts as unfinished too. Records from before settlement times rank
 * below timed ones, later-recorded first. Render order stays hierarchical.
 */
function recentRecords(records: Recorded[], windows: WindowStates): Recorded[] {
	const unfinished = (record: StartedRecorded): boolean => {
		const state = deriveState(record, windows.state(record));
		if (state === "running") return true;
		const settled = record.result !== undefined || record.gone === true || record.closed === true;
		return state === "unknown" && !settled && record.accountingOnly !== true;
	};
	const active = (record: Recorded): boolean =>
		isStarted(record) ? unfinished(record) : record.attempt.phase !== "rolled-back";
	const chosen = new Set(records.filter(active).map((record) => record.id));
	const position = new Map(records.map((record, index) => [record.id, index]));
	const time = (record: Recorded): number => (isStarted(record) ? (record.settledAt ?? -1) : -1);
	const settled = records.filter((item) => !chosen.has(item.id));
	settled.sort((a, b) => time(b) - time(a) || (position.get(b.id) ?? 0) - (position.get(a.id) ?? 0));
	for (const record of settled.slice(0, RECENT_SETTLED)) chosen.add(record.id);
	return records.filter((record) => chosen.has(record.id));
}

/** The usage-limit block, or nothing when there is neither a mark nor a reading error. */
function statusBlock(
	marks: { scope: string; source: Mark["source"]; reason: string; clearsAt: string }[],
	errors: ReadingError[],
): string[] {
	if (marks.length === 0 && errors.length === 0) return [];
	return [
		[
			"Usage-limit marks:",
			...marks.map((m) => `- ${m.scope} (${m.source}) until ${m.clearsAt}: ${m.reason}`),
			...errors.map((e) => `- could not read ${e.provider} quota at ${e.at}: ${e.reason}`),
		].join("\n"),
	];
}

/** The heading: the shown count, or the total with how many running and older records were left out. */
function statusHeading(all: Recorded[], views: StatusItem[], omitted: number): string {
	if (omitted === 0) return `${views.length} delegation${views.length === 1 ? "" : "s"}:`;
	const running = views.filter((item) => "record" in item && item.state === "running").length;
	return `${all.length} delegation${all.length === 1 ? "" : "s"} (${running} running, ${omitted} older omitted; pass all or an id for those):`;
}

/** The `delegation_status` tool. */
function statusTool(results: Results, tmux: DelegateHost, readingErrors: () => ReadingError[]): ToolDef {
	return {
		name: "delegation_status",
		label: "Delegation status",
		description:
			"Report delegations: default running, unfinished attempts + 5 most recently settled; all lists all; id gives one full block. Results arrive on their own; check only for stuck work or files. An open window does not mean unfinished; only a result means done. gone/window-closed can turn done on a late reply.",
		parameters: Type.Object({ id: Type.Optional(Type.String()), all: Type.Optional(Type.Boolean()) }),
		outputSchema: StatusSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, ...CLOSED_WORLD },
		async execute(
			_toolCallId: string,
			params: { id?: string; all?: boolean },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const records = selectRecords(results, params.id);
			const windows = await askWindowStates(tmux);
			const selected = params.id === undefined && params.all !== true ? recentRecords(records, windows) : records;
			const resumedAs = (id: string) => results.list().find((item) => isStarted(item) && item.resumedFrom === id)?.id;
			const views = selected.map((record) =>
				isStarted(record) ? view(record, windows, ctx, resumedAs(record.id)) : record,
			);
			const marks = activeMarks();
			const errors = readingErrors();
			const details = { delegations: views.map(itemDetails), marks, readingErrors: errors };
			const block = statusBlock(marks, errors);
			const heading = statusHeading(records, views, records.length - selected.length);
			const text = views
				.map((item) => {
					if (!("record" in item)) return attemptText(item);
					return params.id === undefined && item.state !== "running" ? compactText(item) : viewText(item);
				})
				.join("\n\n");
			const parts =
				views.length === 0
					? ["No delegations are recorded in this session.", ...block]
					: [
							`${heading}\n\n${text}${params.id === undefined ? "\n\nPass id for a delegation's full block." : ""}`,
							...block,
						];
			return toolResult(parts.join("\n\n"), details);
		},
	};
}

/** Shared explicit-close entry point, also used by the navigator. */
export async function closeDelegation(
	results: Results,
	tmux: DelegateHost,
	id: string | undefined,
	ctx: ExtensionContext,
	assertActive: () => void,
	wake = true,
): Promise<CloseResult> {
	const local = id ? results.find(id) : undefined;
	if (local && !isStarted(local))
		throw new Error(
			`delegation ${local.id} is a workspace attempt (${local.attempt.phase}); close requires a verified create outcome`,
		);
	const actor = ctx.sessionManager.getSessionId();
	const root = readIdentity(actor)?.root ?? actor;
	const result = await closeTree({ root, actor, id, tmux, assertActive });
	assertActive();
	results.syncCloses(wake);
	return result;
}

/** The `delegation_close` tool. */
function closeTool(results: Results, tmux: DelegateHost, assertActive: () => void): ToolDef {
	return {
		name: "delegation_close",
		label: "Close delegation",
		description:
			"Close a descendant and its recorded subtree: fence new launches and kill its verified windows, keeping worktrees, branches and session files. Check closed and complete; partial failures stay fenced for a retry.",
		parameters: Type.Object({ id: Type.String() }),
		outputSchema: CloseSchema,
		// Kills only verified windows; repeats retry unresolved members and preserve confirmed facts.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, ...CLOSED_WORLD },
		async execute(
			_toolCallId: string,
			params: { id: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const { text, details } = await closeDelegation(results, tmux, params.id, ctx, assertActive, false);
			return { ...toolResult(text, details), ...(!details.complete ? { isError: true } : {}) };
		},
	};
}

/** The poll and the two tools, over the extension API, the records and tmux. */
export function createTracking(
	pi: ExtensionAPI,
	results: Results,
	tmux: DelegateHost,
	readingErrors: () => ReadingError[] = () => [],
	views: Results = results,
	assertActive: () => void = () => {},
): Tracking {
	const poll = createPoll(pi, results, tmux);
	return {
		registerTools(): void {
			pi.registerTool(statusTool(views, tmux, readingErrors) as never);
			pi.registerTool(closeTool(results, tmux, assertActive) as never);
		},
		startPolling: poll.start,
		close: (id: string, ctx: ExtensionContext): Promise<CloseResult> =>
			closeDelegation(results, tmux, id, ctx, assertActive),
		closeAll: (ctx: ExtensionContext): Promise<CloseResult> =>
			closeDelegation(results, tmux, undefined, ctx, assertActive),
		restore(ctx: ExtensionContext): void {
			poll.arm();
			results.restore(ctx);
			poll.start();
		},
		stop: poll.stop,
	};
}

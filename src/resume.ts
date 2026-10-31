// Resuming an exited delegate: the eligibility checks, the launch that reopens
// its own session file, and the `delegation_resume` tool. A resume is recorded
// as a new delegation (`resumedFrom` the old id) that keeps the old session id
// (`sessionId`), so mail, replies and usage-limit marks still find the session.
// `index.ts` supplies the pieces it shares with a launch: model choice, trust,
// the task mail and the window.
import { randomUUID } from "node:crypto";

import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { type Agent, type Roster, THINKING_LEVELS } from "./agents.ts";
import { type Identity, readIdentity } from "./identity.ts";
import { sessionIdOf } from "./result-sessions.ts";
import { isStarted, type Results, recordedName, type StartedRecorded } from "./results.ts";
import {
	assertNoOwner,
	inFlight,
	passes,
	preflight,
	recordCheck,
	type SessionFile,
	settleModel,
	windowCheck,
} from "./resume-checks.ts";
import type { OpenedWindow, TmuxClient } from "./tmux.ts";
import { listWindows, type ToolDef, toolResult } from "./tracking.ts";
import { bindTree, failedTree, type Reservation } from "./tree-registry.ts";
import type { WindowPlacement } from "./window-placement.ts";
import type { Workspace } from "./workspace.ts";

/** What a resume asks for; the fields after `task` are optional overrides. */
export type ResumeRequest = {
	id: string;
	task: string;
	model?: string;
	thinking?: string;
	autoExit?: boolean;
	/** The `delegation_resume` tool call that asked for it; undefined from the command. */
	toolCallId?: string;
};

/** A candidate model passed over, as `chooseModel` reports it. */
type Skipped = { model: string; why: string; reason: string };

/** What a resume reads from the launch path in `index.ts`. */
export type ResumeDeps = {
	results: Results;
	tmux: TmuxClient;
	/** The `delegate` tool's result schema, which a resume's result extends. */
	delegateSchema: TObject;
	/** The refusal text for a session outside tmux. */
	notInTmux: string;
	startPolling(): void;
	/** The window placement for this call; throws on an invalid setting. */
	placement(): WindowPlacement;
	roster(ctx: ExtensionContext): Roster;
	/** Depth/current-parent grant check, before even an exited window is killed. */
	admit?(agent: string, ctx: ExtensionContext): void;
	authorize?(id: string, ctx: ExtensionContext): void;
	reserve(record: StartedRecorded, id: string, ctx: ExtensionContext): Promise<Reservation>;
	/** The parent's current model and thinking level, which a field the agent locks but does not set keeps. */
	parentDefaults(ctx: ExtensionContext): { model?: string; thinking: string };
	chooseModel(
		explicit: string | undefined,
		agent: Agent,
		models: ModelRegistry,
		preferred: readonly string[],
	): Promise<{ model: string; skipped: Skipped[]; notices: string[]; rest: string[] }>;
	thinkingProblem(value: string): string | undefined;
	/** The workspace and trust for an existing directory, deciding trust again. */
	prepareDirectory(
		cwd: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		agent: string,
	): Promise<{ workspace: Workspace; trusted: boolean }>;
	/** Mail the task to a session id; returns the request id. */
	sendTask(to: string, task: string): string;
	/** Open the window with `--session <path>`; returns its id and session. */
	open(input: {
		id: string;
		name: string;
		sessionPath: string;
		workspace: Workspace;
		trusted: boolean;
		cwd: string;
		sessionDir: string;
		start: { agent: Agent; model: string; rest: string[]; thinking: string; autoExit: boolean; notices: string[] };
		toolCallId: string | undefined;
		ctx: ExtensionContext;
		placement: WindowPlacement;
		identity?: Identity;
		sessionId: string;
	}): Promise<OpenedWindow>;
};

/** A started resume: what the tool and the command report. */
export type Resumed = {
	id: string;
	resumedFrom: string;
	agent: string;
	model: string;
	skipped: { model: string; reason: string }[];
	notices: string[];
	thinking: string;
	autoExit: boolean;
	windowId: string;
	windowName: string;
	/** The session the window opened in, when tmux could say. */
	windowSession?: string;
	cwd: string;
	sessionDir: string;
	workspace: Workspace;
	/** The sentence naming a fallback model, or "". */
	fallbackNote: string;
};

/** The started records, in the order recorded. */
function startedRecords(results: Results): StartedRecorded[] {
	return results.list().filter(isStarted);
}

/** The record a `/delegate-resume` id can name: started, with no later resume of it. */
export function resumableIds(results: Results): string[] {
	const started = startedRecords(results);
	return started.filter((record) => !started.some((item) => item.resumedFrom === record.id)).map(({ id }) => id);
}

/** Steps 1 and 2: the id names a started delegation that nothing resumed. */
function newestStarted(results: Results, id: string): StartedRecorded {
	const record = results.find(id);
	if (record === undefined) {
		const known = results.list().map((item) => item.id);
		throw new Error(`no delegation ${JSON.stringify(id)}; known: ${known.join(", ") || "none"}`);
	}
	if (!isStarted(record)) {
		throw new Error(
			`delegation ${id} is a workspace attempt (${record.attempt.phase}), not a started delegate, so there is no session to resume`,
		);
	}
	const started = startedRecords(results);
	let newest = record;
	for (let next = started.find((item) => item.resumedFrom === newest.id); next !== undefined; ) {
		newest = next;
		next = started.find((item) => item.resumedFrom === newest.id);
	}
	if (newest !== record) {
		throw new Error(
			`delegation ${id} was already resumed; resume its newest delegation ${newest.id} instead (it continues the same session)`,
		);
	}
	return record;
}

/** Steps 3 and 4, then the kill of an exited window; `windowCheck` is the part the picker shares. */
async function ensureExited(record: StartedRecorded, tmux: TmuxClient): Promise<void> {
	const own = windowCheck(record, await listWindows(tmux));
	if (own === undefined) return;
	try {
		await tmux.kill(own.id);
	} catch (err) {
		throw new Error(
			`could not kill the exited window ${record.windowName} (${record.windowId}): ${(err as Error).message}`,
		);
	}
}

/** The tool's result: the `delegate` tool's plus the delegation it resumed. */
function resultSchema(delegateSchema: TObject): TObject {
	return Type.Object({
		...delegateSchema.properties,
		resumedFrom: Type.String({ description: "The delegation whose session this one reopened." }),
	});
}

/** The model, thinking and auto-exit a resume runs with, and the directory and workspace it opens in. */
type Plan = {
	start: { agent: Agent; model: string; rest: string[]; thinking: string; autoExit: boolean; notices: string[] };
	chosen: Awaited<ReturnType<ResumeDeps["chooseModel"]>>;
	workspace: Workspace;
	trusted: boolean;
};

/** Settle the request's overrides against the record, and decide trust again for the session's directory. */
async function planResume(
	deps: ResumeDeps,
	input: { record: StartedRecorded; agent: Agent; session: SessionFile; request: ResumeRequest },
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Plan> {
	const { record, agent, session, request } = input;
	const { thinking, chosen } = await settleModel(deps, input, ctx);
	const autoExit = request.autoExit ?? record.autoExit === true;
	const prepared = await deps.prepareDirectory(session.cwd, ctx, signal, agent.name);
	// A managed worktree keeps its launch facts while the session still runs in it.
	const workspace = record.workspace?.cwd === prepared.workspace.cwd ? record.workspace : prepared.workspace;
	return {
		start: { agent, model: chosen.model, rest: chosen.rest, thinking, autoExit, notices: chosen.notices },
		chosen,
		workspace,
		trusted: prepared.trusted,
	};
}

/** Mail the task, open the window on the session file and record the new delegation. */
/**
 * Mail the task to a window already open. Unlike a launch, a resume mails
 * after the window opens: the session's inbox outlives a failed attempt, so
 * mail sent for a window that never opened would reach the next resume as a
 * second task. The reopened session's provider still delivers mail that
 * arrives after it starts. A failed send kills the window, which has no task.
 */
async function mailTask(deps: ResumeDeps, windowId: string, sessionId: string, task: string): Promise<string> {
	try {
		return deps.sendTask(sessionId, task);
	} catch (err) {
		await deps.tmux.kill(windowId).catch(() => {});
		throw err;
	}
}

function publishResumeRequest(token: Reservation, requestId: string, windowId: string, ctx: ExtensionContext): void {
	try {
		bindTree(token, { requestId });
	} catch (error) {
		ctx.ui.notify(
			`delegate: window ${windowId} opened and task mail was sent, but shared request publication failed: ${String(error)}. Local tracking continues; accounting reconciles before the next admission.`,
			"warning",
		);
	}
}

async function startResume(
	deps: ResumeDeps,
	input: {
		record: StartedRecorded;
		session: SessionFile;
		plan: Plan;
		task: string;
		toolCallId: string | undefined;
		placement: WindowPlacement;
		reservation: Reservation;
	},
	ctx: ExtensionContext,
): Promise<Resumed> {
	const { record, session, plan, task, toolCallId, placement } = input;
	const { start, chosen, workspace } = plan;
	const id = input.reservation.id;
	const sessionId = sessionIdOf(record);
	const name = recordedName(record);
	const { id: windowId, session: windowSession } = await deps.open({
		id,
		name,
		identity: record.identity ?? readIdentity(sessionId),
		sessionId,
		sessionPath: session.path,
		workspace,
		trusted: plan.trusted,
		cwd: workspace.cwd,
		sessionDir: session.dir,
		start,
		toolCallId,
		ctx,
		placement,
	});
	const requestId = await mailTask(deps, windowId, sessionId, task);
	publishResumeRequest(input.reservation, requestId, windowId, ctx);
	deps.results.recordStart(
		{
			id,
			identity: readIdentity(sessionId) ?? record.identity,
			agent: start.agent.name,
			...(start.agent.displayName === undefined ? {} : { displayName: start.agent.displayName }),
			model: start.model,
			thinking: start.thinking,
			name,
			windowId,
			windowName: name,
			requestId,
			autoExit: start.autoExit,
			cwd: workspace.cwd,
			sessionDir: session.dir,
			workspace,
			resumedFrom: record.id,
			sessionId,
		},
		ctx,
	);
	deps.startPolling();
	return {
		id,
		resumedFrom: record.id,
		agent: start.agent.name,
		model: start.model,
		skipped: chosen.skipped.map(({ model, reason }) => ({ model, reason })),
		notices: chosen.notices,
		thinking: start.thinking,
		autoExit: start.autoExit,
		windowId,
		windowName: name,
		...(windowSession === undefined ? {} : { windowSession }),
		cwd: workspace.cwd,
		sessionDir: session.dir,
		workspace,
		fallbackNote:
			chosen.skipped.length === 0
				? ""
				: `Used fallback ${chosen.model} because ${chosen.skipped.map((item) => `${item.model} is ${item.why}`).join("; ")}.`,
	};
}

/** Resume `request.id`: every eligibility check in order, then the launch. */
async function resume(
	deps: ResumeDeps,
	request: ResumeRequest,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Resumed> {
	const placement = await preflight(deps); // read once, before the exited window is killed or anything is mailed
	if (request.task.trim() === "") throw new Error("a task is required");
	deps.authorize?.(request.id, ctx);
	const record = newestStarted(deps.results, request.id);
	deps.admit?.(record.agent, ctx);
	assertNoOwner(record);
	deps.results.checkStorage(true);
	const reservation = await deps.reserve(record, randomUUID(), ctx);
	let acquired = false;
	try {
		await ensureExited(record, deps.tmux);
		const { session, agent } = recordCheck(deps, record, ctx);
		inFlight.add(record.id);
		acquired = true;
		const plan = await planResume(deps, { record, agent, session, request }, ctx, signal);
		return await startResume(
			deps,
			{ record, session, plan, task: request.task, toolCallId: request.toolCallId, placement, reservation },
			ctx,
		);
	} catch (error) {
		try {
			failedTree(reservation);
		} catch (accounting) {
			ctx.ui.notify(`delegate: reservation remains charged: ${String(accounting)}`, "error");
		}
		throw error;
	} finally {
		if (acquired) inFlight.delete(record.id);
	}
}

/**
 * The delegations that pass every check `resume` makes, newest first, read
 * with one `listWindows` and changing nothing: an exited window is left for
 * the resume itself to kill and trust is left for its prompt. The call-wide
 * prerequisites are checked once and refuse as `resume` does.
 */
async function eligible(deps: ResumeDeps, ctx: ExtensionContext): Promise<StartedRecorded[]> {
	await preflight(deps);
	const windows = await listWindows(deps.tmux);
	if (windows === undefined) return [];
	const ids = new Set(resumableIds(deps.results));
	const models = new Map<string, boolean>();
	const found: StartedRecorded[] = [];
	for (const record of startedRecords(deps.results)) {
		if (ids.has(record.id) && (await passes(deps, record, windows, ctx, models))) found.push(record);
	}
	return found.reverse();
}

/** The session a window opened in, for the start text. */
const inSession = (session: string | undefined): string => (session === undefined ? "" : ` in session ${session}`);

/** The one line the command and the tool tell the user. */
export function startedLine(resumed: Resumed): string {
	return `delegate: resumed ${resumed.resumedFrom} as ${resumed.id}: ${resumed.agent} in window ${resumed.windowName}${inSession(resumed.windowSession)}${resumed.fallbackNote === "" ? "" : `. ${resumed.fallbackNote}`}${resumed.notices.map((line) => `. ${line}`).join("")}`;
}

/** The `delegation_resume` tool. */
function resumeTool(deps: ResumeDeps): ToolDef {
	return {
		name: "delegation_resume",
		label: "Resume delegation",
		description:
			"Only this session’s direct children may be resumed; viewing a descendant does not grant authority, and fork/clone copies must return to the original parent. Current depth, grants, caps, tools and trust are checked again. Continue an exited delegate with a follow-up task: reopen its own session, so it keeps the context it built, in a new window. The follow-up is recorded as a new delegation, and its result arrives as a message on its own, like a delegate's. Use it when the next task needs what the delegate already read or decided; for unrelated work, use delegate. It refuses a delegation that is still running (send it a message instead), one whose window is still open, an older delegation of a chain that was already resumed (it names the newest), and one whose working directory is gone, a removed worktree included. A delegate whose window was killed mid-turn can be resumed.",
		parameters: Type.Object({
			id: Type.String({ description: "The delegation to resume, from a delegate result or delegation_status." }),
			task: Type.String({
				description: "The follow-up task. The delegate sees its earlier conversation plus this.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"provider/id to resume on; used as given. Omit to continue on the model the delegate finished on, or its agent's next fallback when that one is unavailable. Not used when the agent locks model: the agent's current model applies.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description: `Thinking level (${THINKING_LEVELS.join(", ")}); defaults to the level the delegate last ran on, from its session. Not used when the agent locks thinking: the agent's current level applies.`,
				}),
			),
			auto_exit: Type.Optional(
				Type.Boolean({ description: "Close the window once it finishes; defaults to the delegation's setting." }),
			),
		}),
		outputSchema: resultSchema(deps.delegateSchema),
		// Opens a window and removes nothing but an exited window of the old run; each call starts another run.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(
			toolCallId: string,
			params: { id: string; task: string; model?: string | null; thinking?: string | null; auto_exit?: boolean | null },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const resumed = await resume(deps, { ...requestFrom(params), toolCallId }, ctx, signal);
			const { fallbackNote, ...details } = resumed;
			ctx.ui.notify(startedLine(resumed), "info");
			return toolResult(
				`Resumed delegation ${resumed.resumedFrom} as ${resumed.id}: ${resumed.agent} (${resumed.model}, thinking ${resumed.thinking}) in window ${resumed.windowName}${inSession(resumed.windowSession)}. It runs in the background, and its result arrives as a message that starts your next turn on its own; delegation_close ends it.${fallbackNote === "" ? "" : ` ${fallbackNote}`}${resumed.notices.map((line) => ` ${line}`).join("")}`,
				{ outcome: "started", ...details },
			);
		},
	};
}

/** The request a tool call makes; some models fill every optional field with null or the string "null", and both mean unset. */
function requestFrom(params: {
	id: string;
	task: string;
	model?: string | null;
	thinking?: string | null;
	auto_exit?: boolean | null;
}): ResumeRequest {
	const given = (value: string | null | undefined): string | undefined =>
		value == null || value === "null" ? undefined : value;
	return {
		id: params.id,
		task: params.task ?? "",
		model: given(params.model),
		thinking: given(params.thinking),
		autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : undefined,
	};
}

/** Resuming as a function for the command, and the tool for the model. */
export function createResume(deps: ResumeDeps): {
	resume(request: ResumeRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<Resumed>;
	/** The delegations a resume would accept now, newest first. */
	eligible(ctx: ExtensionContext): Promise<StartedRecorded[]>;
	tool(): ToolDef;
} {
	return {
		eligible: (ctx: ExtensionContext) => eligible(deps, ctx),
		resume: (request: ResumeRequest, ctx: ExtensionContext, signal?: AbortSignal) => resume(deps, request, ctx, signal),
		tool: () => resumeTool(deps),
	};
}

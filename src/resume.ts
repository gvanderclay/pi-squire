// Resuming an exited delegate: the eligibility checks, the launch that reopens
// its own session file, and the `delegation_resume` tool. A resume is recorded
// as a new delegation (`resumedFrom` the old id) that keeps the old session id
// (`sessionId`), so mail, replies and usage-limit marks still find the session.
// Eligibility/model/trust stay here; DelegateStarter owns the start sequence.
import { randomUUID } from "node:crypto";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";
import { type Agent, type Roster, THINKING_LEVELS } from "./agents.ts";
import type { ChildStart, DelegateStarter } from "./delegate-start.ts";
import type { DelegateHost, OpenedWindow } from "./host.ts";
import type { AdmittedHost, HostAdmission } from "./host-admission.ts";
import type { Identity } from "./identity.ts";
import { openedIn } from "./location.ts";
import { windowPresentation } from "./locators.ts";
import { fallbackNote } from "./model-choice.ts";
import { sessionIdOf } from "./result-sessions.ts";
import { isStarted, type Results, recordedName, type StartedRecorded } from "./results.ts";
import {
	assertNoOwner,
	guardSession,
	inFlight,
	passes,
	preflight,
	recordCheck,
	type SessionFile,
	settleModel,
	windowCheck,
} from "./resume-checks.ts";
import type { RoutedChoice, RouteOptions } from "./routing-dispatch.ts";
import { RoutingRequestSchema } from "./routing-schema.ts";
import type { RoutingRecord, RoutingRequest } from "./routing-types.ts";
import { type ToolDef, toolResult } from "./tracking.ts";
import type { Reservation } from "./tree-registry.ts";
import { recordedIdentity } from "./tree-view.ts";
import { askWindowStates } from "./window-state.ts";
import type { Workspace } from "./workspace.ts";

/** What a resume asks for; the fields after `task` are optional overrides. */
export type ResumeRequest = {
	id: string;
	routing?: RoutingRequest;
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
	chooseRouting?(agent: Agent, request: unknown, ctx: ExtensionContext, options: RouteOptions): Promise<RoutedChoice>;
	results: Results;
	tmux: DelegateHost;
	/** The `delegate` tool's result schema, which a resume's result extends. */
	delegateSchema: TObject;
	admission: HostAdmission;
	starter: DelegateStarter;
	childTools(agent: Agent): readonly string[];
	roster(ctx: ExtensionContext): Roster;
	/** Depth/current-parent grant check, before even an exited window is killed. */
	admit?(agent: string, ctx: ExtensionContext): void;
	authorize?(id: string, ctx: ExtensionContext): void;
	/** The parent's current model and thinking level, which a field the agent locks but does not set keeps. */
	parentDefaults(ctx: ExtensionContext): { model?: string; thinking: string };
	chooseModel(
		explicit: string | undefined,
		agent: Agent,
		models: ModelRegistry,
		preferred: readonly string[],
	): Promise<{ model: string; skipped: Skipped[]; notices: string[]; rest: string[]; routing?: RoutingRecord }>;
	thinkingProblem(value: string): string | undefined;
	/** The workspace and trust for an existing directory, deciding trust again. */
	prepareDirectory(
		cwd: string,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		agent: string,
	): Promise<{ workspace: Workspace; trusted: boolean }>;
};

/** A started resume: what the tool and the command report. */
export type Resumed = {
	id: string;
	routing?: RoutingRecord;
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
	/** The adapter's own wording for where it opened; absent keeps the legacy window wording. */
	location?: string;
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

/** Steps 3 and 4, then the idempotent close of an exited window; `windowCheck` is the part the picker shares. */
async function ensureExited(record: StartedRecorded, tmux: DelegateHost): Promise<void> {
	const windows = await askWindowStates(tmux);
	windowCheck(record, windows);
	try {
		await windows.close(record);
	} catch (err) {
		throw new Error(
			`could not kill the exited window ${windowPresentation(record).windowName} (${windowPresentation(record).windowId}): ${(err as Error).message}`,
		);
	}
}

/** The tool's result: the `delegate` tool's plus the delegation it resumed. */
function resultSchema(delegateSchema: TObject): TObject {
	return Type.Object({
		...delegateSchema.properties,
		resumedFrom: Type.String(),
	});
}

/** The model, thinking and auto-exit a resume runs with, and the directory and workspace it opens in. */
type Plan = {
	start: ChildStart;
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
		start: {
			agent,
			model: chosen.model,
			rest: chosen.rest,
			thinking,
			autoExit,
			notices: chosen.notices,
			...("routing" in chosen ? { routing: chosen.routing } : {}),
		},
		chosen,
		workspace,
		trusted: prepared.trusted,
	};
}

async function startResume(
	deps: ResumeDeps,
	input: {
		record: StartedRecorded & { identity: Identity };
		session: SessionFile;
		plan: Plan;
		task: string;
		toolCallId: string | undefined;
		admission: AdmittedHost;
		reservation: Reservation;
	},
	ctx: ExtensionContext,
): Promise<Resumed> {
	const { record, session, plan, task, toolCallId, admission } = input;
	const { start, workspace } = plan;
	const id = input.reservation.id;
	const sessionId = sessionIdOf(record);
	const name = recordedName(record);
	const { opened } = await deps.starter.start(
		{
			id,
			name,
			identity: record.identity,
			session: { kind: "resume", id: record.id, path: session.path, sessionId },
			workspace,
			trusted: plan.trusted,
			sessionDir: session.dir,
			start,
			task,
			toolCallId,
			admission,
			// Read before open; a terminal resume mails only after it opens.
			tools: deps.childTools(start.agent),
		},
		ctx,
	);
	return resumedResult({ id, resumedFrom: record.id, name, plan, sessionDir: session.dir, opened });
}

/** What the command and the tool report about a started resume. */
function resumedResult(input: {
	id: string;
	resumedFrom: string;
	name: string;
	plan: Plan;
	sessionDir: string;
	opened: OpenedWindow;
}): Resumed {
	const { start, chosen, workspace } = input.plan;
	const { opened } = input;
	return {
		id: input.id,
		resumedFrom: input.resumedFrom,
		agent: start.agent.name,
		model: start.model,
		...(start.routing ? { routing: start.routing } : {}),
		skipped: chosen.skipped.map(({ model, reason }) => ({ model, reason })),
		notices: chosen.notices,
		thinking: start.thinking,
		autoExit: start.autoExit,
		windowId: opened.id,
		windowName: input.name,
		...(opened.session === undefined ? {} : { windowSession: opened.session }),
		cwd: workspace.cwd,
		sessionDir: input.sessionDir,
		workspace,
		...(opened.location === undefined ? {} : { location: opened.location }),
		fallbackNote: fallbackNote({ model: start.model, routing: start.routing, skipped: chosen.skipped }),
	};
}

/** Resolve once before any exited-window kill; never reconstruct a lost root from cwd. */
function requiredIdentity(record: StartedRecorded): Identity {
	const own = recordedIdentity(record);
	if (!own) throw new Error(`delegation ${record.id} has no original root placement identity; resume refused`);
	return own;
}

/** Resume `request.id`: every eligibility check in order, then the launch. */
async function resume(
	deps: ResumeDeps,
	request: ResumeRequest,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Resumed> {
	const admission = await preflight(deps); // read once, before the exited window is killed or anything is mailed
	const { client } = admission;
	if (request.task.trim() === "") throw new Error("a task is required");
	deps.authorize?.(request.id, ctx);
	const found = newestStarted(deps.results, request.id);
	const record = { ...found, identity: requiredIdentity(found) };
	deps.admit?.(record.agent, ctx);
	// Host evidence first, so a restored resource is named; the owner check still refuses any other live writer.
	await guardSession(deps, record, client, ctx);
	assertNoOwner(record);
	deps.results.checkStorage(true);
	const reservation = await deps.starter.reserveResume(record, randomUUID(), ctx);
	let acquired = false;
	try {
		await ensureExited(record, deps.tmux);
		const { session, agent } = recordCheck(deps, record, ctx);
		inFlight.add(record.id);
		acquired = true;
		const plan = await planResume(deps, { record, agent, session, request }, ctx, signal);
		return await startResume(
			deps,
			{
				record,
				session,
				plan,
				task: request.task,
				toolCallId: request.toolCallId,
				admission,
				reservation,
			},
			ctx,
		);
	} catch (error) {
		deps.starter.refund(reservation, ctx);
		throw error;
	} finally {
		if (acquired) inFlight.delete(record.id);
	}
}

/**
 * The delegations that pass every check `resume` makes, newest first, read
 * with one window-state ask and changing nothing: an exited window is left for
 * the resume itself to close and trust is left for its prompt. The call-wide
 * prerequisites are checked once and refuse as `resume` does.
 */
async function eligible(deps: ResumeDeps, ctx: ExtensionContext): Promise<StartedRecorded[]> {
	const { client } = await preflight(deps);
	const windows = await askWindowStates(deps.tmux);
	if (!windows.answered) return [];
	const ids = new Set(resumableIds(deps.results));
	const models = new Map<string, boolean>();
	const found: StartedRecorded[] = [];
	for (const record of startedRecords(deps.results)) {
		if (!ids.has(record.id) || !(await passes(deps, record, windows, ctx, models))) continue;
		const guarded = await guardSession(deps, record, client, ctx).then(
			() => true,
			() => false,
		);
		if (guarded) found.push(record);
	}
	return found.reverse();
}

/** The one line the command and the tool tell the user. */
export function startedLine(resumed: Resumed): string {
	return `delegate: resumed ${resumed.resumedFrom} as ${resumed.id}: ${resumed.agent} in ${openedIn(resumed)}${resumed.fallbackNote === "" ? "" : `. ${resumed.fallbackNote}`}${resumed.notices.map((line) => `. ${line}`).join("")}`;
}

/** The `delegation_resume` tool. */
function resumeTool(deps: ResumeDeps, includeRouting: boolean): ToolDef {
	return {
		name: "delegation_resume",
		label: "Resume delegation",
		description:
			"Continue an exited direct child in its own session, so it keeps the context it built, with a follow-up task in a new window. It is recorded as a new delegation. For unrelated work, use delegate. delegation_fork copies a child's context into a new child; find it with tool search. Refuses a running delegation (mail it instead), an open window, an older link of a resumed chain (it names the newest) and a missing working directory.",
		parameters: Type.Object({
			id: Type.String({ description: "The newest delegation id of the child." }),
			...(includeRouting ? { routing: Type.Optional(RoutingRequestSchema) } : {}),
			task: Type.String(),
			model: Type.Optional(Type.String({ description: "provider/id; defaults to the model it finished on." })),
			thinking: Type.Optional(
				Type.String({ description: `${THINKING_LEVELS.join(", ")}; defaults to the level it last ran on.` }),
			),
			auto_exit: Type.Optional(Type.Boolean({ description: "Defaults to the delegation's setting." })),
		}),
		outputSchema: resultSchema(deps.delegateSchema),
		// Opens a window and removes nothing but an exited window of the old run; each call starts another run.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(
			toolCallId: string,
			params: {
				id: string;
				task: string;
				routing?: RoutingRequest;
				model?: string | null;
				thinking?: string | null;
				auto_exit?: boolean | null;
			},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const resumed = await resume(deps, { ...requestFrom(params), toolCallId }, ctx, signal);
			const { fallbackNote, location: _location, ...details } = resumed;
			ctx.ui.notify(startedLine(resumed), "info");
			return toolResult(
				`Resumed delegation ${resumed.resumedFrom} as ${resumed.id}: ${resumed.agent} (${resumed.model}, thinking ${resumed.thinking}) in ${openedIn(resumed)}. It runs in the background, and its result arrives as a message that starts your next turn on its own; delegation_close ends it.${fallbackNote === "" ? "" : ` ${fallbackNote}`}${resumed.notices.map((line) => ` ${line}`).join("")}`,
				{ outcome: "started", ...details },
			);
		},
	};
}

/** The request a tool call makes; some models fill every optional field with null or the string "null", and both mean unset. */
function requestFrom(params: {
	routing?: RoutingRequest;
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
		routing: params.routing,
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
	tool(includeRouting?: boolean): ToolDef;
} {
	return {
		eligible: (ctx: ExtensionContext) => eligible(deps, ctx),
		resume: (request: ResumeRequest, ctx: ExtensionContext, signal?: AbortSignal) => resume(deps, request, ctx, signal),
		tool: (includeRouting = true) => resumeTool(deps, includeRouting),
	};
}

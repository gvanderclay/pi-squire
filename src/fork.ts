import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { disabledProblem, THINKING_LEVELS } from "./agents.ts";
import { openedIn } from "./location.ts";
import { fallbackNote } from "./model-choice.ts";
import { dirtyNotice } from "./render.ts";
import { finishedModel, sessionIdOf, sessionInputTokens } from "./result-sessions.ts";
import { deriveState, isStarted, type StartedRecorded } from "./results.ts";
import type { ResumeDeps, Resumed } from "./resume.ts";
import { sessionFor, settleModel } from "./resume-checks.ts";
import { RoutingRequestSchema } from "./routing-schema.ts";
import type { RoutingRecord, RoutingRequest } from "./routing-types.ts";
import { type ToolDef, toolResult } from "./tracking.ts";
import { assertChildAuthority, recordedIdentity } from "./tree-view.ts";
import { askWindowStates } from "./window-state.ts";

export type ForkSource = {
	id: string;
	sessionPath: string;
	sessionId: string;
	sessionDir: string;
	rootPlacement: string;
	sourceCwd: string;
};
type Forked = Omit<Resumed, "resumedFrom" | "fallbackNote">;
type ForkRequest = {
	routing?: RoutingRequest;
	id: string;
	task: string;
	model?: string | null;
	thinking?: string | null;
	auto_exit?: boolean | null;
	worktree?: string | null;
	worktree_base?: string | null;
};
type ForkStart = Awaited<ReturnType<ResumeDeps["chooseModel"]>> & {
	routing?: RoutingRecord;
	agent: ReturnType<ResumeDeps["roster"]>["agents"][number];
	thinking: string;
	autoExit: boolean;
	task: string;
	cwd: string;
	worktree?: string;
	worktree_base?: string;
};
type ForkDeps = Pick<
	ResumeDeps,
	| "results"
	| "tmux"
	| "roster"
	| "parentDefaults"
	| "chooseModel"
	| "thinkingProblem"
	| "delegateSchema"
	| "chooseRouting"
> & {
	authorize(id: string, ctx: ExtensionContext): void;
	admit(agent: string, ctx: ExtensionContext): void;
	launch(
		start: ForkStart,
		source: ForkSource,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		toolCallId: string,
	): Promise<Forked>;
};

function given(value: string | null | undefined): string | undefined {
	return value == null || value === "null" ? undefined : value;
}

function sourceRecord(deps: ForkDeps, id: string, ctx: ExtensionContext): StartedRecorded {
	deps.authorize(id, ctx);
	const record = deps.results.find(id);
	if (!record) throw new Error(`no delegation ${JSON.stringify(id)}`);
	if (!isStarted(record)) throw new Error(`delegation ${id} is a workspace attempt, not a session to fork`);
	assertChildAuthority(record, ctx, "fork");
	deps.admit(record.agent, ctx);
	deps.results.checkStorage(true);
	return record;
}

function forkSource(record: StartedRecorded, session: ReturnType<typeof sessionFor>): ForkSource {
	const own = recordedIdentity(record);
	if (!own) throw new Error(`delegation ${record.id} has no original root placement identity; fork refused`);
	return {
		id: record.id,
		sessionPath: session.path,
		sessionId: sessionIdOf(record),
		sessionDir: session.dir,
		rootPlacement: own.rootPlacement,
		sourceCwd: session.cwd,
	};
}

async function sharedFolderNotice(deps: ForkDeps, record: StartedRecorded, worktree?: string): Promise<string[]> {
	if (worktree || deriveState(record, (await askWindowStates(deps.tmux)).state(record)) !== "running") return [];
	return [`shares a working folder with running delegation ${record.id}; pass worktree to isolate`];
}

function modelNotice(record: StartedRecorded, sessionPath: string, model: string): string[] {
	const sourceModel = finishedModel(sessionPath) ?? record.result?.finishedModel ?? record.model;
	if (model === sourceModel) return [];
	const tokens = sessionInputTokens(sessionPath);
	const estimate = tokens === undefined ? "copied tokens" : `about ${Math.round(tokens / 1000)}k copied tokens`;
	return [`${model} differs from the source's ${sourceModel}: ${estimate} will be written to a new cache.`];
}

function launchText(id: string, details: Forked, chosen: Awaited<ReturnType<ResumeDeps["chooseModel"]>>): string {
	const workspace = details.workspace;
	const note = fallbackNote({ model: details.model, skipped: chosen.skipped, routing: details.routing });
	const managed =
		workspace.mode === "managed"
			? ` Branch ${workspace.createdBranch} starts at ${workspace.baseCommit}. ${dirtyNotice(workspace.sourceDirty)}`
			: "";
	return `Forked delegation ${id} as ${details.id} in ${openedIn(details, { session: false })} in ${details.cwd}.${managed} The original session is untouched. Its result arrives as a message that starts your next turn on its own; delegation_close ends it.${note ? ` ${note}` : ""}${details.notices.map((notice) => ` ${notice}`).join("")}`;
}

/** `location` words the text only; the structured result keeps the delegate schema. */
function withoutLocation(details: Forked): Omit<Forked, "location"> {
	const { location: _location, ...rest } = details;
	return rest;
}

const modelParameter = Type.Optional(
	Type.String({
		description:
			"provider/id; defaults to the source's last model. A different model re-reads the copied context without its cache; keep the source's model unless the task needs another role.",
	}),
);

function forkParameters(includeRouting: boolean): TObject {
	return Type.Object({
		id: Type.String({ description: "The direct child's delegation id whose context to copy." }),
		task: Type.String(),
		...(includeRouting ? { routing: Type.Optional(RoutingRequestSchema) } : {}),
		model: modelParameter,
		thinking: Type.Optional(
			Type.String({ description: `${THINKING_LEVELS.join(", ")}; defaults to the source's last level.` }),
		),
		auto_exit: Type.Optional(Type.Boolean({ description: "Defaults to the source delegation's setting." })),
		worktree: Type.Optional(
			Type.String({ description: "New branch for a managed worktree from the child's checkout." }),
		),
		worktree_base: Type.Optional(
			Type.String({ description: "Local commit-ish; requires worktree. Defaults to the child's checkout HEAD." }),
		),
	});
}

/** The fork tool is deferred: it starts undeclared and `tool_search` or activation declares it. */
export type ForkTool = ToolDef & { exposure: "deferred" };

export function forkTool(deps: ForkDeps, includeRouting = true): ForkTool {
	return {
		name: "delegation_fork",
		label: "Fork delegation",
		// Deferred keeps its declaration, about 1,200 tokens, out of requests until it is activated; it stays callable.
		exposure: "deferred",
		description:
			"Start a new direct child from a copy of an existing child's session context, with a new task, session id and window. The original child is untouched and may still be running. Runs in its working folder, or a new managed worktree from that folder's checkout. Results arrive as messages like other delegations.",
		parameters: forkParameters(includeRouting),
		outputSchema: Type.Object({ ...deps.delegateSchema.properties, forkedFrom: Type.String() }),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(
			toolCallId: string,
			params: ForkRequest,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			if (!params.task?.trim()) throw new Error("a task is required");
			const record = sourceRecord(deps, params.id, ctx);
			const session = sessionFor(record, ctx, "forkable");
			const roster = deps.roster(ctx);
			const disabled = disabledProblem(roster, record.agent);
			if (disabled) throw new Error(disabled);
			const agent = roster.agents.find((item) => item.name === record.agent);
			if (!agent) throw new Error(`agent ${JSON.stringify(record.agent)} is no longer in the roster`);
			const { thinking, chosen } = await settleModel(
				deps,
				{
					record,
					agent,
					session,
					request: { model: given(params.model), thinking: given(params.thinking), routing: params.routing },
				},
				ctx,
			);
			const source = forkSource(record, session);
			chosen.notices.push(...(await sharedFolderNotice(deps, record, given(params.worktree))));
			const details = await deps.launch(
				{
					...chosen,
					agent,
					thinking,
					autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : record.autoExit === true,
					task: params.task,
					cwd: session.cwd,
					worktree: given(params.worktree),
					worktree_base: given(params.worktree_base),
				},
				source,
				ctx,
				signal,
				toolCallId,
			);
			details.notices.push(...modelNotice(record, source.sessionPath, details.model));
			const line = launchText(record.id, details, chosen);
			ctx.ui.notify(`delegate: ${line}`, "info");
			return toolResult(line, { outcome: "started", ...withoutLocation(details), forkedFrom: record.id });
		},
	};
}

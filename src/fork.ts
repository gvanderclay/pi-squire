import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { disabledProblem, THINKING_LEVELS } from "./agents.ts";
import { isStarted, type StartedRecorded } from "./results.ts";
import type { ResumeDeps, Resumed } from "./resume.ts";
import { sessionFor, settleModel } from "./resume-checks.ts";
import { type ToolDef, toolResult } from "./tracking.ts";
import { assertChildAuthority, recordedIdentity } from "./tree-view.ts";

export type ForkSource = { id: string; sessionPath: string; sessionDir: string; rootPlacement: string };
type ForkRequest = {
	id: string;
	task: string;
	model?: string | null;
	thinking?: string | null;
	auto_exit?: boolean | null;
	worktree?: string | null;
	worktree_base?: string | null;
};
type ForkStart = Awaited<ReturnType<ResumeDeps["chooseModel"]>> & {
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
	"results" | "roster" | "parentDefaults" | "chooseModel" | "thinkingProblem" | "delegateSchema"
> & {
	authorize(id: string, ctx: ExtensionContext): void;
	admit(agent: string, ctx: ExtensionContext): void;
	launch(
		start: ForkStart,
		source: ForkSource,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		toolCallId: string,
	): Promise<Omit<Resumed, "resumedFrom" | "fallbackNote">>;
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

function fallbackNote(chosen: Awaited<ReturnType<ResumeDeps["chooseModel"]>>): string {
	return chosen.skipped.length
		? ` Used fallback ${chosen.model} because ${chosen.skipped.map((item) => `${item.model} is ${item.why}`).join("; ")}.`
		: "";
}

export function forkTool(deps: ForkDeps): ToolDef {
	return {
		name: "delegation_fork",
		label: "Fork delegation",
		description:
			"Start a new direct child from a copy of an existing child's session context, with a new task, session id and window. The original child is untouched and may still be running. Runs in its working folder, or a new managed worktree from that folder's checkout. Results arrive as messages like other delegations.",
		parameters: Type.Object({
			id: Type.String({ description: "The direct child's delegation id whose context to copy." }),
			task: Type.String(),
			model: Type.Optional(Type.String({ description: "provider/id; defaults to the source's last model." })),
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
		}),
		outputSchema: Type.Object({ ...deps.delegateSchema.properties, forkedFrom: Type.String() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
				{ record, agent, session, request: { model: given(params.model), thinking: given(params.thinking) } },
				ctx,
			);
			const own = recordedIdentity(record);
			if (!own) throw new Error(`delegation ${record.id} has no original root placement identity; fork refused`);
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
				{ id: record.id, sessionPath: session.path, sessionDir: session.dir, rootPlacement: own.rootPlacement },
				ctx,
				signal,
				toolCallId,
			);
			const line = `Forked delegation ${record.id} as ${details.id} in window ${details.windowName}. The original session is untouched. Its result arrives as a message that starts your next turn on its own; delegation_close ends it.${fallbackNote(chosen)}${details.notices.map((notice) => ` ${notice}`).join("")}`;
			ctx.ui.notify(`delegate: ${line}`, "info");
			return toolResult(line, { outcome: "started", ...details, forkedFrom: record.id });
		},
	};
}

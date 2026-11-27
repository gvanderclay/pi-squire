import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";
import { THINKING_LEVELS } from "./agents.ts";
import { checkToolsReached } from "./delegate-check.ts";
import { CheckCommandsSchema, parseChecks } from "./delegate-request.ts";
import { openedIn } from "./location.ts";
import type { Resumed, ResumeRequest } from "./resume.ts";
import { RoutingFollowUpSchema } from "./routing-schema.ts";
import type { RoutingRequest } from "./routing-types.ts";
import { type ToolDef, toolResult } from "./tracking.ts";

/** The tool's result: the `delegate` tool's plus the delegation it resumed. */
function resultSchema(delegateSchema: TObject): TObject {
	return Type.Object({
		...delegateSchema.properties,
		resumedFrom: Type.String(),
	});
}

/** The `delegation_resume` tool. */
export function resumeTool(
	delegateSchema: TObject,
	includeRouting: boolean,
	resume: (request: ResumeRequest, ctx: ExtensionContext, signal?: AbortSignal) => Promise<Resumed>,
	startedLine: (resumed: Resumed) => string,
): ToolDef {
	return {
		name: "delegation_resume",
		label: "Resume delegation",
		description:
			"Continue an exited direct child's session with a follow-up task. Mail a running child. Use delegate for unrelated work or tool search for delegation_fork to copy context.",
		reachesTools: checkToolsReached,
		parameters: Type.Object({
			id: Type.String({ description: "Newest delegation id of the child." }),
			...(includeRouting ? { routing: Type.Optional(RoutingFollowUpSchema) } : {}),
			task: Type.String(),
			model: Type.Optional(Type.String({ description: "provider/id; defaults to the model it finished on." })),
			thinking: Type.Optional(
				Type.String({ description: `${THINKING_LEVELS.join(", ")}; defaults to the level it last ran on.` }),
			),
			auto_exit: Type.Optional(Type.Boolean({ description: "Defaults to the last run's setting." })),
			check: Type.Optional(CheckCommandsSchema),
		}),
		outputSchema: resultSchema(delegateSchema),
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
				check?: unknown;
			},
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<ReturnType<typeof toolResult>> {
			const resumed = await resume({ ...requestFrom(params), toolCallId }, ctx, signal);
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
	check?: unknown;
}): ResumeRequest {
	const given = (value: string | null | undefined): string | undefined =>
		value == null || value === "null" ? undefined : value;
	return {
		id: params.id,
		routing: params.routing,
		task: params.task ?? "",
		model: given(params.model),
		thinking: given(params.thinking),
		check: parseChecks(params.check),
		autoExit: typeof params.auto_exit === "boolean" ? params.auto_exit : undefined,
	};
}

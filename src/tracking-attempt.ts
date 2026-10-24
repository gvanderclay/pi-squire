import { Type } from "typebox";
import { WorktreePlanSchema } from "./workspace.ts";

const ATTEMPT_PHASES = ["planned", "created", "rolled-back", "retained", "interrupted"] as const;

const ResourceSchema = Type.Union(
	[
		Type.Object({ kind: Type.Literal("none") }),
		Type.Object({ kind: Type.Literal("branch"), branch: Type.String(), head: Type.String() }),
		Type.Object({ kind: Type.Literal("worktree"), cwd: Type.String(), branch: Type.String(), head: Type.String() }),
		Type.Object({
			kind: Type.Literal("unknown"),
			reason: Type.String(),
			observedPaths: Type.Array(Type.String()),
			observedRefs: Type.Array(Type.String()),
		}),
	],
	{ description: "What is known to exist for a launch that has no window, as facts." },
);

const AttemptStateSchema = Type.Union([
	Type.Object({ phase: Type.Literal("planned"), resources: ResourceSchema }),
	Type.Object({ phase: Type.Literal("created"), resources: ResourceSchema }),
	Type.Object({
		phase: Type.Literal("rolled-back"),
		resources: Type.Object({ kind: Type.Literal("none") }),
		cause: Type.String(),
	}),
	Type.Object({
		phase: Type.Literal("retained"),
		resources: ResourceSchema,
		cause: Type.String(),
		recovery: Type.Array(Type.String(), {
			description: "Non-forced commands that remove exactly the resources known to remain.",
		}),
	}),
	Type.Object({
		phase: Type.Literal("interrupted"),
		resources: ResourceSchema,
		lastPhase: Type.Union([Type.Literal("planned"), Type.Literal("created")]),
		reason: Type.String(),
	}),
]);

/** A managed launch that has no window: never running, never closable, with no window id. */
export const AttemptSchema = Type.Object({
	kind: Type.Literal("workspace-attempt"),
	id: Type.String(),
	parentId: Type.String(),
	agent: Type.String(),
	model: Type.String(),
	thinking: Type.String(),
	name: Type.Optional(Type.String()),
	sessionDir: Type.String(),
	plan: WorktreePlanSchema,
	attempt: AttemptStateSchema,
	requestId: Type.Optional(Type.String({ description: "The task's request id, only when mail really returned one." })),
	state: Type.Union(
		ATTEMPT_PHASES.map((phase) => Type.Literal(phase)),
		{
			description:
				"planned, created: a launch in progress. rolled-back: failed before a window and everything was removed. retained: failed before a window and something remains (see attempt.recovery). interrupted: the parent ended mid-launch; what exists is unknown. No window was opened.",
		},
	),
});

import { Type } from "typebox";

const ATTEMPT_PHASES = ["planned", "created", "rolled-back", "retained", "interrupted"] as const;
const PHASE = Type.Enum(ATTEMPT_PHASES);

/** No published start: resource progress is recovery evidence, not proof an agent exists. */
export const AttemptSchema = Type.Object(
	{
		kind: Type.Literal("workspace-attempt"),
		id: Type.String(),
		parentId: Type.String(),
		agent: Type.String(),
		model: Type.String(),
		thinking: Type.String(),
		name: Type.Optional(Type.String()),
		sessionDir: Type.String(),
		plan: Type.Object({ branch: Type.String(), destination: Type.String() }, { additionalProperties: true }),
		attempt: Type.Object({ phase: PHASE }, { additionalProperties: true }),
		requestId: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
		state: PHASE,
	},
	// Attempt journals pass through host-owned recovery facts, like WorkspaceSchema.
	{ additionalProperties: true },
);

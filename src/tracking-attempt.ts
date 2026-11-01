import { Type } from "typebox";

const ATTEMPT_PHASES = ["planned", "created", "rolled-back", "retained", "interrupted"] as const;
const PHASE = Type.Union(ATTEMPT_PHASES.map((phase) => Type.Literal(phase)));

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
	plan: Type.Object({ branch: Type.String(), destination: Type.String() }, { additionalProperties: true }),
	attempt: Type.Object({ phase: PHASE }, { additionalProperties: true }),
	requestId: Type.Optional(Type.String()),
	state: PHASE,
});

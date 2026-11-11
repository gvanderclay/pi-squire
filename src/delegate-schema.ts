import { Type } from "typebox";
import { RoutingRecordSchema } from "./routing-schema.ts";
import { WorkspaceSchema } from "./workspace.ts";

/** The `delegate` tool's structured result, which is also its details. */
export const DelegateSchema = Type.Object({
	outcome: Type.Literal("started"),
	id: Type.String(),
	agent: Type.String(),
	model: Type.String(),
	skipped: Type.Array(Type.Object({ model: Type.String(), reason: Type.String() })),
	notices: Type.Array(Type.String()),
	thinking: Type.String(),
	autoExit: Type.Boolean(),
	windowId: Type.String(),
	windowName: Type.String(),
	windowSession: Type.Optional(Type.String()),
	cwd: Type.String(),
	sessionDir: Type.String(),
	workspace: WorkspaceSchema,
	routing: Type.Optional(RoutingRecordSchema),
});

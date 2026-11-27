import { Type } from "typebox";

const Names = Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true });
const Category = Type.Union([
	Type.Literal("narrow"),
	Type.Literal("bounded"),
	Type.Literal("standard"),
	Type.Literal("deep"),
]);
const Data = Type.Union([Type.Literal("private"), Type.Literal("public"), Type.Literal("unknown")]);
export const RoutingRequestSchema = Type.Object(
	{
		category: Category,
		data: Data,
		safePublicContext: Type.Optional(
			Type.Boolean({
				description:
					"Attests task, instructions, inherited context, workspace and tool reads are public-safe; not isolation.",
			}),
		),
		requirements: Type.Optional(
			Type.Object(
				{
					contextTokens: Type.Optional(Type.Integer({ minimum: 0 })),
					input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
					tools: Type.Optional(Names),
					capabilities: Type.Optional(Names),
				},
				{ additionalProperties: false },
			),
		),
		review: Type.Optional(
			Type.Object(
				{
					authors: Type.Array(Type.String(), {
						minItems: 1,
						uniqueItems: true,
						description:
							"Every author source: self (parent active branch) or known delegation ids; never family names.",
					}),
				},
				{ additionalProperties: false },
			),
		),
	},
	{
		additionalProperties: false,
		description: "Required for an agent with a routing profile; others reject routing metadata.",
	},
);
/**
 * The routing parameter of delegation_resume and delegation_fork, declared beside
 * `delegate`: it types the required fields and points at delegate's full schema,
 * which `parseRoutingRequest` still enforces, instead of repeating it.
 */
export const RoutingFollowUpSchema = Type.Object(
	{ category: Category, data: Data },
	{ additionalProperties: true, description: "Required for a routed agent; other fields as in delegate's routing." },
);
export const RoutingRecordSchema = Type.Record(Type.String(), Type.Unknown());

/** Runtime evidence, not the frozen dispatch record; shared by status output and its TypeScript type. */
export const RoutingEvidenceSchema = Type.Object(
	{
		served: Type.Array(
			Type.Object(
				{ model: Type.String(), thinking: Type.Optional(Type.String()), entryId: Type.String() },
				{ additionalProperties: false },
			),
		),
		fallbacks: Type.Array(
			Type.Object(
				{
					from: Type.String(),
					to: Type.String(),
					reason: Type.String(),
					requestedThinking: Type.String(),
					effectiveThinking: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		complete: Type.Boolean(),
		independent: Type.Enum(["verified", "not-required", "unverified"]),
		reasons: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

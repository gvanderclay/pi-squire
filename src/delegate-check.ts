import { isAbsolute } from "node:path";
import type {
	AgentToolResult,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { parseChecks } from "./delegate-request.ts";

export const CHECK_TOOL_NAME = "delegate_check";
const ApprovalSchema = Type.Object({
	command: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }),
	delegation: Type.String({ minLength: 1 }),
});
type Approval = Static<typeof ApprovalSchema>;

export type ApprovedCheck = { cwd: string; commands: readonly string[] };

export function checkToolsReached(input: Record<string, unknown>): readonly string[] {
	return input.check === undefined ? [] : [CHECK_TOOL_NAME];
}

export function checkTool(): ToolDefinition<typeof ApprovalSchema, Approval> {
	return {
		name: CHECK_TOOL_NAME,
		label: "Approve delegate check",
		exposure: "deferred" as const,
		description: "Permission hook for a delegate result check. This tool does not run the command.",
		parameters: ApprovalSchema,
		outputSchema: ApprovalSchema,
		async execute(_id: string, input: Approval): Promise<AgentToolResult<Approval>> {
			const { command, cwd, delegation } = input;
			const details = { command, cwd, delegation };
			return {
				content: [{ type: "text" as const, text: `Check approved for delegation ${delegation}.` }],
				details,
				structuredContent: details,
			};
		},
	};
}

export async function approveChecks(
	commands: readonly string[],
	cwd: string,
	delegation: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ApprovedCheck> {
	const tools: Partial<ExtensionToolContext> = ctx;
	const refusal = (command: string, reason: string): Error =>
		new Error(`check ${JSON.stringify(command)} refused: ${reason}`);
	if (typeof tools.executeTool !== "function")
		throw refusal(commands[0], "this Pi tool context does not support executeTool");
	if (!tools.tools?.some((tool) => tool.name === CHECK_TOOL_NAME))
		throw refusal(commands[0], `${CHECK_TOOL_NAME} is not callable in this session; check its tool allowlist`);
	for (const command of commands) {
		if (signal?.aborted) throw refusal(command, "the launch was aborted");
		const outcome = await tools.executeTool(CHECK_TOOL_NAME, { command, cwd, delegation }, { signal });
		if (outcome.isError || outcome.result.isError === true) {
			const reason = outcome.result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			throw refusal(command, reason || "the approval tool returned an error");
		}
		const approved: Partial<Approval> | undefined = outcome.result.details;
		if (approved?.command !== command || approved.cwd !== cwd || approved.delegation !== delegation)
			throw refusal(command, "the approval did not match the requested command and directory");
		if (signal?.aborted) throw refusal(command, "the launch was aborted");
	}
	return { cwd, commands: [...commands] };
}

export function validateApprovedCheck(value: unknown, cwd: string | undefined): void {
	if (value === undefined) return;
	if (
		!value ||
		typeof value !== "object" ||
		!("cwd" in value) ||
		typeof value.cwd !== "string" ||
		!isAbsolute(value.cwd) ||
		value.cwd !== cwd ||
		!("commands" in value) ||
		parseChecks(value.commands) === undefined
	)
		throw new Error("invalid approved delegate check; restoration blocked");
}

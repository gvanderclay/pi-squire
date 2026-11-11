import { parseArgs } from "@earendil-works/pi-coding-agent";
import { toolMatches } from "./tool-names.ts";

export const ROUTING_ENV = "PI_DELEGATE_ROUTING";
type Payload = { args: string[]; env: Record<string, string> };
function validateTools(
	original: ReturnType<typeof parseArgs>,
	final: ReturnType<typeof parseArgs>,
	requiredTools: readonly string[],
): void {
	const tools: string[] = final.noTools ? [] : (final.tools ?? []);
	if (
		requiredTools.some(
			(name) =>
				!tools.some((pattern) => toolMatches(pattern, name)) ||
				final.excludeTools?.some((pattern) => toolMatches(pattern, name)),
		)
	)
		throw new Error("session:launch removed required routed tools; launch refused");
	if (requiredTools.length && final.noBuiltinTools !== original.noBuiltinTools)
		throw new Error("session:launch changed builtin availability for required routed tools");
	if (
		tools.some(
			(name) =>
				!original.tools?.some((pattern) => name === pattern || (!name.includes("*") && toolMatches(pattern, name))),
		)
	)
		throw new Error("session:launch broadened routed tools; launch refused");
}

/** Routed hooks may add unrelated flags/env or narrow tools, never rewrite routing/session/consent invariants. */
export function validateRoutedLaunch(
	before: Payload,
	after: Payload,
	commandLength: number,
	requiredTools: readonly string[] = [],
): void {
	if (before.args.some((value, index) => after.args[index] !== value))
		throw new Error("session:launch rewrote routed launch arguments; append only");
	for (const [key, value] of Object.entries(before.env))
		if (after.env[key] !== value) throw new Error(`session:launch changed routed environment ${key}`);
	if (after.env.PI_DELEGATE_FALLBACK !== undefined)
		throw new Error("session:launch added unrestricted fallback to routed launch");
	const original: ReturnType<typeof parseArgs> = parseArgs(before.args.slice(commandLength));
	const final: ReturnType<typeof parseArgs> = parseArgs(after.args.slice(commandLength));
	if (final.diagnostics.some((item) => item.type === "error"))
		throw new Error("session:launch produced invalid routed CLI arguments");
	for (const key of [
		"model",
		"provider",
		"thinking",
		"session",
		"sessionId",
		"fork",
		"sessionDir",
		"projectTrustOverride",
		"noSession",
		"noExtensions",
		"continue",
		"resume",
	] as const)
		if (original[key] !== final[key])
			throw new Error(`session:launch changed routed ${key}; launch refused before task delivery`);
	if (
		JSON.stringify(final.models) !== JSON.stringify(original.models) ||
		final.messages.length ||
		final.fileArgs.length
	)
		throw new Error("session:launch added routed scoped models or startup input; launch refused");
	validateTools(original, final, requiredTools);
}

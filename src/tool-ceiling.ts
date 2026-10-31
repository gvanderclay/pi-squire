// A nested launch is bounded by operations its direct parent can reach, not
// by the schemas currently displayed. CLI registration filtering also covers
// deferred tools and tools registered later by launch-time extensions.
import { type Args, type ExtensionAPI, parseArgs, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Match Pi's tool-list glob: only * has special meaning. */
export function toolMatches(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/** Includes active model-only operations, though ctx.executeTool cannot call those. */
export function availableTools(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">): string[] {
	const active = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter(
			(tool) =>
				tool.exposure !== "hidden" &&
				(active.has(tool.name) || tool.exposure === "codemode" || tool.exposure === "deferred"),
		)
		.map((tool) => tool.name);
}

type CeilingInput = {
	args: string[];
	available: readonly string[];
	registered?: readonly string[];
	cwd: string;
	agentDir: string;
	trusted: boolean;
	notices: string[];
};

function requestedTools(parsed: Args, input: CeilingInput): string[] {
	const requested = parsed.tools ?? [];
	if (!requested.some((name) => name.startsWith("+") || name.startsWith("-"))) return requested;
	// Pi modifiers replace the earlier --tools selection and modify the
	// child's defaults. Use Pi's trusted settings reader, not the parent's defaults.
	const defaults =
		parsed.noTools || parsed.noBuiltinTools
			? []
			: (SettingsManager.create(input.cwd, input.agentDir, { projectTrusted: input.trusted }).getDefaultTools() ?? [
					"read",
					"bash",
					"edit",
					"write",
				]);
	const selected = new Set(defaults);
	for (const entry of requested) {
		if (entry.startsWith("+")) selected.add(entry.slice(1));
		else selected.delete(entry.slice(1));
	}
	return [...selected];
}

function ceilingNotice(input: CeilingInput, requested: string[], exclusions: string[]): void {
	const { available } = input;
	const removed = [
		...new Set([
			...requested.filter((pattern) => pattern !== "mcp__" && !pattern.includes("*") && !available.includes(pattern)),
			...(input.registered ?? []).filter(
				(name) => !available.includes(name) && requested.some((pattern) => toolMatches(pattern, name)),
			),
		]),
	].filter((name) => !exclusions.some((pattern) => toolMatches(pattern, name)));
	// Child-only and future registrations cannot be enumerated in the parent.
	const bounded = [...new Set(requested.filter((pattern) => pattern.includes("*")))];
	if (!removed.length && !bounded.length) return;
	const parts = ["Nested tool ceiling:"];
	if (removed.length) parts.push(`removed unavailable tools ${removed.join(", ")}.`);
	if (bounded.length)
		parts.push(`Restricted patterns ${bounded.join(", ")} to exact tools available to the direct parent.`);
	input.notices.push(parts.join(" "));
}

/** Find an option terminator, not a -- token consumed as another flag’s value. */
function optionBoundary(args: string[]): number {
	let marker = "--squire-ceiling-boundary";
	while (args.includes(marker)) marker += "-";
	for (const [index, arg] of args.entries()) {
		if (arg === "--" && !parseArgs([...args.slice(0, index + 1), marker]).unknownFlags.has(marker.slice(2)))
			return index;
	}
	return args.length;
}

function exactName(name: string): boolean {
	return !!name && name.trim() === name && !name.includes("*") && !name.includes(",") && !/^[+-]/.test(name);
}

/**
 * Resolve the final customized CLI selection, then pin an exact registration
 * allowlist. Run after all synchronous session:launch listeners, before spawn.
 * args excludes the executable/launcher prefix. Unrelated args stay unchanged.
 */
export function enforceToolCeiling(input: CeilingInput): void {
	const { args, available } = input;
	const parsed = parseArgs(args);
	const errors = parsed.diagnostics.filter((item) => item.type === "error");
	if (errors.length)
		throw new Error(`invalid nested launch arguments: ${errors.map((item) => item.message).join("; ")}`);
	const requested = requestedTools(parsed, input);
	const exclusions = parsed.excludeTools ?? [];
	const allowed = available.filter(
		(name) =>
			requested.some((pattern) => toolMatches(pattern, name)) &&
			!exclusions.some((pattern) => toolMatches(pattern, name)),
	);
	// Never turn a wildcard in a registered name into a grant pattern.
	if (!allowed.every(exactName))
		throw new Error("cannot encode the parent's tool names as an exact nested tool ceiling");
	ceilingNotice(input, requested, exclusions);
	const entries = allowed.some((name) => name.startsWith("mcp__")) ? allowed : [...allowed, "mcp__"];
	// --no-tools alone would leave a previous --tools value authoritative.
	const final = allowed.length ? ["--tools", entries.join(",")] : ["--tools", "", "--no-tools"];
	args.splice(optionBoundary(args), 0, ...final);
	const effective = parseArgs(args).tools;
	const expected = allowed.length ? entries : [];
	if (!effective || effective.length !== expected.length || effective.some((name, index) => name !== expected[index]))
		throw new Error("could not apply the nested tool ceiling to customized launch arguments");
}

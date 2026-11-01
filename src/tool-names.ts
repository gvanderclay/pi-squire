// Tool-name helpers shared by the roster and launch code.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Match Pi's tool-list glob: only * has special meaning. */
export function toolMatches(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/**
 * The operations this session can reach: active tools plus codemode and
 * deferred ones, never hidden ones. A delegate with no `tools` field
 * inherits these. Includes active model-only operations, though
 * ctx.executeTool cannot call those.
 */
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

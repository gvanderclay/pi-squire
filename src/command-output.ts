import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Commands never turn diagnostics into a model task or transcript message. */
export function commandOutput(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI && (ctx.mode === "print" || ctx.mode === "json")) {
		// Pi 1.5.2 docs/json.md reserves stdout for JSONL and names stderr for
		// diagnostics. docs/extensions.md#mode-behavior: print/JSON UI is a no-op;
		// print-mode.js only prints the last assistant message, not custom entries.
		process.stderr.write(`${text}\n`);
	} else ctx.ui.notify(text, type);
}

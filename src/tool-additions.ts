import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Whether Pi adds a tool to this model's conversation in place, so loading a
 * deferred tool through `tool_search` keeps the prompt cache. Every other
 * model is sent the whole current tool list, and the system prompt's tool
 * list, again. Mirrors pi-ai's per-API handling of tool changes (pi-ai
 * README, "Models that accept system messages mid-conversation") and
 * pi-web-access's `addsToolsWithoutCheckpoint`.
 */
export function addsToolsInPlace(model: Pick<Model<Api>, "api" | "compat"> | undefined): boolean {
	const compat = model?.compat;
	// Each API's compat type declares only its own flags.
	const has = (flag: string): boolean => compat !== undefined && Reflect.get(compat, flag) === true;
	if (!model || !has("supportsMidConvoSystemMessages")) return false;
	switch (model.api) {
		case "anthropic-messages":
			return has("supportsMidConvoToolChanges");
		case "openai-completions":
			return has("supportsMidConvoToolAdditions");
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return has("supportsAdditionalTools") || has("supportsToolSearch");
		default:
			return false;
	}
}

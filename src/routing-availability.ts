import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { activeMark, type Mark } from "./limits.ts";
import type { MarkPolicy } from "./model-choice.ts";

/** Go reads with this registry's key. CLI-account observations/marks require explicit operator applicability. */
export function routingMarkPolicy(provider: string, applicableProviders: readonly string[]): MarkPolicy {
	const applicable: boolean = provider === "opencode-go" || applicableProviders.includes(provider);
	return { accepts: (mark: Mark): boolean => mark.source === "reactive" || applicable, proactive: applicable };
}
export function routedMark(
	models: ModelRegistry,
	provider: string,
	id: string,
	applicableProviders: readonly string[],
): Mark | undefined {
	return activeMark(models, provider, id, Date.now(), routingMarkPolicy(provider, applicableProviders).accepts);
}

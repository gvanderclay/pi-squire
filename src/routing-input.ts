import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseRoutingRequest } from "./routing-policy.ts";
import type { RoutingRequest } from "./routing-types.ts";

/** Fresh metadata only: never prefill a prior public-context attestation on resume/fork. */
export async function promptRouting(ctx: ExtensionContext, role: string): Promise<RoutingRequest | undefined> {
	const value: string | undefined = await ctx.ui.editor(
		`Routing JSON for ${role} (category/data; review.authors when required)`,
		'{\n  "category": "standard",\n  "data": "unknown"\n}',
	);
	if (value === undefined) return undefined;
	return parseRoutingRequest(JSON.parse(value));
}

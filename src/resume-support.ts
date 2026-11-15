// Static source/host eligibility shared by advice, status and id completions.
// This is not the full resume preflight: no sockets, session files or placement.
import type { DelegateHost } from "./host.ts";
import { assertHostOptions } from "./host-admission.ts";
import { paseoLocator } from "./paseo-locator.ts";
import type { StartedRecorded } from "./result-types.ts";

export function supportsResume(record: StartedRecorded, host?: DelegateHost): boolean {
	try {
		const client = host?.forLaunch?.() ?? host;
		const native = !!paseoLocator(record.locator);
		if ((native && record.closed) || (client && native !== (client.id === "paseo"))) return false;
		if (client) assertHostOptions(client, { kind: "resume" });
		return true;
	} catch {
		return false;
	}
}

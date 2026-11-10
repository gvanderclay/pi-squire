// One call-time host/placement gate. The cheap probe deliberately does not
// read placement: tools/forms historically report availability before request
// validation, while launch/resume read placement only at their full preflight.
import type { DelegateHost } from "./host.ts";
import type { windowSettings } from "./window-placement.ts";

export type AdmittedHost = Readonly<ReturnType<typeof windowSettings> & { client: DelegateHost }>;

export type HostAdmission = {
	probe(): string | undefined;
	admit(): Promise<AdmittedHost>;
};

export function createHostAdmission(
	host: DelegateHost,
	settings: () => ReturnType<typeof windowSettings>,
): HostAdmission {
	return {
		probe: (): string | undefined => host.unavailable(),
		async admit(): Promise<AdmittedHost> {
			// Only concrete adapters' facts are read beyond this boundary. Never use
			// an unselected router's id, noun, placement or guard getters.
			const client = host.forLaunch?.() ?? host;
			const refusal = await client.unavailable(true);
			if (refusal !== undefined) throw new Error(refusal);
			return Object.freeze({
				client,
				...(client.usesWindowPlacement ? settings() : { placement: "current" as const, companionSuffix: "delegates" }),
			});
		},
	};
}

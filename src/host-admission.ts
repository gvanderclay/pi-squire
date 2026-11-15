// One call-time host/placement gate. The cheap probe deliberately does not
// read placement: tools/forms historically report availability before request
// validation, while launch/resume read placement only at their full preflight.
import type { DelegateHost, StartKind, StartOptions } from "./host.ts";
import type { windowSettings } from "./window-placement.ts";

export const HOST_ACTION =
	"Host prerequisite: install tmux >=3.2 (brew install tmux or sudo apt install tmux), run tmux new-session -s pi, then pi; or restart Pi in Herdr/Paseo. See /delegate-doctor";

export type AdmittedHost = Readonly<ReturnType<typeof windowSettings> & { client: DelegateHost }>;

export type HostAdmission = {
	probe(): string | undefined;
	admit(): Promise<AdmittedHost>;
};

export function assertHostOptions(client: DelegateHost, options: StartOptions): void {
	const problem = client.startProblem?.(options);
	if (problem) throw new Error(problem);
}

/** Configuration must finish while the resource is still taskless. */
function assertStartPolicy(client: DelegateHost): void {
	if (!client.configureStart) return;
	const kinds: readonly StartKind[] = ["launch", "resume", "fork"];
	for (const kind of kinds) {
		if (client.taskMailTiming(kind) !== "after-open")
			throw new Error(
				`internal delegate host error: ${client.id} provides configureStart but mails ${kind} tasks before open; configuration requires after-open task mail`,
			);
	}
}

export function createHostAdmission(
	host: DelegateHost,
	settings: () => ReturnType<typeof windowSettings>,
): HostAdmission {
	return {
		probe: (): string | undefined => {
			const refusal = host.unavailable();
			return refusal === undefined ? undefined : `${refusal}. ${HOST_ACTION}`;
		},
		async admit(): Promise<AdmittedHost> {
			// Only concrete adapters' facts are read beyond this boundary. Never use
			// an unselected router's id, noun, placement or guard getters.
			let client: DelegateHost;
			try {
				client = host.forLaunch?.() ?? host;
				const refusal = await client.unavailable(true);
				if (refusal !== undefined) throw new Error(refusal);
			} catch (error) {
				throw new Error(`${(error as Error).message}. ${HOST_ACTION}`);
			}
			assertStartPolicy(client);
			return Object.freeze({
				client,
				...(client.usesWindowPlacement ? settings() : { placement: "current" as const, companionSuffix: "delegates" }),
			});
		},
	};
}

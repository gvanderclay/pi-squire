// One call-time host/placement gate. The cheap probe deliberately does not
// read placement: tools/forms historically report availability before request
// validation, while launch/resume read placement only at their full preflight.
import type { DelegateHost, StartKind, StartOptions } from "./host.ts";
import type { windowSettings } from "./window-placement.ts";

/** The action for a host with no usable terminal; two causes need it. */
const TMUX_INSTALL =
	"install tmux >=3.2 (brew install tmux or sudo apt install tmux), run tmux new-session -s pi, then pi; or restart Pi in Herdr/Paseo";

/** Advice follows the refusal, not the router's id (which can itself refuse). */
export function hostAction(cause: string): string {
	let action: string;
	if (cause.includes("invalid PI_DELEGATE_MULTIPLEXER"))
		action =
			'fix PI_DELEGATE_MULTIPLEXER in the launcher (valid values: tmux, herdr, paseo), or override it with "multiplexer": "tmux" or "herdr" in the Squire settings file named above';
	else if (cause.includes("inside both tmux and Herdr") || cause.includes("invalid multiplexer"))
		action =
			'set "multiplexer": "tmux" or "herdr" in the Squire settings file named above; PI_DELEGATE_MULTIPLEXER from the launcher is used only when that setting is absent';
	// The settings errors' own prefixes: a path holding these words must not steer the advice.
	else if (cause.startsWith("could not read squire settings") || cause.startsWith("invalid squire settings"))
		action = "fix the Squire settings file named above, then retry";
	// Before the Paseo/Herdr matches: this cause names the settings file, whose path may contain either word.
	else if (cause.startsWith("this session is inside neither")) action = TMUX_INSTALL;
	else if (cause.includes("not hosted by Paseo"))
		action =
			'run Pi inside a Paseo agent, or fix/unset a stale PI_DELEGATE_MULTIPLEXER=paseo in the launcher; a "multiplexer": "tmux" or "herdr" setting can override it for a terminal-hosted Pi';
	else if (cause.includes("Paseo is not running"))
		action = "start the Paseo daemon, check paseo status, then retry from the Paseo-hosted Pi";
	else if (/Paseo/i.test(cause))
		action = "check paseo status and the Paseo daemon connection/descriptor named above, then retry";
	else if (cause.includes("Herdr pane") && cause.includes("moved"))
		action = "move the Herdr pane back, or restart Pi in the Herdr workspace where delegates should open";
	else if (/Herdr/i.test(cause))
		action =
			"start Pi in a Herdr pane with a running compatible Herdr server; if its pane/session changed, restart Pi there, then retry";
	else if (cause.includes("not inside tmux") || cause.includes("delegate windows need tmux")) action = TMUX_INSTALL;
	else action = "fix the host selection or availability reported above, then retry";
	return `Host prerequisite: ${action}. See /delegate-doctor`;
}

export type HostAudience = "command" | "tool";

/** The audience of a call: a tool call has an id, a command does not. */
export function callAudience(toolCallId: string | undefined): HostAudience {
	return toolCallId === undefined ? "command" : "tool";
}

function hostRefusal(cause: string, audience: HostAudience): string {
	return `${cause}. ${audience === "tool" ? "Ask the user to fix the host; /delegate-doctor shows details." : hostAction(cause)}`;
}

export type AdmittedHost = Readonly<ReturnType<typeof windowSettings> & { client: DelegateHost }>;

export type HostAdmission = {
	probe(audience?: HostAudience): string | undefined;
	admit(audience?: HostAudience): Promise<AdmittedHost>;
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
		probe: (audience = "command"): string | undefined => {
			const refusal = host.unavailable();
			return refusal === undefined ? undefined : hostRefusal(refusal, audience);
		},
		async admit(audience = "command"): Promise<AdmittedHost> {
			// Only concrete adapters' facts are read beyond this boundary. Never use
			// an unselected router's id, noun, placement or guard getters.
			let client: DelegateHost;
			try {
				client = host.forLaunch?.() ?? host;
				const refusal = await client.unavailable(true);
				if (refusal !== undefined) throw new Error(refusal);
			} catch (error) {
				throw new Error(hostRefusal((error as Error).message, audience));
			}
			assertStartPolicy(client);
			return Object.freeze({
				client,
				...(client.usesWindowPlacement ? settings() : { placement: "current" as const, companionSuffix: "delegates" }),
			});
		},
	};
}

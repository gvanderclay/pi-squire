import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { HostAudience } from "./host-admission.ts";

/** Why task mail cannot be sent, with no advice. */
export const MISSING_MAIL = "needs a provider of message:* to send the task";

/** The install action for a person at the terminal; a tool result asks the user instead. */
const INSTALL_MAIL =
	"install a mailbox extension (for example pi-session-mail): run pi install npm:pi-session-mail, then /reload (or restart Pi) in the parent and delegate sessions";

/**
 * The missing-mail refusal, worded for who reads it. A model cannot install an
 * extension or reload Pi, so a tool result asks the user and names the doctor,
 * which reports the same handler detail.
 */
export function missingMail(audience: HostAudience): string {
	return `${MISSING_MAIL}; ${
		audience === "tool"
			? "Ask the user to install a mailbox extension such as pi-session-mail; /delegate-doctor shows details."
			: INSTALL_MAIL
	}`;
}

/** Same synchronous envelope/error acknowledgement used by the actual send path. */
export function mailAnswered(payload: { envelope?: unknown; error?: unknown }): boolean {
	return payload.envelope !== undefined || payload.error !== undefined;
}

/** Provider diagnostics stay on one line and cannot overwhelm the doctor report. */
function boundedError(error: string): string {
	const text = error.replace(/\p{Cc}/gu, " ");
	return text.length > 300 ? `${text.slice(0, 300)}… (truncated)` : text;
}

/**
 * The provider's message:send/reply contract rejects an empty address before
 * writing (pi-session-mail README Hooks). Never scan: scanning claims waiting
 * mail. A validation response proves a handler, not delivery or reply support.
 */
export function probeMail(events: EventBus, hook: "message:send" | "message:reply"): string {
	const payload: { to: string; body: string; inReplyTo: string[]; status: string; error?: string; envelope?: unknown } =
		{
			to: "",
			body: "",
			inReplyTo: [],
			status: "done",
		};
	try {
		events.emit(hook, payload);
		return mailAnswered(payload)
			? `a handler answered an invalid-input probe; delivery and reply were not tested${payload.error === undefined ? "" : `; provider error: ${boundedError(payload.error)}`}`
			: `no handler answered; ${missingMail("command")}`;
	} catch (error) {
		return `probe threw; registration unverified: ${String(error)}`;
	}
}

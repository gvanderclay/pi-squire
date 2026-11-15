import type { EventBus } from "@earendil-works/pi-coding-agent";

export const MISSING_MAIL =
	"needs a provider of message:* to send the task; install a mailbox extension (for example pi-session-mail): run pi install npm:pi-session-mail, then /reload (or restart Pi) in the parent and delegate sessions";

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
			: `no handler answered; ${MISSING_MAIL}`;
	} catch (error) {
		return `probe threw; registration unverified: ${String(error)}`;
	}
}

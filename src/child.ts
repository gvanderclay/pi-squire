// The delegate's side of `auto-exit`, registered only inside a delegate.
//
// The parent resolves the setting and passes it as `PI_DELEGATE_AUTO_EXIT`
// (`1` on, `0` off). While it is on, the delegate shuts Pi down once a run
// settles as a normal completion, so its tmux window closes; the settle
// reply has been sent by then, since the shutdown waits for the next
// event-loop turn. A run that ended stopped or failed never exits. The user
// taking over — typing here, or stopping a run — turns it off for the rest of
// the session, with a notice; `/auto-exit` turns it back on. Modelled on
// edxeth/pi-subagents' `auto-exit` (README "Child lifecycle", `cf6dbf4`).
//
// It also takes over the parent's task request on `message:inbound` and sends
// it as a user prompt. Pi 1.0.0 starts a custom-message turn without preparing
// the system prompt, so a fresh delegate's first request would carry no
// AGENTS.md, skills or role addendum (earendil-works/pi#5581). The provider
// still arms the automatic answer for a request a listener took over.
// ponytail: drop the takeover once #5581 lands and the minimum Pi has it.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { classify, type Response, recordLimit } from "./limits.ts";

/** The launch variable that carries the parent's resolved setting. */
export const AUTO_EXIT_ENV = "PI_DELEGATE_AUTO_EXIT";

const OFF_NOTICE =
	"delegate: auto-exit is off for this session because you took over here; the window stays open. /auto-exit turns it back on.";
const ON_NOTICE = "delegate: auto-exit is on; this delegate closes after its next normal completion.";

type Message = { role?: string; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown };

type Inbound = { envelope?: { from?: unknown; kind?: unknown; body?: unknown }; handled?: boolean };

/** A run that ended on a usage-limit error leaves a mark for every Pi session. */
function recordUsageLimit(last: Message, ctx: ExtensionContext, response?: Response): void {
	const { provider, model, errorMessage } = last;
	if (typeof provider !== "string" || typeof model !== "string" || typeof errorMessage !== "string") return;
	try {
		recordLimit(ctx.modelRegistry, {
			provider,
			model,
			message: errorMessage,
			delegation: ctx.sessionManager.getSessionId(),
			response,
		});
	} catch {
		// A mark that cannot be written must not break the run's end.
	}
}

export function registerChild(pi: ExtensionAPI, parent: string): void {
	let current: ExtensionContext | undefined;
	pi.on("session_start", async (_event, ctx) => {
		current = ctx;
	});
	pi.events.on("message:inbound", (data) => {
		const payload = data as Inbound;
		const envelope = payload?.envelope;
		if (payload.handled === true || envelope?.kind !== "request" || envelope.from !== parent) return;
		payload.handled = true;
		const text = `[delegate] Your task, from the session that started you (${parent}). Your final message this turn goes back to it automatically.\n\n${String(envelope.body ?? "")}`;
		Promise.resolve(pi.sendUserMessage(text, { deliverAs: "steer" })).catch((err) =>
			current?.ui.notify(`delegate: could not start the task: ${(err as Error).message}`, "error"),
		);
	});

	let armed = process.env[AUTO_EXIT_ENV] === "1";
	/** Whether the run that just ended finished normally: not stopped, not failed. */
	let completed = false;

	function disarm(ctx: ExtensionContext): void {
		if (!armed) return;
		armed = false;
		ctx.ui.notify(OFF_NOTICE, "info");
	}

	// Typed text and RPC input are the user's; a prompt an extension sends is not.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") disarm(ctx);
	});

	// The latest provider response of the current run; its headers may state the reset.
	let response: Response | undefined;
	pi.on("agent_start", async () => {
		response = undefined;
	});
	pi.on("after_provider_response", async (event) => {
		response = { status: event.status, headers: event.headers };
	});

	// Stopped mid-text the last message says `aborted`; stopped during a tool
	// call Pi 0.99.1 ends with an `error` message, and only the signal tells a
	// stop from a real error. Either way it is the user taking over.
	pi.on("agent_end", async (event, ctx) => {
		let last: Message | undefined;
		for (let i = event.messages.length - 1; i >= 0 && last === undefined; i--) {
			const message = event.messages[i] as Message;
			if (message?.role === "assistant") last = message;
		}
		const stopped = last?.stopReason === "aborted" || ctx.signal?.aborted === true;
		if (stopped) disarm(ctx);
		if (!stopped && last?.stopReason === "error") recordUsageLimit(last, ctx, response);
		// A usage limit is final until the quota resets, so it ends the work like a completion.
		const limited = typeof last?.errorMessage === "string" && classify(last.errorMessage) !== undefined;
		completed = !stopped && (last?.stopReason !== "error" || limited);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const exit = armed && completed;
		completed = false;
		if (!exit) return;
		// Later settle handlers (the `message:*` provider's reply among them) run first.
		setImmediate(() => ctx.shutdown());
	});

	pi.registerCommand("auto-exit", {
		description: "Close this delegate after its next normal completion",
		handler: async (_args, ctx) => {
			armed = true;
			ctx.ui.notify(ON_NOTICE, "info");
		},
	});
}

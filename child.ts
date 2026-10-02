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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The launch variable that carries the parent's resolved setting. */
export const AUTO_EXIT_ENV = "PI_DELEGATE_AUTO_EXIT";

const OFF_NOTICE =
	"delegate: auto-exit is off for this session because you took over here; the window stays open. /auto-exit turns it back on.";
const ON_NOTICE = "delegate: auto-exit is on; this delegate closes after its next normal completion.";

type Message = { role?: string; stopReason?: unknown };

export function registerChild(pi: ExtensionAPI): void {
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
		completed = !stopped && last?.stopReason !== "error";
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

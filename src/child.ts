// The delegate's side of `auto-exit`, registered only inside a delegate.
//
// The parent resolves the setting and passes it as `PI_DELEGATE_AUTO_EXIT`
// (`1` on, `0` off). While it is on, the delegate shuts Pi down once a run
// settles, so its tmux window closes; the settle reply has been sent by
// then, since the shutdown waits for the next event-loop turn. A failed run
// exits too (the parent gets the error and the session file stays); only a
// run the user stopped never exits. A run that ends on a usage limit first
// moves to the agent's next fallback, from `PI_DELEGATE_FALLBACK`, and
// continues there; it exits only when no fallback is left. An entry that is
// an alias resolves to one model through Pi's own `--model` resolver. The user
// taking over — typing here, or stopping a run — turns it off for the rest of
// the session, with a notice; `/auto-exit` turns it back on.
//
// It also takes over the parent's task request on `message:inbound` and sends
// it as a user prompt, so the task starts through the same path as a typed
// prompt, labelled `[delegate]`. Pi 1.2.0 already prepares the system prompt
// for custom-message runs (earendil-works/pi#5581); this takeover remains the
// package's pinned startup delivery path. task-replies.ts owns the answer.
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
	type ModelRuntime,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { type Identity, writeIdentity } from "./identity.ts";
import { activeMark, classify, type Response, recordLimit } from "./limits.ts";
import type { TaskReplies } from "./task-replies.ts";

/** The launch variable that carries the parent's resolved setting. */
export const AUTO_EXIT_ENV = "PI_DELEGATE_AUTO_EXIT";
/** The launch variable listing, comma-separated, the agent's models after the one launched. */
export const FALLBACK_ENV = "PI_DELEGATE_FALLBACK";
/** The launch variable naming the roster agent this delegate runs as, for its footer. */
export const AGENT_ENV = "PI_DELEGATE_AGENT";

const OFF_NOTICE =
	"delegate: auto-exit is off for this session because you took over here; the window stays open. /auto-exit turns it back on.";
const ON_NOTICE = "delegate: auto-exit is on; this delegate closes after its next normal completion.";

type Message = { role?: string; stopReason?: unknown; errorMessage?: unknown; provider?: unknown; model?: unknown };

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

/**
 * The one model a fallback entry names, as Pi's `--model` resolves it: an
 * exact `provider/id`, or a bare id or alias such as `sonnet`. Undefined when
 * the registry has no such model; a custom model id Pi would make up for an
 * unknown one is not used.
 */
function resolveEntry(registry: ModelRegistry, entry: string): Model<Api> | undefined {
	// The resolver reads only these two from the runtime; the registry is the extension's view of it.
	const runtime = {
		getModels: () => registry.getAll(),
		hasConfiguredAuth: (provider: string) =>
			registry.getAll().some((model) => model.provider === provider && registry.hasConfiguredAuth(model)),
	} as unknown as ModelRuntime;
	try {
		const { model } = resolveCliModel({ cliModel: entry, modelRuntime: runtime });
		return model === undefined ? undefined : registry.find(model.provider, model.id);
	} catch {
		return undefined; // an entry Pi cannot read is passed over like one that names no model
	}
}

/**
 * Switch to the first model `fallback` names that is usable, not marked and
 * not tried yet, taking each entry off the list in order. Returns the
 * `provider/id` switched to, if any.
 */
async function switchModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	fallback: string[],
	tried: Set<string>,
): Promise<string | undefined> {
	for (let next = fallback.shift(); next !== undefined; next = fallback.shift()) {
		const model = resolveEntry(ctx.modelRegistry, next);
		if (model === undefined) continue;
		const name = `${model.provider}/${model.id}`;
		if (tried.has(name)) continue;
		tried.add(name);
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		if (activeMark(ctx.modelRegistry, model.provider, model.id) !== undefined) continue;
		if (await pi.setModel(model)) return name;
	}
	return undefined;
}

/**
 * A usage limit or an unavailable endpoint moves the run to the next fallback
 * that is usable and not marked, and continues it in this session; each
 * model is tried once, and never the one that just failed. Returns the setter
 * for what ended the last run: the failed model as `provider/id`, and why as
 * `<provider/model> <what happened>`.
 */
function registerFallback(pi: ExtensionAPI): (failure: Failure | undefined) => void {
	/** The entries still to move to on a usage limit, in order: models or aliases. */
	const fallback = (process.env[FALLBACK_ENV] ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	/** The models already switched to or failed on, as `provider/id`. */
	const tried = new Set<string>();
	let failure: Failure | undefined;
	pi.on("agent_before_settle", async (_event, ctx) => {
		const from = failure;
		failure = undefined;
		if (from === undefined) return;
		tried.add(from.model);
		const next = await switchModel(pi, ctx, fallback, tried);
		if (next === undefined) return;
		const content = `[delegate] ${from.reason}, so this session switched to ${next}. Carry on with the task from where it stopped.`;
		return { continue: true, entries: [{ type: "custom_message", customType: "delegate", content, display: true }] };
	});
	return (value) => {
		failure = value;
	};
}

/** A failed run that should move to a fallback: the model it failed on, and why. */
type Failure = { model: string; reason: string };

/** Why a failed run should move to a fallback, with `reason` as `<provider/model> <what happened>`; undefined when it should not. */
function fallbackReason(last: Message | undefined): Failure | undefined {
	const error = last?.errorMessage;
	if (typeof error !== "string") return undefined;
	const model = `${String(last?.provider)}/${String(last?.model)}`;
	if (classify(error) !== undefined) return { model, reason: `${model} hit a usage limit` };
	// Pi has already retried an unavailable endpoint; it marks nothing, but this run moves on.
	if (/unavailable/i.test(error)) return { model, reason: `${model} was unavailable (${error})` };
	return undefined;
}

/** This delegate's footer icon, picked once per load. */
const ICON = Math.random() < 0.5 ? "👦" : "👧";

function showStatus(ctx: ExtensionContext, armed: boolean, agent?: string): void {
	const { theme } = ctx.ui;
	const label = agent === undefined || agent === "" ? "delegate" : `${theme.fg("accent", agent)} delegate`;
	ctx.ui.setStatus(
		"delegate-self",
		armed
			? `${ICON} ${label} · auto-exit ${theme.fg("success", "on")}`
			: `${ICON} ${label} · auto-exit ${theme.fg("dim", "off")}`,
	);
}

function shutdownWhenActive(ctx: ExtensionContext, active: () => boolean): void {
	setImmediate(() => {
		if (active()) ctx.shutdown();
	});
}

export function registerChild(
	pi: ExtensionAPI,
	replies: TaskReplies,
	identity: () => Identity | undefined,
	active: () => boolean = () => true,
): void {
	const setFailure = registerFallback(pi);

	let armed = false;
	/** Whether the run that just ended finished without the user stopping it. */
	let completed = false;

	// Reload and session replacement clear extension statuses, then start again.
	pi.on("session_start", async (_event, ctx) => {
		const own = identity();
		armed = own?.autoExit === true;
		if (own) showStatus(ctx, armed, own.agent);
	});

	function disarm(ctx: ExtensionContext): void {
		if (!armed) return;
		armed = false;
		const own = identity();
		if (own) writeIdentity(ctx.sessionManager.getSessionId(), { ...own, autoExit: false });
		ctx.ui.notify(OFF_NOTICE, "info");
		showStatus(ctx, armed, identity()?.agent);
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
		const last = event.messages.findLast((message) => message.role === "assistant") as Message | undefined;
		if (!identity()) return;
		const stopped = last?.stopReason === "aborted" || ctx.signal?.aborted === true;
		if (stopped) disarm(ctx);
		if (!stopped && last?.stopReason === "error") recordUsageLimit(last, ctx, response);
		setFailure(stopped ? undefined : fallbackReason(last));
		// A failure ends the work like a completion: the parent gets the error, the session file stays.
		completed = !stopped;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const exit = armed && completed && replies.handled();
		completed = false;
		if (!exit) return;
		// Task settlement and its synchronous reply write have succeeded.
		shutdownWhenActive(ctx, active);
	});

	pi.registerCommand("auto-exit", {
		description: "Close this delegate after its next normal completion",
		handler: async (_args, ctx) => {
			if (!identity()) return ctx.ui.notify("auto-exit is available inside a delegate session", "error");
			armed = true;
			const own = identity();
			if (own) writeIdentity(ctx.sessionManager.getSessionId(), { ...own, autoExit: true });
			ctx.ui.notify(ON_NOTICE, "info");
			showStatus(ctx, armed, identity()?.agent);
		},
	});
}

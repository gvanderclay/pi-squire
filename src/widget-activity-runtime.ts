import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ActivityCollector } from "./widget-activity.ts";
import { LIVE_LAUNCH_ENV, LiveActivityPublisher, liveLaunch } from "./widget-live.ts";

/** Observe raw lifecycle after a positive startup owner gate; never grants task/action authority. */
export function registerActivityRuntime(pi: ExtensionAPI, canPublish: () => boolean): () => void {
	const seed: string | undefined = process.env[LIVE_LAUNCH_ENV];
	let collector: ActivityCollector | undefined;
	let publisher: LiveActivityPublisher | undefined;
	const stop = (): void => {
		collector?.clear();
		collector = undefined;
		publisher?.stop();
		publisher = undefined;
	};
	const publish = (immediate = true): void => publisher?.publish(collector?.snapshot(), immediate);
	const clear = (): void => {
		collector?.clear();
		publish();
	};
	pi.on("session_start", (_event, ctx) => {
		stop();
		if (!canPublish()) return;
		const id: string = ctx.sessionManager.getSessionId();
		collector = new ActivityCollector();
		publisher = new LiveActivityPublisher(id, liveLaunch(seed, id));
		publish();
	});
	pi.on("tool_execution_start", (event) => {
		collector?.start(event.toolCallId, event.toolName, event.parentToolCallId);
		publish();
	});
	pi.on("tool_execution_end", (event) => {
		collector?.end(event.toolCallId);
		publish();
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			collector?.messageStart();
			publish();
		}
	});
	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta") {
			collector?.delta(update.delta);
			publish(false);
		} else if (update.type === "text_start") collector?.delta(" ");
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			collector?.messageEnd();
			publish();
		}
	});
	pi.on("agent_start", clear);
	pi.on("agent_end", clear);
	pi.on("agent_settled", clear);
	pi.on("session_shutdown", stop);
	return stop;
}

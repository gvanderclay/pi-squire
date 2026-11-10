// Execute the actual released local reader, restore, poll and save against a new store.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildTasks } from "../../src/child-tasks.ts";
import type { createPoll } from "../../src/poll.ts";
import type { createResults } from "../../src/results.ts";
import { FakeTmux } from "../fake-tmux.ts";

type LegacyTasks = { ChildTasks: typeof ChildTasks; readChildRecords(session: string): unknown };
const tasksModule: LegacyTasks = await import(new URL("./released-v1/child-tasks.mjs", import.meta.url).href);
const resultsModule: { createResults: typeof createResults } = await import(
	new URL("./released-v1/results.mjs", import.meta.url).href
);
const pollModule: { createPoll: typeof createPoll } = await import(
	new URL("./released-v1/poll.mjs", import.meta.url).href
);
const registry = await import(new URL("./released-v1/tree-registry.mjs", import.meta.url).href);
type Entry = { type: "custom"; customType: string; data: unknown };
type Command = { key: number; op: string; session: string; transcript: string };
async function execute(command: Command): Promise<unknown> {
	if (command.op === "read") return tasksModule.readChildRecords(command.session);
	if (command.op === "restore-save") {
		const tasks = new tasksModule.ChildTasks();
		let restoreError: string | undefined;
		let saveError: string | undefined;
		try {
			tasks.restore(command.session);
		} catch (error) {
			restoreError = String(error);
		}
		try {
			tasks.save([]);
		} catch (error) {
			saveError = String(error);
		}
		return { restoreError, saveError, unreadable: tasks.unreadable, failed: tasks.failed };
	}
	const entries: Entry[] = JSON.parse(readFileSync(command.transcript, "utf8"));
	const before = entries.length;
	const warnings: string[] = [];
	let messages = 0;
	const events = createEventBus();
	events.on("message:scan", (payload) => {
		(payload as { scanned: boolean }).scanned = true;
	});
	const pi = {
		events,
		on: (): void => {},
		registerMessageRenderer: (): void => {},
		appendEntry: (customType: string, data: unknown): void => {
			entries.push({ type: "custom", customType, data });
			writeFileSync(command.transcript, JSON.stringify(entries));
		},
		sendMessage: (): void => {
			messages++;
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		sessionManager: {
			getSessionId: (): string => command.session,
			getEntries: (): Entry[] => entries,
			getSessionDir: (): string => join(process.env.PI_CODING_AGENT_DIR ?? "", "sessions"),
		},
		ui: {
			notify: (text: string): void => {
				warnings.push(text);
			},
		},
	} as unknown as ExtensionContext;
	const results = resultsModule.createResults(
		pi,
		() => false,
		(_ctx, records) => registry.publishTreeRecords(command.session, command.session, records),
	);
	results.restore(ctx);
	const tmux = new FakeTmux();
	tmux.addWindow("@72", "reopened");
	const poll = pollModule.createPoll(pi, results, tmux);
	let tick: (() => void) | undefined;
	const interval = globalThis.setInterval;
	globalThis.setInterval = ((callback: () => void) => {
		tick = callback;
		return { unref: (): void => {} };
	}) as unknown as typeof setInterval;
	try {
		poll.start();
	} finally {
		globalThis.setInterval = interval;
	}
	tick?.();
	await turn();
	await turn();
	await turn();
	poll.stop();
	let refusal: string | undefined;
	try {
		results.checkStorage(true);
	} catch (error) {
		refusal = String(error);
	}
	return {
		refusal,
		warnings,
		messages,
		appended: entries.length - before,
		listCalls: tmux.listCalls,
		running: results.running().map((record) => record.id),
		completionReady: results.completionReady(),
	};
}
process.on("message", (command: Command) => {
	void execute(command).then(
		(result) => process.send?.({ key: command.key, result }),
		(error: unknown) => process.send?.({ key: command.key, error: String(error) }),
	);
});
process.send?.({ ready: true });

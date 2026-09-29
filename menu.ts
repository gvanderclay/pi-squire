// The `delegate` tool's confirmation menu: a `ctx.ui.select` loop that shows
// the agent, model, thinking and task and lets the user approve the call or
// change one of them before anything starts. The pickers are this package's
// own search component: a catalog package must stand alone, so it does not
// import another extension's picker.
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { THINKING_LEVELS } from "./agents.ts";

/** What a delegation is about to be: the four fields the menu can change. */
export type Request = { agent: string; model: string; thinking: string; task: string };

/** What the user did with the menu. Only `approve` starts anything. */
export type Decision =
	| { kind: "approve"; request: Request }
	| { kind: "reject" }
	| { kind: "changes"; changes: string };

/** The menu's items, in order. `Approve` is first so Enter accepts the call. */
const APPROVE = "Approve and start";
const REJECT = "Reject";
const CHANGE_MODEL = "Change model";
const CHANGE_THINKING = "Change thinking";
const CHANGE_AGENT = "Change agent";
const EDIT_TASK = "Edit task";
const ASK = "Ask for changes";
const OPTIONS = [APPROVE, REJECT, CHANGE_MODEL, CHANGE_THINKING, CHANGE_AGENT, EDIT_TASK, ASK];

/** The task shown in the menu title is cut here; the full task is what starts. */
const TASK_SHOWN = 500;

/** A searchable picker: typing filters the options, up/down move, enter picks
 * the highlighted one, esc cancels. Resolves the picked option, or undefined. */
function searchPicker(title: string, options: string[]) {
	return (tui: { requestRender(): void }, theme: Theme, _kb: unknown, done: (picked: string | undefined) => void) => {
		let query = "";
		let cursor = 0;
		const MAX = 10;
		const shown = () => (query ? fuzzyFilter(options, query, (o) => o) : options);
		return {
			render(width: number) {
				const list = shown();
				const top = Math.max(0, Math.min(cursor - Math.floor(MAX / 2), list.length - MAX));
				return [
					theme.fg("accent", theme.bold(title)),
					`${theme.fg("muted", "Search:")} ${query}\u2588`,
					...(list.length
						? list.slice(top, top + MAX).map((o, i) => (top + i === cursor ? theme.fg("accent", `\u203a ${o}`) : `  ${o}`))
						: [theme.fg("muted", "  No match")]),
					...(list.length > MAX ? [theme.fg("dim", `  (${cursor + 1}/${list.length})`)] : []),
					theme.fg("dim", "type to search \u2022 enter pick \u2022 esc cancel"),
				].map((l) => truncateToWidth(l, width));
			},
			invalidate() {},
			handleInput(data: string) {
				const list = shown();
				if (matchesKey(data, "escape")) return done(undefined);
				if (matchesKey(data, "enter")) return list[cursor] === undefined ? undefined : done(list[cursor]);
				if (matchesKey(data, "up")) cursor = list.length ? (cursor - 1 + list.length) % list.length : 0;
				else if (matchesKey(data, "down")) cursor = list.length ? (cursor + 1) % list.length : 0;
				else if (matchesKey(data, "backspace")) {
					query = query.slice(0, -1);
					cursor = 0;
				} else if (data.length === 1 && data >= " " && data <= "~") {
					query += data;
					cursor = 0;
				}
				tui.requestRender();
			},
		};
	};
}

/** The task as the menu shows it: one line, cut so a long task cannot fill the dialog. */
function shownTask(task: string): string {
	const one = task.replace(/\s+/g, " ").trim();
	return one.length > TASK_SHOWN ? `${one.slice(0, TASK_SHOWN)}…` : one;
}

/** The current call, so every change is visible before Approve. */
function title(request: Request): string {
	return [
		`Delegate to ${request.agent} — ${request.model}, thinking ${request.thinking}?`,
		`Task: ${shownTask(request.task)}`,
	].join("\n");
}

/** One pick from `ctx.ui.custom`; undefined when the user cancels the picker. */
async function pick(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(searchPicker(title, options));
}

/**
 * Show the confirmation menu and return what the user chose. Escaping the
 * menu counts as Reject, and a cancelled picker leaves the request untouched.
 * Changing the agent resets the model and thinking to that agent's defaults,
 * the way `/delegate <agent>` without flags does.
 */
export async function confirmDelegation(
	request: Request,
	ctx: ExtensionContext,
	roster: readonly { name: string; model: string; thinking: string }[],
	models: readonly string[],
): Promise<Decision> {
	let current = { ...request };
	for (;;) {
		const choice = await ctx.ui.select(title(current), [...OPTIONS]);
		if (choice === undefined || choice === REJECT) return { kind: "reject" };
		if (choice === APPROVE) return { kind: "approve", request: current };
		if (choice === CHANGE_MODEL) {
			const picked = await pick(ctx, `Model for ${current.agent}? Now: ${current.model}`, [...models].sort());
			if (picked !== undefined) current = { ...current, model: picked };
		} else if (choice === CHANGE_THINKING) {
			const picked = await pick(ctx, `Thinking for ${current.agent}? Now: ${current.thinking}`, [...THINKING_LEVELS]);
			if (picked !== undefined) current = { ...current, thinking: picked };
		} else if (choice === CHANGE_AGENT) {
			const picked = await pick(
				ctx,
				`Delegate to which agent? Now: ${current.agent}`,
				roster.map((agent) => agent.name),
			);
			const agent = roster.find((candidate) => candidate.name === picked);
			if (agent !== undefined) {
				current = { agent: agent.name, model: agent.model, thinking: agent.thinking, task: current.task };
			}
		} else if (choice === EDIT_TASK) {
			const edited = (await ctx.ui.editor("Edit the task", current.task))?.trim();
			if (edited !== undefined && edited !== "") current = { ...current, task: edited };
		} else if (choice === ASK) {
			const changes = (await ctx.ui.editor("What should the parent change instead?"))?.trim();
			if (changes !== undefined && changes !== "") return { kind: "changes", changes };
		}
	}
}

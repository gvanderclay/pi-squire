// The delegate navigator: the `/delegates` panel and `/delegate-open`. It lists
// the delegations whose window is open and reaches one of them: a popup over
// the user's tmux client, a switch of that client, a peek at the pane, or a
// close. Everything here is a command or a key; the model gets no tool that
// moves the user's terminal.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { type DelegationState, deriveState, isStarted, type Results, recordedName } from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { listWindows, ownWindow, type Tracking } from "./tracking.ts";

/** What `/delegate-open` does: `auto` is what enter does in the panel. */
export type OpenMode = "auto" | "popup" | "switch" | "peek";

export const OPEN_USAGE = "/delegate-open <id> [--popup|--switch|--peek]";
const OPEN_FLAGS = ["--popup", "--switch", "--peek"] as const;

/** One delegation whose window is open. */
type OpenDelegate = {
	id: string;
	name: string;
	agent: string;
	state: DelegationState;
	window: TmuxWindow;
};

/** What the panel hands back: the action the user chose on one delegation, or none. */
type PanelResult = { action: "open" | "switch" | "close"; id: string } | { action: "new" } | undefined;

const HINT = "↑↓ select · enter open · p peek · s switch · x close · n new · esc leave";
const EMPTY = "No open delegates · n new · esc close";
const PEEK_HINT = "r refresh · enter open · esc back";

type PanelTheme = { fg(color: string, text: string): string; bold(text: string): string };

type Peek = { id: string; text: string; error: string | undefined; loading: boolean };

/** The lines a peek shows: the captured pane's last rows, or why there is none. */
function peekBody(peek: Peek, rows: number): string[] {
	if (peek.loading) return ["Capturing…"];
	if (peek.error !== undefined) return [`Could not capture the pane: ${peek.error}`];
	return peek.text
		.replace(/\s+$/, "")
		.split("\n")
		.slice(-Math.max(5, rows - 6));
}

/** The panel as a pi-tui component: a list, and a peek view over it. */
class Panel implements Component {
	private selected = 0;
	private peek: Peek | undefined;

	private readonly items: readonly OpenDelegate[];
	private readonly theme: PanelTheme;
	private readonly capture: (windowId: string) => Promise<string>;
	private readonly done: (result: PanelResult) => void;
	private readonly redraw: () => void;
	private readonly rows: () => number;
	/** True when the panel was opened on one delegate's peek: leaving the peek leaves the panel. */
	private readonly peekOnly: boolean;

	constructor(parts: {
		items: readonly OpenDelegate[];
		theme: PanelTheme;
		capture: (windowId: string) => Promise<string>;
		done: (result: PanelResult) => void;
		redraw: () => void;
		rows: () => number;
		peekOnly: boolean;
	}) {
		this.items = parts.items;
		this.theme = parts.theme;
		this.capture = parts.capture;
		this.done = parts.done;
		this.redraw = parts.redraw;
		this.rows = parts.rows;
		this.peekOnly = parts.peekOnly;
		if (this.peekOnly && this.items.length > 0) this.startPeek(this.items[0]);
	}

	invalidate(): void {}

	private current(): OpenDelegate | undefined {
		return this.items[this.selected];
	}

	private startPeek(item: OpenDelegate): void {
		this.peek = { id: item.id, text: "", error: undefined, loading: true };
		void this.capture(item.window.id).then(
			(text) => {
				if (this.peek?.id === item.id) this.peek = { id: item.id, text, error: undefined, loading: false };
				this.redraw();
			},
			(err: unknown) => {
				if (this.peek?.id === item.id) {
					this.peek = { id: item.id, text: "", error: (err as Error).message, loading: false };
				}
				this.redraw();
			},
		);
	}

	handleInput(data: string): void {
		if (this.peek !== undefined) this.handlePeek(data);
		else this.handleList(data);
	}

	private handleList(data: string): void {
		const item = this.current();
		const count = this.items.length;
		if (matchesKey(data, "escape")) this.done(undefined);
		else if (matchesKey(data, "n")) this.done({ action: "new" });
		else if (item === undefined) return;
		else if (matchesKey(data, "up")) this.selected = (this.selected + count - 1) % count;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % count;
		else if (matchesKey(data, "enter")) this.done({ action: "open", id: item.id });
		else if (matchesKey(data, "p")) this.startPeek(item);
		else if (matchesKey(data, "s")) this.done({ action: "switch", id: item.id });
		else if (matchesKey(data, "x")) this.done({ action: "close", id: item.id });
		this.redraw();
	}

	private handlePeek(data: string): void {
		const item = this.items.find((candidate) => candidate.id === this.peek?.id);
		if (item === undefined || matchesKey(data, "escape")) {
			if (this.peekOnly) this.done(undefined);
			else this.peek = undefined;
		} else if (matchesKey(data, "r")) this.startPeek(item);
		else if (matchesKey(data, "enter")) this.done({ action: "open", id: item.id });
		this.redraw();
	}

	render(width: number): string[] {
		const fit = (text: string): string => truncateToWidth(text, Math.max(1, width));
		if (this.peek !== undefined) {
			const item = this.items.find((candidate) => candidate.id === this.peek?.id);
			const head = this.theme.bold(`Peek: ${item?.name ?? this.peek.id} (${item?.window.id ?? "?"})`);
			const body = peekBody(this.peek, this.rows());
			return [head, "", ...body, "", this.theme.fg("dim", PEEK_HINT)].map(fit);
		}
		if (this.items.length === 0) return [this.theme.bold("Delegates"), "", EMPTY].map(fit);
		const lines = this.items.map((item, index) => {
			const where = item.window.session === "" ? item.window.id : `${item.window.id} in ${item.window.session}`;
			const row = `${item.name} · ${item.agent} · ${item.state} · ${where}`;
			return index === this.selected ? this.theme.fg("accent", `▸ ${row}`) : `  ${row}`;
		});
		return [this.theme.bold("Delegates"), "", ...lines, "", this.theme.fg("dim", HINT)].map(fit);
	}
}

/** What `src/index.ts` needs from the navigator. */
export type Navigator = {
	/** The panel, looping back after a close. */
	panel(ctx: ExtensionContext): Promise<void>;
	/** One action on one open delegation, for `/delegate-open`. */
	openDelegate(ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void>;
	/** Ids of the delegations whose window is open, for completions. */
	openIds(): Promise<string[]>;
};

/** `/delegate-open`'s arguments: an id and at most one mode flag. */
export function parseOpen(text: string): { id: string; mode: OpenMode } | { error: string } {
	const words = text.trim() === "" ? [] : text.trim().split(/\s+/);
	const flags = words.filter((word) => word.startsWith("-"));
	const ids = words.filter((word) => !word.startsWith("-"));
	const unknown = flags.find((flag) => !(OPEN_FLAGS as readonly string[]).includes(flag));
	if (unknown !== undefined) return { error: `unknown flag ${unknown}; ${OPEN_USAGE}` };
	if (flags.length > 1) return { error: `give at most one of --popup, --switch and --peek; ${OPEN_USAGE}` };
	if (ids.length !== 1) return { error: `give one delegation id; ${OPEN_USAGE}` };
	const flag = flags[0];
	return { id: ids[0], mode: flag === undefined ? "auto" : (flag.slice(2) as OpenMode) };
}

/** Completions for `/delegate-open`: ids first, then the mode flags not yet given. */
export function openCompletions(prefix: string, ids: readonly string[]): { value: string; label: string }[] | null {
	const partial = /(?:^|\s)(\S*)$/.exec(prefix)?.[1] ?? "";
	const head = prefix.slice(0, prefix.length - partial.length);
	const given = head.trim() === "" ? [] : head.trim().split(/\s+/);
	const values: string[] = [];
	if (!given.some((word) => !word.startsWith("-"))) values.push(...ids);
	if (!given.some((word) => word.startsWith("-"))) values.push(...OPEN_FLAGS);
	const hits = values.filter((value) => value.startsWith(partial));
	return hits.length > 0 ? hits.map((value) => ({ value: head + value, label: value })) : null;
}

type Env = { results: Results; tmux: TmuxClient; tracking: Pick<Tracking, "trackPopup" | "close"> };

/** The open delegations, newest first, from the records and one listing; undefined when tmux cannot be asked. */
async function openDelegates({ results, tmux }: Env): Promise<OpenDelegate[] | undefined> {
	const windows = await listWindows(tmux);
	if (windows === undefined) return undefined;
	const found: OpenDelegate[] = [];
	for (const record of results.list()) {
		if (!isStarted(record)) continue;
		const window = ownWindow(windows, record);
		if (window === undefined || window.exited) continue;
		const state = deriveState(record, "open");
		if (state !== "running" && state !== "done") continue;
		found.push({ id: record.id, name: recordedName(record), agent: record.agent, state, window });
	}
	return found.reverse();
}

/** The parent's own session name, or undefined when tmux cannot say. */
async function ownSessionName(tmux: TmuxClient): Promise<string | undefined> {
	try {
		return (await tmux.ownSession())?.name;
	} catch {
		return undefined;
	}
}

/** The most recently active client on the parent's session, or why there is none. */
async function clientOf(tmux: TmuxClient): Promise<{ client: string } | { refusal: string }> {
	const session = await ownSessionName(tmux);
	if (session === undefined) return { refusal: "could not tell which tmux session this pane is in" };
	try {
		const client = await tmux.clientFor(session);
		return client === undefined ? { refusal: `no tmux client is attached to session ${session}` } : { client };
	} catch (err) {
		return { refusal: `could not list tmux clients: ${(err as Error).message}` };
	}
}

async function popup(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	const found = await clientOf(env.tmux);
	if ("refusal" in found) return ctx.ui.notify(`delegate: cannot open a popup: ${found.refusal}`, "warning");
	try {
		// Resolves once the popup is up, not when it closes.
		await env.tmux.popup(found.client, { id: item.window.id, name: item.window.name });
	} catch (err) {
		return ctx.ui.notify(`delegate: could not open a popup: ${(err as Error).message}`, "error");
	}
	env.tracking.trackPopup({ windowId: item.window.id, windowName: item.window.name, client: found.client });
}

async function switchTo(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	const found = await clientOf(env.tmux);
	if ("refusal" in found) return ctx.ui.notify(`delegate: cannot switch: ${found.refusal}`, "warning");
	try {
		await env.tmux.switchTo(found.client, item.window.id);
	} catch (err) {
		return ctx.ui.notify(`delegate: could not switch: ${(err as Error).message}`, "error");
	}
	ctx.ui.notify(`delegate: switched to ${item.name} (${item.window.id}) · prefix L returns you`, "info");
}

/** Enter's behaviour: a switch inside the parent's own session, else a popup. */
async function open(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	const own = await ownSessionName(env.tmux);
	return own !== undefined && own === item.window.session ? switchTo(env, ctx, item) : popup(env, ctx, item);
}

/** Close through the `delegation_close` path, asking first only while the delegate runs. */
async function close(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	if (item.state === "running") {
		const message = `${item.name} is still running. Close it and kill its window?`;
		if (!(await ctx.ui.confirm("Close delegate", message))) return;
	}
	try {
		ctx.ui.notify(`delegate: ${(await env.tracking.close(item.id)).text}`, "info");
	} catch (err) {
		ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
	}
}

/** Show the panel, or just one delegate's peek; resolves with what the user chose. */
function show(
	env: Env,
	ctx: ExtensionContext,
	items: readonly OpenDelegate[],
	peekOnly: boolean,
): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, _keybindings, done): Panel =>
			new Panel({
				items,
				theme: theme as unknown as PanelTheme,
				capture: (windowId: string): Promise<string> => env.tmux.capture(windowId),
				done,
				redraw: (): void => tui.requestRender(),
				rows: (): number => tui.terminal.rows,
				peekOnly,
			}),
	);
}

const noUi = (ctx: ExtensionContext): void => ctx.ui.notify("delegate: this needs an interactive session", "error");
const noTmux = (ctx: ExtensionContext): void => ctx.ui.notify("delegate: could not ask tmux for its windows", "error");

/** Carry out what the panel returned; true when the panel should open again. */
async function act(
	env: Env,
	startNew: (ctx: ExtensionContext) => Promise<void> | void,
	ctx: ExtensionContext,
	items: OpenDelegate[],
	result: PanelResult,
): Promise<boolean> {
	if (result === undefined) return false;
	if (result.action === "new") {
		await startNew(ctx);
		return false;
	}
	const item = items.find((candidate) => candidate.id === result.id);
	if (item === undefined) return false;
	if (result.action === "close") {
		await close(env, ctx, item);
		return true;
	}
	await (result.action === "switch" ? switchTo(env, ctx, item) : open(env, ctx, item));
	return false;
}

/** One action on one open delegate, as `/delegate-open` runs it. */
async function openOne(env: Env, ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> {
	const items = await openDelegates(env);
	if (items === undefined) return noTmux(ctx);
	const item = items.find((candidate) => candidate.id === id);
	if (item === undefined) {
		const known = items.map((candidate) => candidate.id).join(", ") || "none";
		return ctx.ui.notify(`delegate: no open delegate ${JSON.stringify(id)}; open: ${known}`, "error");
	}
	if (mode === "popup") return popup(env, ctx, item);
	if (mode === "switch") return switchTo(env, ctx, item);
	if (mode === "auto") return open(env, ctx, item);
	if (!ctx.hasUI) return noUi(ctx);
	if ((await show(env, ctx, [item], true))?.action === "open") await open(env, ctx, item);
}

/** The navigator over the records, tmux and tracking. `startNew` is the new-delegate flow, wired by the entry. */
export function createNavigator(
	results: Results,
	tmux: TmuxClient,
	tracking: Pick<Tracking, "trackPopup" | "close">,
	startNew: (ctx: ExtensionContext) => Promise<void> | void,
): Navigator {
	const env: Env = { results, tmux, tracking };
	return {
		async panel(ctx: ExtensionContext): Promise<void> {
			if (!ctx.hasUI) return noUi(ctx);
			for (;;) {
				const items = await openDelegates(env);
				if (items === undefined) return noTmux(ctx);
				if (!(await act(env, startNew, ctx, items, await show(env, ctx, items, false)))) return;
			}
		},
		openDelegate: (ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> => openOne(env, ctx, id, mode),
		async openIds(): Promise<string[]> {
			return (await openDelegates(env))?.map((item) => item.id) ?? [];
		},
	};
}

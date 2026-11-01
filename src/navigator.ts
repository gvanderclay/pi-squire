// The delegate navigator: the `/delegates` panel and `/delegate-open`. It lists
// the descendant hierarchy, retains history and reaches a verified open window: a switch of
// the user's tmux client to its window, a peek at the pane, or a close. Everything here is a command or a key; the model gets no tool that
// moves the user's terminal.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import {
	type DelegationState,
	deriveState,
	isStarted,
	locateSession,
	type Results,
	recordedName,
	type StartedRecorded,
	sessionIdOf,
} from "./results.ts";
import type { TmuxClient, TmuxWindow } from "./tmux.ts";
import { listWindows, ownWindow, type Tracking } from "./tracking.ts";

/** What `/delegate-open` does; switch is what enter does in the panel. */
export type OpenMode = "switch" | "peek";

export const OPEN_USAGE = "/delegate-open <id> [--switch|--peek]";
const OPEN_FLAGS = ["--switch", "--peek"] as const;

/** One delegation whose window is open. */
type OpenDelegate = {
	resumedAs?: string;
	id: string;
	name: string;
	agent: string;
	state: DelegationState;
	window: TmuxWindow;
	navigable: boolean;
	record: StartedRecorded;
};

/** What the panel hands back: the action the user chose on one delegation, or none. */
type PanelResult = { action: "switch" | "close" | "peek"; id: string } | { action: "new" } | undefined;

/** What the peek hands back: switch to the delegate, or nothing. */
type PeekResult = { action: "switch" } | undefined;

const HINT = "↑↓ select · enter switch · p peek · x close · n new · esc leave";
const EMPTY = "No open delegates · n new · esc close";
const PEEK_HINT = "r refresh · enter switch · esc back";

/** Where a peek shows: over the panel or the editor, not in its place. */
const PEEK_OPTIONS = { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } } as const;

type PanelTheme = { fg(color: string, text: string): string; bold(text: string): string };

type Capture = { text: string; error: string | undefined; loading: boolean };

/** The lines a peek shows: the captured pane's last rows, or why there is none. */
function peekBody(peek: Capture, rows: number): string[] {
	if (peek.loading) return ["Capturing…"];
	if (peek.error !== undefined) return [`Could not capture the pane: ${peek.error}`];
	return peek.text
		.replace(/\s+$/, "")
		.split("\n")
		.slice(-Math.max(5, rows - 8));
}

/** The panel's list of open delegates, as a pi-tui component. */
class Panel implements Component {
	private selected = 0;
	private readonly items: readonly OpenDelegate[];
	private readonly theme: PanelTheme;
	private readonly done: (result: PanelResult) => void;
	private readonly redraw: () => void;

	constructor(parts: {
		items: readonly OpenDelegate[];
		theme: PanelTheme;
		done: (result: PanelResult) => void;
		redraw: () => void;
	}) {
		this.items = parts.items;
		this.theme = parts.theme;
		this.done = parts.done;
		this.redraw = parts.redraw;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const item = this.items[this.selected];
		const count = this.items.length;
		if (matchesKey(data, "escape")) this.done(undefined);
		else if (matchesKey(data, "n")) this.done({ action: "new" });
		else if (item === undefined) return;
		else if (matchesKey(data, "up")) this.selected = (this.selected + count - 1) % count;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % count;
		else if (matchesKey(data, "enter")) this.done({ action: "switch", id: item.id });
		else if (matchesKey(data, "p")) this.done({ action: "peek", id: item.id });
		else if (matchesKey(data, "x")) this.done({ action: "close", id: item.id });
		this.redraw();
	}

	render(width: number): string[] {
		const fit = (text: string): string => truncateToWidth(text, Math.max(1, width));
		if (this.items.length === 0) return [this.theme.bold("Delegates"), "", EMPTY].map(fit);
		const baseDepth = Math.min(...this.items.map((item) => item.record.identity?.depth ?? 1));
		const lines = this.items.map((item, index) => {
			const where = item.window.session === "" ? item.window.id : `${item.window.id} in ${item.window.session}`;
			const indent = "  ".repeat(Math.max(0, (item.record.identity?.depth ?? 1) - baseDepth));
			const row = `${indent}${item.name} · ${item.agent} · ${item.state} · ${where}`;
			return index === this.selected ? this.theme.fg("accent", `▸ ${row}`) : `  ${row}`;
		});
		const selected = this.items[this.selected];
		const detail = selected ? detailLines(selected) : [];
		return [this.theme.bold("Delegates"), "", ...lines, "", ...detail, "", this.theme.fg("dim", HINT)].map(fit);
	}
}

/** A snapshot of one delegate's pane, shown as an overlay: `r` refreshes, enter switches, esc returns. */
class PeekView implements Component {
	private capture: Capture = { text: "", error: undefined, loading: true };
	private readonly item: OpenDelegate;
	private readonly theme: PanelTheme;
	private readonly read: (windowId: string) => Promise<string>;
	private readonly done: (result: PeekResult) => void;
	private readonly redraw: () => void;
	private readonly rows: () => number;

	constructor(parts: {
		item: OpenDelegate;
		theme: PanelTheme;
		read: (windowId: string) => Promise<string>;
		done: (result: PeekResult) => void;
		redraw: () => void;
		rows: () => number;
	}) {
		this.item = parts.item;
		this.theme = parts.theme;
		this.read = parts.read;
		this.done = parts.done;
		this.redraw = parts.redraw;
		this.rows = parts.rows;
		this.refresh();
	}

	invalidate(): void {}

	private refresh(): void {
		this.capture = { text: "", error: undefined, loading: true };
		void this.read(this.item.window.id).then(
			(text) => {
				this.capture = { text, error: undefined, loading: false };
				this.redraw();
			},
			(err: unknown) => {
				this.capture = { text: "", error: (err as Error).message, loading: false };
				this.redraw();
			},
		);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.done(undefined);
		else if (matchesKey(data, "r")) this.refresh();
		else if (matchesKey(data, "enter")) this.done({ action: "switch" });
		this.redraw();
	}

	render(width: number): string[] {
		const fit = (text: string): string => truncateToWidth(text, Math.max(1, width));
		const head = this.theme.bold(`Peek: ${this.item.name} (${this.item.window.id})`);
		const body = peekBody(this.capture, this.rows());
		return [head, "", ...body, "", this.theme.fg("dim", PEEK_HINT)].map(fit);
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
	if (flags.length > 1) return { error: `give at most one of --switch and --peek; ${OPEN_USAGE}` };
	if (ids.length !== 1) return { error: `give one delegation id; ${OPEN_USAGE}` };
	const flag = flags[0];
	return { id: ids[0], mode: flag === undefined ? "switch" : (flag.slice(2) as OpenMode) };
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

type Env = { results: Results; tmux: TmuxClient; tracking: Pick<Tracking, "close"> };

/** The open delegations, newest first, from the records and one listing; undefined when tmux cannot be asked. */
async function openDelegates({ results, tmux }: Env, history = false): Promise<OpenDelegate[] | undefined> {
	const windows = await listWindows(tmux);
	if (windows === undefined && !history) return undefined;
	const found: OpenDelegate[] = [];
	const all = results.list();
	for (const record of all) {
		if (!isStarted(record)) continue;
		const item = panelItem(record, windows);
		item.resumedAs = all.find((next) => isStarted(next) && next.resumedFrom === record.id)?.id;
		if (!history && (!item.navigable || !["running", "done", "gone"].includes(item.state))) continue;
		found.push(item);
	}
	return history ? found : found.reverse();
}

function panelItem(record: StartedRecorded, windows: TmuxWindow[] | undefined): OpenDelegate {
	const window = windows ? ownWindow(windows, record) : undefined;
	const navigable = window !== undefined && !window.exited;
	let state: import("./results.ts").WindowState = "unknown";
	if (windows) state = navigable ? "open" : "gone";
	return {
		id: record.id,
		name: recordedName(record),
		agent: record.displayName ?? record.agent,
		state: deriveState(record, state),
		window: window ?? { id: record.windowId, name: record.windowName, exited: true, session: "" },
		navigable,
		record,
	};
}
function detailLines(item: OpenDelegate): string[] {
	const record = item.record;
	return [
		`delegation: ${record.id} · session: ${sessionIdOf(record)}`,
		`parent: ${record.identity?.parent ?? "this session"} · root: ${record.identity?.root ?? "this session"} · depth: ${record.identity?.depth ?? 1}`,
		`cwd: ${record.cwd ?? "unknown"} · workspace: ${record.workspace?.cwd ?? "none recorded"}`,
		`session file: ${locateSession(record, undefined) ?? "not found"}`,
		`session directory: ${record.sessionDir ?? "not recorded"}`,
		`result: ${record.result?.status ?? "none received"} · envelope: ${record.result?.envelopePath ?? "none"}`,
		`resumed from: ${record.resumedFrom ?? "none"} · resumed as: ${item.resumedAs ?? "none"} · auto-exit: ${record.autoExit === true ? "on" : "off"}`,
		`model: ${record.model} · thinking: ${record.thinking}`,
	];
}
async function verifiedWindow(env: Env, item: OpenDelegate): Promise<boolean> {
	const record = env.results.find(item.id);
	if (!record || !isStarted(record)) return false;
	const windows = await listWindows(env.tmux);
	const window = windows ? ownWindow(windows, record) : undefined;
	return window !== undefined && !window.exited && window.id === item.window.id;
}

/** The parent\'s own session name, or undefined when tmux cannot say. */
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

async function switchTo(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	if (!(await verifiedWindow(env, item)))
		return ctx.ui.notify("delegate: no verified open window for this delegation", "error");
	const found = await clientOf(env.tmux);
	if ("refusal" in found) return ctx.ui.notify(`delegate: cannot switch: ${found.refusal}`, "warning");
	try {
		await env.tmux.switchTo(found.client, item.window.id);
	} catch (err) {
		return ctx.ui.notify(`delegate: could not switch: ${(err as Error).message}`, "error");
	}
	ctx.ui.notify(
		`delegate: switched to ${item.name} (${item.window.id}) · your tmux last-session key returns you`,
		"info",
	);
}

/** Close through the `delegation_close` path, asking first only while the delegate runs. */
async function close(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	if (item.record.identity && item.record.identity.parent !== ctx.sessionManager.getSessionId())
		return ctx.ui.notify(
			"delegate: descendant subtree close is not available until the explicit-close slice; no window was killed.",
			"warning",
		);
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

/** Show the panel; resolves with what the user chose. */
function show(ctx: ExtensionContext, items: readonly OpenDelegate[]): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, _keybindings, done): Panel =>
			new Panel({
				items,
				theme: theme as unknown as PanelTheme,
				done,
				redraw: (): void => tui.requestRender(),
			}),
	);
}

/** Peek at a delegate's pane in an overlay; true when the user chose to switch to it. */
async function peek(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<boolean> {
	const result = await ctx.ui.custom<PeekResult>(
		(tui, theme, _keybindings, done): PeekView =>
			new PeekView({
				item,
				theme: theme as unknown as PanelTheme,
				read: async (windowId: string): Promise<string> => {
					if (!(await verifiedWindow(env, item))) throw new Error("no verified open window");
					return env.tmux.capture(windowId);
				},
				done,
				redraw: (): void => tui.requestRender(),
				rows: (): number => tui.terminal.rows,
			}),
		PEEK_OPTIONS,
	);
	return result?.action === "switch";
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
	if (result.action === "peek") {
		if (!item.navigable) {
			ctx.ui.notify("delegate: no verified open window to peek", "warning");
			return true;
		}
		if (!(await peek(env, ctx, item))) return true; // back to the panel
		await switchTo(env, ctx, item);
		return false;
	}
	await switchTo(env, ctx, item);
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
	if (mode === "switch") return switchTo(env, ctx, item);
	if (ctx.mode !== "tui") return noUi(ctx);
	if (await peek(env, ctx, item)) await switchTo(env, ctx, item);
}

/** The navigator over the records, tmux and tracking. `startNew` is the new-delegate flow, wired by the entry. */
export function createNavigator(
	results: Results,
	tmux: TmuxClient,
	tracking: Pick<Tracking, "close">,
	startNew: (ctx: ExtensionContext) => Promise<void> | void,
): Navigator {
	const env: Env = { results, tmux, tracking };
	return {
		async panel(ctx: ExtensionContext): Promise<void> {
			if (ctx.mode !== "tui") return noUi(ctx);
			for (;;) {
				const items = await openDelegates(env, true);
				if (items === undefined) return noTmux(ctx);
				if (!(await act(env, startNew, ctx, items, await show(ctx, items)))) return;
			}
		},
		openDelegate: (ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> => openOne(env, ctx, id, mode),
		async openIds(): Promise<string[]> {
			return (await openDelegates(env))?.map((item) => item.id) ?? [];
		},
	};
}

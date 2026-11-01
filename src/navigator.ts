// The delegate navigator: the `/delegates` panel and `/delegate-open`. It lists
// the descendant hierarchy, retains history and reaches a verified open window: a switch of
// the user's tmux client to its window, a peek at the pane, or a close. Everything here is a command or a key; the model gets no tool that
// moves the user's terminal.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Dashboard, type DashboardIntent, type DashboardPosition, type DashboardRow } from "./dashboard.ts";
import { readIdentity } from "./identity.ts";

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
import { descendants, readTree } from "./tree-registry.ts";

/** What `/delegate-open` does; dashboard Enter opens details before switching. */
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
type PanelResult = DashboardIntent;

/** What the peek hands back: switch to the delegate, or nothing. */
type PeekResult = { action: "switch" } | undefined;

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
		if (isKeyRelease(data)) return;
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
	panel(ctx: ExtensionContext, targetSessionId?: string): Promise<void>;
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

/** Context-bearing action seam; presentation never owns close/resume scope or result wording. */
export type NavigatorActions = {
	assertActive(): void;
	close(
		id: string,
		ctx: ExtensionContext,
	): Promise<{ text: string; isError?: boolean; details?: { complete: boolean } }>;
	resume(id: string, ctx: ExtensionContext): Promise<void>;
};
type Env = {
	results: Results;
	tmux: TmuxClient;
	tracking: Pick<Tracking, "close" | "closeAll">;
	actions: Partial<NavigatorActions>;
};

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
	env.actions.assertActive?.();
	const record = env.results.find(item.id);
	if (!record || !isStarted(record)) return false;
	const windows = await listWindows(env.tmux);
	env.actions.assertActive?.();
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
	env.actions.assertActive?.();
	if (!(await verifiedWindow(env, item)))
		return ctx.ui.notify("delegate: no verified open window for this delegation", "error");
	const found = await clientOf(env.tmux);
	if ("refusal" in found) return ctx.ui.notify(`delegate: cannot switch: ${found.refusal}`, "warning");
	try {
		env.actions.assertActive?.();
		await env.tmux.switchTo(found.client, item.window.id);
	} catch (err) {
		return ctx.ui.notify(`delegate: could not switch: ${(err as Error).message}`, "error");
	}
	ctx.ui.notify(
		`delegate: switched to ${item.name} (${item.window.id}) · your tmux last-session key returns you`,
		"info",
	);
}

function runningDescendants(item: OpenDelegate): boolean {
	if (!item.record.identity) return false;
	try {
		return descendants(readTree(item.record.identity.root), sessionIdOf(item.record)).some(
			(entry) => !entry.closed && !entry.finished && entry.phase !== "not-started",
		);
	} catch {
		return true; // Unavailable descendant state is not proof that closing is harmless.
	}
}

/** Close through the shared control path, confirming running/unknown descendant work. */
async function close(env: Env, ctx: ExtensionContext, item: OpenDelegate): Promise<void> {
	if (item.state === "running" || runningDescendants(item)) {
		const message = `${item.name} is still running. Close its entire recorded subtree and kill its verified windows?`;
		if (!(await ctx.ui.confirm("Close delegate", message))) return;
	}
	try {
		env.actions.assertActive?.();
		const result = await (env.actions.close?.(item.id, ctx) ?? env.tracking.close(item.id, ctx));
		env.actions.assertActive?.();
		ctx.ui.notify(
			`delegate: ${result.text}`,
			("isError" in result && result.isError) || result.details?.complete === false ? "error" : "info",
		);
	} catch (err) {
		ctx.ui.notify(`delegate: ${(err as Error).message}`, "error");
	}
}

/** Map authority-owned records into presentation-only rows. */
function dashboardRows(items: readonly OpenDelegate[]): DashboardRow[] {
	const baseDepth: number = Math.min(...items.map((item) => item.record.identity?.depth ?? 1));
	return items.map((item) => {
		const where: string = item.window.session === "" ? item.window.id : `${item.window.id} in ${item.window.session}`;
		const depth: number = Math.max(0, (item.record.identity?.depth ?? 1) - baseDepth);
		return {
			id: item.id,
			label: `${item.name} · ${item.agent} · ${item.state} · ${where}`,
			depth,
			details: detailLines(item),
		};
	});
}

/** Both entry points use this exact dashboard, differing only in initial focus/back destination. */
function show(
	ctx: ExtensionContext,
	items: readonly OpenDelegate[],
	position: DashboardPosition,
	fromWidget: boolean,
): Promise<PanelResult> {
	return ctx.ui.custom<PanelResult>(
		(tui, theme, _keybindings, done) =>
			new Dashboard({
				items: dashboardRows(items),
				root: readIdentity(ctx.sessionManager.getSessionId()) === undefined,
				position,
				detailBack: fromWidget ? "exit" : "list",
				theme,
				done,
				redraw: () => tui.requestRender(),
				rows: () => tui.terminal.rows,
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

async function closeAll(env: Env, ctx: ExtensionContext): Promise<void> {
	if (
		!(await ctx.ui.confirm(
			"Close all delegate subtrees",
			"Close every recorded descendant of this root? Worktrees and branches are retained.",
		))
	)
		return;
	try {
		env.actions.assertActive?.();
		const closed = await env.tracking.closeAll(ctx);
		env.actions.assertActive?.();
		ctx.ui.notify(`delegate: ${closed.text}`, closed.details.complete ? "info" : "error");
	} catch (error) {
		ctx.ui.notify(`delegate: ${String(error)}`, "error");
	}
}

/** Carry out what the panel returned; true when the panel should open again. */
async function act(
	env: Env,
	startNew: (ctx: ExtensionContext) => Promise<void> | void,
	ctx: ExtensionContext,
	items: OpenDelegate[],
	result: PanelResult,
): Promise<boolean> {
	if (result === undefined) return false;
	env.actions.assertActive?.();
	if (result.action === "new") {
		await startNew(ctx);
		return false;
	}
	if (result.action === "close-all") {
		await closeAll(env, ctx);
		return true;
	}
	const item = items.find((candidate) => candidate.id === result.id);
	if (item === undefined) return false;
	if (result.action === "resume") {
		if (env.actions.resume) await env.actions.resume(item.id, ctx);
		else ctx.ui.notify("delegate: resume is unavailable in this dashboard", "warning");
		return true;
	}
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
	env.actions.assertActive?.();
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

function focusTarget(items: OpenDelegate[], target: string | undefined, position: DashboardPosition): boolean {
	if (target === undefined) return true;
	position.id = items.filter((item) => sessionIdOf(item.record) === target).at(-1)?.id;
	return position.id !== undefined;
}

/** The navigator over the records, tmux and tracking. `startNew` is wired by the entry. */
export function createNavigator(
	results: Results,
	tmux: TmuxClient,
	tracking: Pick<Tracking, "close" | "closeAll">,
	startNew: (ctx: ExtensionContext) => Promise<void> | void,
	actions: Partial<NavigatorActions> = {},
): Navigator {
	const env: Env = { results, tmux, tracking, actions };
	return {
		async panel(ctx: ExtensionContext, targetSessionId?: string): Promise<void> {
			if (ctx.mode !== "tui") return noUi(ctx);
			const position: DashboardPosition = { detail: targetSessionId !== undefined, offset: 0 };
			let initial = true;
			for (;;) {
				actions.assertActive?.();
				const items = await openDelegates(env, true);
				actions.assertActive?.();
				if (items === undefined) return noTmux(ctx);
				if (initial && !focusTarget(items, targetSessionId, position))
					return ctx.ui.notify("delegate: selected delegate is no longer available", "warning");
				initial = false;
				const result: PanelResult = await show(ctx, items, position, targetSessionId !== undefined);
				if (!(await act(env, startNew, ctx, items, result))) return;
			}
		},
		openDelegate: (ctx: ExtensionContext, id: string, mode: OpenMode): Promise<void> => openOne(env, ctx, id, mode),
		async openIds(): Promise<string[]> {
			return (await openDelegates(env))?.map((item) => item.id) ?? [];
		},
	};
}

// Rex 0.1.0-preview.20, API revision 16 (rex --help, rex api describe and live
// probes of that version). A window's terminal runs the staged launcher
// directly (--shell=none), so no text is ever typed into a shell. Rex closes
// the terminal when its program exits and keeps it only after a start that
// fails at once; terminal state is never task state.
import { execFile } from "node:child_process";
import {
	type DelegateHost,
	type NoViewer,
	type OpenedWindow,
	type ShowResult,
	type StartKind,
	WindowOpenError,
	type WindowSpec,
	type WindowTarget,
} from "./host.ts";
import type { VerifiedLiveWindow, WindowRecord } from "./locator-rules.ts";
import { type AcquiredCompanion, createRexCompanions, type RexCompanions } from "./rex-companions.ts";
import { launchEnvironment, readLaunchStatus, stageLaunch } from "./rex-launch.ts";
import { type RexLocator, type RexPaneLocator, rexLocator, rexLocators, rexPaneLocator } from "./rex-locator.ts";
import type { WindowPlacement } from "./window-placement.ts";
import type { ClosableStates, WindowLook } from "./window-state.ts";

/** Launch staging lives in its own module; re-exported for the existing imports. */
export { launchEnvironment };

/** The lowest API revision these commands and reply fields were verified on. */
const API_REVISION = 16;
/** The rows a peek keeps; `rex capture` has no tail option and returns the whole scrollback. */
const PEEK_LINES = 500;
/** Block lists are read for every live session each sweep; keep the fan-out bounded. */
const SNAPSHOT_CONCURRENCY = 4;

type Json = Record<string, unknown>;
type Block = { block_id: string; window_id?: string };
type LiveSession = { id: string; label: string };
/**
 * One observation sweep of the pinned endpoint. `sessions` is undefined when
 * the session list failed, which makes every record unknown. A listed session
 * maps to its blocks, or to undefined when that session's own query failed.
 */
type ServerSnapshot = { sessions: LiveSession[] | undefined; blocks: Map<string, Block[] | undefined> };
/** Which Rex server a call reaches: the endpoint Rex put in the terminal's REX_SERVER. */
export type RexRoute = { server: string };
export type RexRun = (route: RexRoute, args: string[]) => Promise<string>;
export type RexContext = RexRoute & { session: string; block: string };

function object(value: unknown): Json {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Rex response");
	return value as Json;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function context(): RexContext | undefined {
	const { REX_SERVER, REX_SESSION, REX_BLOCK } = process.env;
	return REX_SERVER && REX_SESSION && REX_BLOCK
		? { server: REX_SERVER, session: REX_SESSION, block: REX_BLOCK }
		: undefined;
}
/**
 * The rex argv that reaches exactly this route. `-S` names the endpoint, so a
 * changed REX_SERVER cannot redirect the call, and `--autostart=false` keeps a
 * probe from starting a server that would know none of the recorded ids.
 */
export function rexInvocation(route: RexRoute, args: string[]): string[] {
	return ["-S", route.server, "--autostart=false", ...args];
}
function runRex(timeout: number): RexRun {
	return (route: RexRoute, args: string[]) =>
		new Promise((resolve, reject) => {
			execFile(
				"rex",
				rexInvocation(route, args),
				// A capture is the whole scrollback, which Rex caps near 64 MiB.
				{ encoding: "utf8", timeout, maxBuffer: 96 * 1024 * 1024 },
				(error, out, err) => {
					if (error) {
						reject(
							new Error(
								`rex ${args.slice(0, 2).join(" ")} failed: ${error.killed ? "timed out" : err.trim() || error.message}`,
							),
						);
					} else resolve(out);
				},
			);
		});
}

/** Rex reports a session without blocks as null; anything else must be a block array. */
function parseBlocks(raw: string): Block[] {
	const listed = object(JSON.parse(raw)).blocks;
	const blocks = listed === null ? [] : listed;
	if (!Array.isArray(blocks)) throw new Error("invalid Rex block list");
	const found = blocks.map((item): Block => {
		const block = object(item);
		if (!text(block.block_id)) throw new Error("Rex block list lacks block identity");
		return { block_id: block.block_id, ...(text(block.window_id) ? { window_id: block.window_id } : {}) };
	});
	if (new Set(found.map((block) => block.block_id)).size !== found.length) throw new Error("ambiguous Rex block list");
	return found;
}

/** Rex reports no sessions as null; labels are not unique and are never identity. */
function parseSessions(raw: string): LiveSession[] {
	const listed = object(JSON.parse(raw)).sessions;
	const sessions = listed === null ? [] : listed;
	if (!Array.isArray(sessions)) throw new Error("invalid Rex session list");
	const found = sessions.map((item): LiveSession => {
		const session = object(item);
		if (!text(session.session_id) || typeof session.label !== "string")
			throw new Error("Rex session list lacks session identity");
		return { id: session.session_id, label: session.label };
	});
	if (new Set(found.map((session) => session.id)).size !== found.length) throw new Error("ambiguous Rex session list");
	return found;
}

type RexOptions = {
	run?: RexRun;
	context?: () => RexContext | undefined;
	timeoutMs?: number;
	/** Companion receipt ownership; defaults to this agent directory and the same runner. */
	companions?: RexCompanions;
};
class RexClient implements DelegateHost {
	readonly id = "rex";
	readonly windowNoun = "window";
	readonly usesWindowPlacement = true;
	readonly requiresSessionGuard = rexLocators.requiresSessionGuard;
	readonly windowListRefusal = "could not ask Rex for its delegate windows";
	readonly refusal =
		"this session is not inside a Rex terminal (needs REX_SERVER, REX_SESSION and REX_BLOCK); start Pi in Rex to open a delegate window (multiplexer: rex)";
	readonly run: RexRun;
	readonly caller: () => RexContext | undefined;
	readonly companions: RexCompanions;
	constructor(options: RexOptions) {
		this.run = options.run ?? runRex(options.timeoutMs ?? 10_000);
		this.caller = options.context ?? context;
		this.companions = options.companions ?? createRexCompanions({ run: this.run });
	}
	taskMailTiming(kind: StartKind): "before-open" | "after-open" {
		return kind === "resume" ? "after-open" : "before-open";
	}
	ownsLocator(value: unknown): boolean {
		return !!rexLocator(value) || !!rexPaneLocator(value);
	}
	async available(): Promise<string | undefined> {
		const own = this.caller();
		if (!own) return this.refusal;
		try {
			const server = object(JSON.parse(await this.run(own, ["whoami", "--json"])));
			if (!Number.isSafeInteger(server.api_revision) || (server.api_revision as number) < API_REVISION)
				return `Rex delegation needs a server with API revision ${API_REVISION} or later (verified with Rex 0.1.0-preview.20); no other host was tried`;
			if (server.endpoint !== own.server) return "Rex server identity changed; launch refused";
			// The parent's own block must still be in the session Pi started in.
			if (!(await this.snapshot(own)).some((block) => block.block_id === own.block))
				return `this Pi's Rex block ${own.block} is no longer in session ${own.session}; delegates open relative to the session Pi started in, so launch refused. Restart Pi in the Rex session you want`;
			return undefined;
		} catch (error) {
			return `could not ask Rex for the parent block/server: ${String(error)}; no other host was tried`;
		}
	}
	unavailable(): string | undefined;
	unavailable(check: true): Promise<string | undefined>;
	unavailable(check?: true): string | undefined | Promise<string | undefined> {
		if (check) return this.available();
		return this.caller() ? undefined : this.refusal;
	}
	/** Every block of one session, detached ones included. */
	async sessionBlocks(own: RexContext, session: string): Promise<Block[]> {
		return parseBlocks(await this.run(own, ["block", "ls", "-s", session, "--json"]));
	}
	/** The caller's own session, as availability checks it. */
	snapshot(own: RexContext): Promise<Block[]> {
		return this.sessionBlocks(own, own.session);
	}
	/** Every live session on the pinned endpoint. */
	async sessions(own: RexContext): Promise<LiveSession[]> {
		return parseSessions(await this.run(own, ["api", "call", "session.list"]));
	}
	/**
	 * One sweep of the pinned endpoint: the live session ids, then each one's
	 * blocks. A failed session list makes every record unknown; a failed
	 * per-session block query leaves that session unknown, never gone.
	 */
	async serverSnapshot(own: RexContext): Promise<ServerSnapshot> {
		let sessions: LiveSession[];
		try {
			sessions = await this.sessions(own);
		} catch {
			return { sessions: undefined, blocks: new Map() };
		}
		const blocks = new Map<string, Block[] | undefined>();
		const queue = [...sessions];
		const sweep = async (): Promise<void> => {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				try {
					blocks.set(next.id, await this.sessionBlocks(own, next.id));
				} catch {
					blocks.set(next.id, undefined);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(SNAPSHOT_CONCURRENCY, queue.length) }, sweep));
		return { sessions, blocks };
	}
	/** A locator this Pi can act on: the same endpoint. Sessions differ by placement. */
	private sameServer<T extends RexLocator | RexPaneLocator>(
		locator: T | undefined,
		own: RexContext | undefined,
	): T | undefined {
		return locator && own && locator.server === own.server ? locator : undefined;
	}
	async states(): Promise<ClosableStates> {
		const own = this.caller();
		const observed: ServerSnapshot = own
			? await this.serverSnapshot(own).catch(() => ({ sessions: undefined, blocks: new Map() }))
			: { sessions: undefined, blocks: new Map() };
		const locate = (record: WindowRecord): RexLocator | RexPaneLocator | undefined =>
			this.sameServer(rexLocator(record.locator) ?? rexPaneLocator(record.locator), own);
		/** The blocks this sweep read for the locator's session; undefined when it could not read them. */
		const blocksOf = (locator: RexLocator | RexPaneLocator): Block[] | undefined =>
			observed.blocks.get(locator.session);
		const listed = (record: WindowRecord): boolean => {
			const locator = locate(record);
			return locator !== undefined && blocksOf(locator)?.some((block) => block.block_id === locator.block) === true;
		};
		const look = (record: WindowRecord): WindowLook => this.recordLook(observed, locate(record));
		return {
			answered: observed.sessions !== undefined,
			look,
			state: (record: WindowRecord): WindowLook["state"] => look(record).state,
			listed,
			close: async (record: WindowRecord): Promise<boolean> => {
				const locator = locate(record);
				if (!locator || !own || !observed.sessions)
					throw new Error("could not verify Rex block identity; no block was closed");
				if (listed(record)) return this.closeBlock(own, locator);
				// A failed per-session query is unknown, not proof of absence.
				if (blocksOf(locator) === undefined && observed.blocks.has(locator.session))
					throw new Error("could not read that Rex session's blocks; no block was closed");
				return false;
			},
		};
	}
	/** One record's state from a completed sweep: unknown is never gone. */
	private recordLook(observed: ServerSnapshot, locator: RexLocator | RexPaneLocator | undefined): WindowLook {
		if (!locator || !observed.sessions) return { state: "unknown" };
		// A session the successful list did not name is positively gone; a listed
		// session whose block query failed is unknown, never gone.
		if (!observed.blocks.has(locator.session)) return { state: "gone" };
		const blocks = observed.blocks.get(locator.session);
		if (blocks === undefined) return { state: "unknown" };
		if (!blocks.some((block) => block.block_id === locator.block)) return { state: "gone" };
		// A pane locator is this Pi's own live terminal: no launch file to read.
		if (locator.kind === "pane") return { state: "running", session: locator.session };
		try {
			// A retained terminal whose runner published an exit is no longer running.
			return {
				state: readLaunchStatus(locator.launchFile)?.exit === undefined ? "running" : "gone",
				session: locator.session,
			};
		} catch {
			return { state: "unknown" };
		}
	}
	/**
	 * Fresh observation immediately before close, in the locator's own session.
	 * Close only the owned block, never its window or session.
	 */
	private async closeBlock(own: RexContext, locator: RexLocator | RexPaneLocator): Promise<boolean> {
		const present = async (): Promise<boolean> => {
			try {
				return (await this.sessionBlocks(own, locator.session)).some((block) => block.block_id === locator.block);
			} catch (error) {
				// The whole session may have gone; only a successful list that omits it
				// proves that, and a transport failure stays unknown.
				if (await this.sessionGone(own, locator.session)) return false;
				throw error;
			}
		};
		if (!(await present())) return false;
		try {
			await this.run(own, ["block", "close", "-s", locator.session, locator.block]);
		} catch (error) {
			// The program may have exited between the observation and the close.
			if (await present()) throw error;
			return false;
		}
		return true;
	}

	/** The proved companion session for this base, or the caller's own session. */
	private async target(
		own: RexContext,
		placement: WindowPlacement,
		companion: string,
	): Promise<AcquiredCompanion | { session: string }> {
		if (placement === "current") return { session: own.session };
		return this.companions.acquire({ server: own.server }, companion);
	}
	async openWindow(spec: WindowSpec, placement: WindowPlacement, companion: string): Promise<OpenedWindow> {
		const problem = await this.available();
		if (problem) throw new WindowOpenError(problem, "not-opened");
		const own = this.caller();
		if (!own) throw new WindowOpenError(this.refusal, "not-opened");
		// The label is a positional argument; one starting with "-" would read as an option.
		if (spec.name.startsWith("-"))
			throw new WindowOpenError(`Rex cannot label a window ${JSON.stringify(spec.name)}`, "not-opened");
		let launchFile: string;
		try {
			launchFile = stageLaunch(spec);
		} catch (error) {
			throw new WindowOpenError(message(error), "not-opened");
		}
		// Receipt, session-list and readback failures all happen before a delegate
		// window is requested, so none of them can have started a delegate.
		const target = await this.target(own, placement, companion);
		let created: Json;
		try {
			created = object(
				JSON.parse(
					await this.run(own, [
						"window",
						"new",
						"-s",
						target.session,
						spec.name,
						"-c",
						spec.cwd,
						// Start the runner itself: no shell startup files, no typed command line.
						"--shell=none",
						"--focus=false",
						"--json",
						"--",
						process.execPath,
						launchFile,
					]),
				),
			);
		} catch (error) {
			// A lost or malformed reply does not say whether Rex created the window.
			throw new WindowOpenError(message(error), "unknown");
		}
		const ids = created.block_ids;
		if (!text(created.window_id) || !Array.isArray(ids) || ids.length !== 1 || !text(ids[0]))
			throw new WindowOpenError("Rex create response has inconsistent identity", "unknown");
		const locator: RexLocator = {
			adapter: "rex",
			version: 1,
			kind: "window",
			server: own.server,
			session: target.session,
			window: created.window_id,
			block: ids[0],
			name: spec.name,
			launchFile,
		};
		const label = "label" in target ? `${target.label} (${locator.session})` : locator.session;
		return {
			id: locator.window,
			session: locator.session,
			locator,
			location: `window ${spec.name} (${locator.window}) in Rex session ${label}`,
		};
	}
	async closeTaskless(opened: OpenedWindow): Promise<void> {
		const closed = await this.states()
			.then((states) => states.close({ locator: opened.locator }))
			.catch(() => false);
		if (closed) return;
		const own = rexLocator(opened.locator);
		throw new Error(
			`the resumed delegate's ${opened.location ?? `window ${opened.id}`} could not be closed and may still run Pi with no task. Check it is the delegate, then close its terminal yourself (rex block close -s ${own?.session} ${own?.block})`,
		);
	}
	/** The caller's window id and label, read from its own session's view. */
	private async window(own: RexContext, block: string): Promise<{ id: string; label: string } | undefined> {
		const view = object(JSON.parse(await this.run(own, ["window", "ls", "-s", own.session, "--json"])));
		for (const item of Array.isArray(view.windows) ? view.windows : []) {
			const window = object(item);
			const layers = Array.isArray(window.layers) ? window.layers.map(object) : [];
			const held = layers.some(
				(layer) => Array.isArray(layer.blocks) && layer.blocks.some((entry) => object(entry).block_id === block),
			);
			if (held && text(window.window_id))
				return { id: window.window_id, label: text(window.label) ? window.label : window.window_id };
		}
		return undefined;
	}
	async observeLivePane(): Promise<RexPaneLocator | undefined> {
		const own = this.caller();
		if (!own) return undefined;
		const live = await this.window(own, own.block);
		if (!live) return undefined;
		return { adapter: "rex", version: 1, kind: "pane", ...own, window: live.id, name: live.label };
	}
	/** Positive proof the exact session no longer exists: a successful list that omits it. */
	private async sessionGone(own: RexContext, session: string): Promise<boolean> {
		try {
			return !(await this.sessions(own)).some((item) => item.id === session);
		} catch {
			// A failed list proves nothing about the session.
			return false;
		}
	}
	/** The locator's block as its recorded session lists it now, across sessions of this endpoint. */
	private async blockIn(own: RexContext, locator: RexLocator | RexPaneLocator): Promise<Block | undefined> {
		return (await this.sessionBlocks(own, locator.session)).find((block) => block.block_id === locator.block);
	}
	async verifiedTarget(value: unknown): Promise<RexLocator | RexPaneLocator | undefined> {
		const own = this.caller();
		const locator = this.sameServer(rexLocator(value) ?? rexPaneLocator(value), own);
		if (!locator || !own) return undefined;
		return (await this.blockIn(own, locator)) ? locator : undefined;
	}
	async verifyLivePane(value: object): Promise<VerifiedLiveWindow | undefined> {
		if (!rexPaneLocator(value)) return undefined;
		const locator = await this.verifiedTarget(value);
		return locator ? { locator, paneTarget: locator.block } : undefined;
	}
	/**
	 * The one app attached to the calling Pi's session. The delegate's session
	 * may have no app attached yet, so viewer selection never looks there.
	 */
	private async viewer(own: RexContext): Promise<{ client: string } | NoViewer> {
		let apps: Json[];
		try {
			const attached = object(JSON.parse(await this.run(own, ["client", "ls", "-s", own.session, "--json"]))).clients;
			if (!Array.isArray(attached)) throw new Error("invalid Rex client list");
			apps = attached.map(object).filter((entry) => {
				// `info` is optional: a client that said nothing is not an app.
				const info = entry.info;
				if (!info || typeof info !== "object" || Array.isArray(info)) return false;
				if ((info as Json).kind !== "app") return false;
				// Rex lists a lost client for up to 60 seconds; a missing state counts as connected.
				return entry.connection_state !== "lost";
			});
		} catch (cause) {
			return {
				text: `could not ask Rex which apps show this session: ${String(cause)}`,
				brief: "Rex did not answer",
				cause,
			};
		}
		if (apps.length === 0)
			return {
				text: `no Rex app is attached to session ${own.session}, so nothing can show the window; open that session in Rex`,
				brief: "no Rex app attached",
			};
		if (apps.length !== 1)
			return {
				text: `several Rex apps are attached to session ${own.session}; select the delegate in the intended app yourself`,
				brief: "ambiguous Rex app",
			};
		if (!text(apps[0].client_id)) throw new Error("Rex app lacks client identity");
		return { client: apps[0].client_id };
	}
	async show(target: WindowTarget, verify: () => Promise<boolean>): Promise<ShowResult> {
		const own = this.caller();
		if (!own) return { text: this.refusal, brief: "no Rex terminal context" };
		const viewer = await this.viewer(own);
		if ("text" in viewer) return viewer;
		const origin = await this.observeLivePane().catch(() => undefined);
		if (!(await verify())) return { shown: false };
		const locator = await this.verifiedTarget(target.locator);
		if (!locator) throw new Error("no verified open window for this delegation; window changed or unavailable");
		const block = await this.blockIn(own, locator);
		if (!block?.window_id) throw new Error("the Rex block is no longer in a window");
		// Rex's session.focus_block changes server state, not the app's displayed
		// tab. Use the app's session.select action (rex -C CLIENT actions --json,
		// preview.20), then focus the exact block. Select first so a denied Remote
		// Control request cannot leave keyboard actions targeting an invisible tab.
		await this.run(own, [
			"-C",
			viewer.client,
			"do",
			"session.select",
			`session_id=${locator.session}`,
			`window_id=${block.window_id}`,
		]);
		const current = await this.blockIn(own, locator);
		if (current?.window_id !== block.window_id)
			throw new Error("Rex showed the window, but the delegate block moved or closed; retry navigation");
		await this.run(own, ["focus", "-s", locator.session, locator.block]);
		return {
			shown: true,
			// "Previous window" alone is ambiguous when the delegate is in another session.
			returnHint: origin
				? `select window ${origin.name} in Rex session ${origin.session} to return`
				: `select your previous window in Rex session ${own.session} to return`,
		};
	}
	async peek(target: WindowTarget): Promise<string> {
		const own = this.caller();
		const locator = await this.verifiedTarget(target.locator);
		if (!locator || !own) throw new Error("no verified open window for this delegation; window changed or unavailable");
		const screen = await this.run(own, ["capture", "-s", locator.session, "-b", locator.block, "--trim"]);
		return screen.split("\n").slice(-PEEK_LINES).join("\n");
	}
}

export function createRexClient(options: RexOptions = {}): DelegateHost {
	return new RexClient(options);
}

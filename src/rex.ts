// Rex 0.1.0-preview.20, API revision 16 (rex --help, rex api describe and live
// probes of that version). A window's terminal runs the staged launcher
// directly (--shell=none), so no text is ever typed into a shell. Rex closes
// the terminal when its program exits and keeps it only after a start that
// fails at once; terminal state is never task state.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DelegateHost,
	type OpenedWindow,
	type ShowResult,
	type StartKind,
	WindowOpenError,
	type WindowSpec,
	type WindowTarget,
} from "./host.ts";
import type { VerifiedLiveWindow, WindowRecord } from "./locator-rules.ts";
import { type RexLocator, type RexPaneLocator, rexLocator, rexLocators, rexPaneLocator } from "./rex-locator.ts";
import type { ClosableStates, WindowLook } from "./window-state.ts";

/** The lowest API revision these commands and reply fields were verified on. */
const API_REVISION = 16;
/** The rows a peek keeps; `rex capture` has no tail option and returns the whole scrollback. */
const PEEK_LINES = 500;

type Json = Record<string, unknown>;
type Block = { block_id: string; window_id?: string };
/** Which Rex server a call reaches: the endpoint Rex put in the terminal's REX_SERVER. */
export type RexRoute = { server: string };
export type RexRun = (route: RexRoute, args: string[]) => Promise<string>;
export type RexContext = RexRoute & { session: string; block: string };

function object(value: unknown): Json {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Rex response");
	return value as Json;
}
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const routing = (key: string): boolean => /^(?:TMUX|HERDR|REX_)/.test(key);
const launchIdentity = (key: string): boolean => key.startsWith("PI_DELEGATE_") || key === "PI_SQUIRE_LIVE_LAUNCH";

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

type LaunchStatus = { pid: number; child?: number; exit?: number };
function launchStatus(locator: RexLocator): LaunchStatus | undefined {
	try {
		const value = object(JSON.parse(readFileSync(`${locator.launchFile}.status`, "utf8")));
		if (
			!Number.isSafeInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			(value.exit !== undefined &&
				(!Number.isSafeInteger(value.exit) || (value.exit as number) < 0 || (value.exit as number) > 255))
		)
			throw new Error("invalid launch status");
		return value as LaunchStatus;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
/**
 * The parent's environment without any multiplexer's routing or this
 * coordinator's delegation identity, then the launch's own additions. Rex
 * gives the new terminal its own REX_* values, which the runner keeps.
 */
export function launchEnvironment(
	spec: Pick<WindowSpec, "env">,
	parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const kept = (
		source: Readonly<Record<string, string | undefined>>,
		drop: (key: string) => boolean,
	): [string, string][] =>
		Object.entries(source).filter(
			(entry): entry is [string, string] => !routing(entry[0]) && !drop(entry[0]) && entry[1] !== undefined,
		);
	return Object.fromEntries([...kept(parent, launchIdentity), ...kept(spec.env, () => false)]);
}
/** Stage argv/env in an owner-only file: Rex starts node on it directly, with no shell line. */
function stage(spec: WindowSpec): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-squire-rex-")), "launch.mjs");
	const data = JSON.stringify({ argv: spec.argv, env: launchEnvironment(spec), cwd: spec.cwd });
	writeFileSync(
		path,
		`import {spawn} from 'node:child_process';
import {writeFileSync,renameSync} from 'node:fs';
const spec = ${data};
const statusFile = ${JSON.stringify(`${path}.status`)};
const status = {pid:process.pid};
function publish(){writeFileSync(statusFile+'.next',JSON.stringify(status),{mode:0o600});renameSync(statusFile+'.next',statusFile);}
const env = {...process.env};
for(const key of Object.keys(env)) if(key.startsWith('TMUX') || key.startsWith('HERDR') || key.startsWith('PI_DELEGATE_') || key==='PI_SQUIRE_LIVE_LAUNCH') delete env[key];
Object.assign(env,spec.env);
publish();
const child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env,stdio:'inherit'});
status.child=child.pid;publish();
function finish(code){status.exit=code;publish();process.exitCode=code;if(code!==0) console.error('pi-squire: delegate exited with status '+code);}
child.on('error',(error)=>{console.error('pi-squire: failed to start delegate: '+error.message);finish(1);});
child.on('exit',(code,signal)=>{if(signal) console.error('pi-squire: delegate terminated by '+signal);finish(code??1);});
`,
		{ mode: 0o600 },
	);
	return path;
}

type RexOptions = { run?: RexRun; context?: () => RexContext | undefined; timeoutMs?: number };
class RexClient implements DelegateHost {
	readonly id = "rex";
	readonly windowNoun = "window";
	readonly usesWindowPlacement = false;
	readonly requiresSessionGuard = rexLocators.requiresSessionGuard;
	readonly windowListRefusal = "could not ask Rex for its delegate windows";
	readonly refusal =
		"this session is not inside a Rex terminal (needs REX_SERVER, REX_SESSION and REX_BLOCK); start Pi in Rex to open a delegate window (multiplexer: rex)";
	readonly run: RexRun;
	readonly caller: () => RexContext | undefined;
	constructor(options: RexOptions) {
		this.run = options.run ?? runRex(options.timeoutMs ?? 10_000);
		this.caller = options.context ?? context;
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
			// Delegates open in the session this Pi's terminal belongs to.
			if (!(await this.snapshot(own)).some((block) => block.block_id === own.block))
				return `this Pi's Rex block ${own.block} is no longer in session ${own.session}; delegates open only in the session Pi started in, so launch refused. Restart Pi in the Rex session you want`;
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
	/** Every block of the caller's session, detached ones included. */
	async snapshot(own: RexContext): Promise<Block[]> {
		const listed = object(JSON.parse(await this.run(own, ["block", "ls", "-s", own.session, "--json"]))).blocks;
		// Rex reports a session without blocks as null.
		const blocks = (listed === null ? [] : listed) as unknown;
		if (!Array.isArray(blocks)) throw new Error("invalid Rex block list");
		const found = blocks.map((item): Block => {
			const block = object(item);
			if (!text(block.block_id)) throw new Error("Rex block list lacks block identity");
			return { block_id: block.block_id, ...(text(block.window_id) ? { window_id: block.window_id } : {}) };
		});
		if (new Set(found.map((block) => block.block_id)).size !== found.length)
			throw new Error("ambiguous Rex block list");
		return found;
	}
	/** A locator this Pi can act on: same server and session as its own terminal. */
	private reachable<T extends RexLocator | RexPaneLocator>(
		locator: T | undefined,
		own: RexContext | undefined,
	): T | undefined {
		return locator && own && locator.server === own.server && locator.session === own.session ? locator : undefined;
	}
	async states(): Promise<ClosableStates> {
		const own = this.caller();
		let blocks: Block[] | undefined;
		try {
			if (own) blocks = await this.snapshot(own);
		} catch {
			/* unavailable is unknown, never gone */
		}
		const locate = (record: WindowRecord): RexLocator | undefined => this.reachable(rexLocator(record.locator), own);
		const listed = (record: WindowRecord): boolean => {
			const locator = locate(record) ?? this.reachable(rexPaneLocator(record.locator), own);
			return !!locator && !!blocks?.some((block) => block.block_id === locator.block);
		};
		const look = (record: WindowRecord): WindowLook => {
			const locator = locate(record);
			if (!locator || !blocks) return { state: "unknown" };
			if (!listed(record)) return { state: "gone" };
			try {
				// A retained terminal whose runner published an exit is no longer running.
				return { state: launchStatus(locator)?.exit === undefined ? "running" : "gone", session: locator.session };
			} catch {
				return { state: "unknown" };
			}
		};
		return {
			answered: blocks !== undefined,
			look,
			state: (record: WindowRecord): WindowLook["state"] => look(record).state,
			listed,
			close: async (record: WindowRecord): Promise<boolean> => {
				const locator = locate(record);
				if (!locator || !blocks || !own) throw new Error("could not verify Rex block identity; no block was closed");
				if (!listed(record)) return false;
				// Fresh observation immediately before close. Close only the owned
				// block, never its window, which may now hold blocks the user added.
				const present = async (): Promise<boolean> =>
					(await this.snapshot(own)).some((block) => block.block_id === locator.block);
				if (!(await present())) return false;
				try {
					await this.run(own, ["block", "close", "-s", locator.session, locator.block]);
				} catch (error) {
					// The program may have exited between the observation and the close.
					if (await present()) throw error;
					return false;
				}
				return true;
			},
		};
	}

	async openWindow(spec: WindowSpec): Promise<OpenedWindow> {
		const problem = await this.available();
		if (problem) throw new WindowOpenError(problem, "not-opened");
		const own = this.caller();
		if (!own) throw new WindowOpenError(this.refusal, "not-opened");
		// The label is a positional argument; one starting with "-" would read as an option.
		if (spec.name.startsWith("-"))
			throw new WindowOpenError(`Rex cannot label a window ${JSON.stringify(spec.name)}`, "not-opened");
		let launchFile: string;
		try {
			launchFile = stage(spec);
		} catch (error) {
			throw new WindowOpenError(String(error), "not-opened");
		}
		try {
			const created = object(
				JSON.parse(
					await this.run(own, [
						"window",
						"new",
						"-s",
						own.session,
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
			const ids = created.block_ids;
			if (!text(created.window_id) || !Array.isArray(ids) || ids.length !== 1 || !text(ids[0]))
				throw new Error("Rex create response has inconsistent identity");
			const locator: RexLocator = {
				adapter: "rex",
				version: 1,
				kind: "window",
				server: own.server,
				session: own.session,
				window: created.window_id,
				block: ids[0],
				name: spec.name,
				launchFile,
			};
			return {
				id: locator.window,
				session: locator.session,
				locator,
				location: `window ${spec.name} (${locator.window}) in Rex session ${locator.session}`,
			};
		} catch (error) {
			// A lost or malformed reply does not say whether Rex created the window.
			throw new WindowOpenError(String(error), "unknown");
		}
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
	/** The caller's window id and label, read from the session's view. */
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
	async verifiedTarget(value: unknown): Promise<RexLocator | RexPaneLocator | undefined> {
		const own = this.caller();
		const locator = this.reachable(rexLocator(value) ?? rexPaneLocator(value), own);
		if (!locator || !own) return undefined;
		return (await this.snapshot(own)).some((block) => block.block_id === locator.block) ? locator : undefined;
	}
	async verifyLivePane(value: object): Promise<VerifiedLiveWindow | undefined> {
		if (!rexPaneLocator(value)) return undefined;
		const locator = await this.verifiedTarget(value);
		return locator ? { locator, paneTarget: locator.block } : undefined;
	}
	async show(target: WindowTarget, verify: () => Promise<boolean>): Promise<ShowResult> {
		const own = this.caller();
		if (!own) return { text: this.refusal, brief: "no Rex terminal context" };
		try {
			const attached = object(JSON.parse(await this.run(own, ["client", "ls", "-s", own.session, "--json"]))).clients;
			if (!Array.isArray(attached) || attached.length === 0)
				return {
					text: `no Rex app is attached to session ${own.session}, so nothing can show the window; open that session in Rex`,
					brief: "no Rex app attached",
				};
		} catch (cause) {
			return {
				text: `could not ask Rex which apps show this session: ${String(cause)}`,
				brief: "Rex did not answer",
				cause,
			};
		}
		const origin = await this.observeLivePane().catch(() => undefined);
		if (!(await verify())) return { shown: false };
		const locator = await this.verifiedTarget(target.locator);
		if (!locator) throw new Error("no verified open window for this delegation; window changed or unavailable");
		// Focusing the block makes its window the session's active one, wherever the block now sits.
		await this.run(own, ["focus", "-s", locator.session, locator.block]);
		return {
			shown: true,
			returnHint: `select ${origin ? `window ${origin.name}` : "your previous window"} in Rex to return`,
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

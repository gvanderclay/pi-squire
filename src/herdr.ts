// Herdr 0.9.5 / protocol 22. pane run admits a short staged command even
// while shell startup is busy (verified ticket01); agent state is not task state.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HerdrLocator, type HerdrPaneLocator, herdrLocator, herdrPaneLocator } from "./herdr-locator.ts";
import { assertSessionFree, type HostTab, snapshotTabs } from "./herdr-restore.ts";
import {
	type DelegateHost,
	type OpenedWindow,
	type ShowResult,
	WindowOpenError,
	type WindowRecord,
	type WindowSpec,
	type WindowTarget,
} from "./tmux.ts";
import type { ClosableStates, WindowLook } from "./window-state.ts";

type Json = Record<string, unknown>;
type Pane = {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	terminal_id: string;
	agent?: string | null;
	agent_session?: { value?: string } | null;
};
/**
 * Which Herdr server a call reaches. `session` null is Herdr's default
 * session: its panes have no HERDR_SESSION and `status server --json` reports
 * `"session": null` (verified on Herdr 0.9.5). Herdr has no name for it to pass
 * as `--session`, so it is reached through its socket path instead.
 */
export type HerdrRoute = { session: string | null; socket: string };
export type HerdrRun = (route: HerdrRoute, args: string[]) => Promise<string>;
export type HerdrContext = HerdrRoute & { workspace: string; pane: string };

function object(value: unknown): Json {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid Herdr response");
	return value as Json;
}
function pane(value: unknown): Pane {
	const own = object(value);
	if (![own.pane_id, own.tab_id, own.workspace_id, own.terminal_id].every((v) => typeof v === "string" && v.length > 0))
		throw new Error("Herdr response lacks terminal identity");
	return own as Pane;
}
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const routing = (key: string): boolean => /^(?:TMUX|HERDR)/.test(key);
export function childEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => !routing(entry[0]) && entry[1] !== undefined),
	);
}
function context(): HerdrContext | undefined {
	const { HERDR_ENV, HERDR_SESSION, HERDR_WORKSPACE_ID, HERDR_PANE_ID, HERDR_SOCKET_PATH } = process.env;
	// A pane of Herdr's default session has no (or an empty) HERDR_SESSION.
	return HERDR_ENV === "1" && HERDR_WORKSPACE_ID && HERDR_PANE_ID && HERDR_SOCKET_PATH
		? { session: HERDR_SESSION || null, workspace: HERDR_WORKSPACE_ID, pane: HERDR_PANE_ID, socket: HERDR_SOCKET_PATH }
		: undefined;
}
/**
 * The herdr argv and environment that reach exactly this route. A named
 * session keeps `--session <name>`. The default session has no name, so the
 * call omits `--session`, drops HERDR_SESSION (Herdr honours it, and rejects an
 * empty one) and pins HERDR_SOCKET_PATH, which Herdr 0.9.5 uses as the server
 * socket when no session is named; `status server --json` then reports that
 * socket with `"session": null`, which every identity check compares.
 */
export function herdrInvocation(
	route: HerdrRoute,
	args: string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): { argv: string[]; env: Record<string, string | undefined> } {
	if (route.session !== null) return { argv: ["--session", route.session, ...args], env: { ...env } };
	const { HERDR_SESSION: _named, ...rest } = env;
	return { argv: args, env: { ...rest, HERDR_SOCKET_PATH: route.socket } };
}
function runHerdr(timeout: number): HerdrRun {
	return (route: HerdrRoute, args: string[]) =>
		new Promise((resolve, reject) => {
			const call = herdrInvocation(route, args);
			execFile(
				"herdr",
				call.argv,
				{ encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, env: call.env },
				(error, out, err) => {
					if (error) {
						reject(
							new Error(
								`herdr ${args.slice(0, 2).join(" ")} failed: ${error.killed ? "timed out" : err.trim() || error.message}`,
							),
						);
					} else resolve(out);
				},
			);
		});
}
function result(text: string): Json {
	const response = object(JSON.parse(text));
	if (response.error) throw new Error(`Herdr refused: ${JSON.stringify(response.error)}`);
	return object(response.result);
}

type LaunchStatus = { pid: number; child?: number; exit?: number };
function launchStatus(locator: HerdrLocator): LaunchStatus | undefined {
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
/** Stage argv/env, not shell text. The shell only sees one short, safely quoted path. */
function launchEnvironment(spec: WindowSpec): Record<string, string> {
	const parent = childEnvironment(process.env);
	// Delegation identity/fallback belongs to this launch, not its coordinator.
	for (const key of Object.keys(parent))
		if (key.startsWith("PI_DELEGATE_") || key === "PI_SQUIRE_LIVE_LAUNCH") delete parent[key];
	return { ...parent, ...childEnvironment(spec.env) };
}
function tabEnvArgs(spec: WindowSpec): string[] {
	let bytes = 0;
	// Large values travel in the private staged file, not the CLI argv. The
	// same complete environment is applied to Pi by the runner after shell startup.
	return Object.entries(launchEnvironment(spec)).flatMap(([key, value]) => {
		bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 1;
		return bytes <= 32_768 ? ["--env", `${key}=${value}`] : [];
	});
}
function stage(spec: WindowSpec): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-squire-herdr-")), "launch.mjs");
	const data = JSON.stringify({
		argv: spec.argv,
		env: launchEnvironment(spec),
		cwd: spec.cwd,
	});
	writeFileSync(
		path,
		`import {spawn} from 'node:child_process';
import {writeFileSync,renameSync} from 'node:fs';
const spec = ${data};
const statusFile = ${JSON.stringify(`${path}.status`)};
const status = {pid:process.pid};
function publish(){writeFileSync(statusFile+'.next',JSON.stringify(status),{mode:0o600});renameSync(statusFile+'.next',statusFile);}
const env = {...process.env};
for(const key of Object.keys(env)) if(key.startsWith('TMUX') || key.startsWith('PI_DELEGATE_') || key==='PI_SQUIRE_LIVE_LAUNCH') delete env[key];
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

function verifyForeground(info: Json, locator: HerdrLocator): void {
	if (
		!Array.isArray(info.foreground_processes) ||
		!info.foreground_processes.length ||
		!Number.isSafeInteger(info.shell_pid) ||
		(info.shell_pid as number) <= 0 ||
		info.pane_id !== locator.pane
	)
		throw new Error("Herdr foreground identity unavailable; close refused");
	const status = launchStatus(locator);
	const processes = info.foreground_processes.map(object);
	if (processes.every((p) => p.pid === info.shell_pid)) return;
	if (
		status &&
		processes.some((p) => p.pid === status.pid && Array.isArray(p.argv) && p.argv.includes(locator.launchFile))
	)
		return;
	throw new Error("Herdr pane has another foreground process; close refused");
}

type HerdrOptions = { run?: HerdrRun; context?: () => HerdrContext | undefined; timeoutMs?: number };
class HerdrClient implements DelegateHost {
	readonly id = "herdr";
	ownsLocator(value: unknown): boolean {
		return !!herdrLocator(value) || !!herdrPaneLocator(value);
	}
	readonly windowNoun = "tab";
	readonly usesWindowPlacement = false;
	readonly requiresSessionGuard = true;
	readonly windowListRefusal = "could not ask Herdr for its delegate tabs";
	readonly refusal =
		"this session is not inside a Herdr pane (needs HERDR_ENV=1, HERDR_WORKSPACE_ID, HERDR_PANE_ID and HERDR_SOCKET_PATH); start Pi in Herdr to open a delegate tab (multiplexer: herdr)";
	readonly run: HerdrRun;
	readonly caller: () => HerdrContext | undefined;
	constructor(options: HerdrOptions) {
		this.run = options.run ?? runHerdr(options.timeoutMs ?? 10_000);
		this.caller = options.context ?? context;
	}
	async available(): Promise<string | undefined> {
		const own = this.caller();
		if (!own) return this.refusal;
		try {
			const status = object(JSON.parse(await this.run(own, ["status", "server", "--json"])));
			if (
				status.running !== true ||
				status.compatible !== true ||
				status.endpoint_compatible !== true ||
				status.protocol !== 22
			)
				return "Herdr delegation needs a running, compatible protocol 22 server (verified with Herdr 0.9.5); no tmux fallback was attempted";
			if (status.socket !== own.socket || status.session !== own.session)
				return "Herdr session/socket identity changed; launch refused";
			const parent = pane(result(await this.run(own, ["pane", "get", own.pane])).pane);
			// Delegates open flat in the workspace this Pi started in (its root's,
			// for a nested delegate). A pane moved since then has stale HERDR_*
			// context, so refuse rather than guess which workspace is meant.
			if (parent.workspace_id !== own.workspace)
				return `this Pi's Herdr pane ${own.pane} moved from workspace ${own.workspace} to ${parent.workspace_id} since it started; delegates open only in the workspace Pi started in, so launch refused. Move the pane back, or start Pi in the workspace you want`;
			return undefined;
		} catch (error) {
			return `could not ask Herdr for the parent pane/server: ${String(error)}; no tmux fallback was attempted`;
		}
	}
	unavailable(): string | undefined;
	unavailable(check: true): Promise<string | undefined>;
	unavailable(check?: true): string | undefined | Promise<string | undefined> {
		if (check) return this.available();
		return this.caller() ? undefined : this.refusal;
	}
	same(own: HerdrLocator | HerdrPaneLocator, live: Pane): boolean {
		return (
			own.pane === live.pane_id &&
			own.tab === live.tab_id &&
			own.workspace === live.workspace_id &&
			own.terminal === live.terminal_id
		);
	}
	async snapshot(own: HerdrContext): Promise<Pane[]> {
		return (await this.inventory(own)).panes;
	}
	async inventory(own: HerdrContext): Promise<{ panes: Pane[]; tabs: HostTab[] }> {
		const server = object(JSON.parse(await this.run(own, ["status", "server", "--json"])));
		if (
			server.running !== true ||
			server.socket !== own.socket ||
			server.session !== own.session ||
			server.compatible !== true ||
			server.endpoint_compatible !== true ||
			server.protocol !== 22
		)
			throw new Error("Herdr server identity unavailable");
		const snap = object(result(await this.run(own, ["api", "snapshot"])).snapshot);
		if (!Array.isArray(snap.panes) || snap.protocol !== 22) throw new Error("invalid Herdr pane snapshot");
		const panes = snap.panes.map(pane);
		if (new Set(panes.map((p) => p.pane_id)).size !== panes.length) throw new Error("ambiguous Herdr pane snapshot");
		return { panes, tabs: snapshotTabs(snap.tabs) };
	}
	/** Refuse a resume when a Herdr tab already runs the session, or that is unknown; read-only. */
	guardSession(record: WindowRecord, session: { path: string; id: string }): Promise<void> {
		const own = this.caller();
		return assertSessionFree(
			{
				own,
				inventory: (): Promise<{ panes: Pane[]; tabs: HostTab[] }> =>
					own ? this.inventory(own) : Promise.reject(new Error("no Herdr context")),
				shellOnly: async (target: string): Promise<boolean> => {
					if (!own) return false;
					const info = object(result(await this.run(own, ["pane", "process-info", "--pane", target])).process_info);
					// Positive proof only: an empty, partial or other pane's answer is not "just a shell".
					const shell = info.shell_pid;
					const processes = info.foreground_processes;
					return (
						info.pane_id === target &&
						Number.isSafeInteger(shell) &&
						(shell as number) > 0 &&
						Array.isArray(processes) &&
						processes.length > 0 &&
						processes.every((p) => object(p).pid === shell)
					);
				},
				same: (locator: HerdrLocator, live: Pane): boolean => this.same(locator, live),
			},
			record,
			session,
		);
	}
	async states(): Promise<ClosableStates> {
		const own = this.caller();
		let panes: Pane[] | undefined;
		try {
			if (own) panes = await this.snapshot(own);
		} catch {
			/* unavailable is unknown, never gone */
		}
		const locate = (record: WindowRecord): HerdrLocator | undefined => {
			const locator = herdrLocator(record.locator);
			return locator && own && locator.session === own.session && locator.socket === own.socket ? locator : undefined;
		};
		/** A terminal Herdr now reports under other ids (pane move): still alive, never gone. */
		const moved = (record: WindowRecord): boolean => {
			const locator = locate(record);
			return !!locator && !!panes?.some((p) => p.terminal_id === locator.terminal && !this.same(locator, p));
		};
		const listed = (record: WindowRecord): boolean => {
			const locator = locate(record) ?? herdrPaneLocator(record.locator);
			return (
				!!locator &&
				!!own &&
				locator.session === own.session &&
				locator.socket === own.socket &&
				!!panes?.some((p) => this.same(locator, p))
			);
		};
		const look = (record: WindowRecord): WindowLook => {
			const locator = locate(record);
			if (!locator || !panes) return { state: "unknown" };
			if (!listed(record)) return { state: moved(record) ? "unknown" : "gone" };
			try {
				return { state: launchStatus(locator)?.exit === undefined ? "running" : "gone", session: locator.workspace };
			} catch {
				return { state: "unknown" };
			}
		};
		return {
			answered: panes !== undefined,
			look,
			state: (record: WindowRecord): WindowLook["state"] => look(record).state,
			listed,
			close: async (record: WindowRecord): Promise<boolean> => {
				const locator = locate(record);
				if (!locator || !panes || !own) throw new Error("could not verify Herdr terminal identity; no pane was closed");
				if (moved(record))
					throw new Error(
						"Herdr reports this delegate's terminal under another pane or tab (moved); no pane was closed",
					);
				if (!listed(record)) return false;
				// Fresh observation immediately before close. Herdr has no atomic
				// compare-and-close API (ticket01 research); close only the owned pane,
				// never its whole tab, which may now contain user-added panes.
				const fresh = await this.snapshot(own);
				if (!fresh.some((p) => this.same(locator, p))) return false;
				const info = object(
					result(await this.run(locator, ["pane", "process-info", "--pane", locator.pane])).process_info,
				);
				if (!Array.isArray(info.foreground_processes))
					throw new Error("Herdr foreground identity unavailable; close refused");
				verifyForeground(info, locator);
				const last = pane(result(await this.run(locator, ["pane", "get", locator.pane])).pane);
				if (!this.same(locator, last)) return false;
				await this.run(locator, ["pane", "close", locator.pane]);
				return true;
			},
		};
	}

	async label(locator: HerdrLocator): Promise<void> {
		// Presentation only: metadata failure must not become launch/task state.
		// Never report-agent, hide delegates, or replace Herdr's agent list.
		try {
			await this.run(locator, [
				"pane",
				"report-metadata",
				locator.pane,
				"--source",
				"pi-squire",
				"--display-agent",
				locator.name,
			]);
		} catch {
			/* best-effort sidebar label, never lifecycle authority */
		}
		const ready = pane(result(await this.run(locator, ["pane", "get", locator.pane])).pane);
		if (!this.same(locator, ready)) throw new Error("Herdr terminal changed before launch");
	}

	async openWindow(spec: WindowSpec): Promise<OpenedWindow> {
		const problem = await this.available();
		if (problem) throw new WindowOpenError(problem, "not-opened");
		const own = this.caller();
		if (!own) throw new WindowOpenError(this.refusal, "not-opened");
		let launchFile: string;
		try {
			launchFile = stage(spec);
		} catch (error) {
			throw new WindowOpenError(String(error), "not-opened");
		}
		try {
			const created = result(
				await this.run(own, [
					"tab",
					"create",
					"--workspace",
					own.workspace,
					"--cwd",
					spec.cwd,
					"--label",
					spec.name,
					"--no-focus",
					...tabEnvArgs(spec),
				]),
			);
			const root = pane(created.root_pane);
			const tab = object(created.tab);
			if (root.workspace_id !== own.workspace || root.tab_id !== tab.tab_id || tab.label !== spec.name)
				throw new Error("Herdr create response has inconsistent identity");
			const locator: HerdrLocator = {
				adapter: "herdr",
				version: 1,
				kind: "window",
				...own,
				tab: root.tab_id,
				pane: root.pane_id,
				terminal: root.terminal_id,
				name: spec.name,
				launchFile,
			};
			// Verify the exact terminal before typing; never retry an ambiguous create/run.
			const live = pane(result(await this.run(own, ["pane", "get", locator.pane])).pane);
			if (!this.same(locator, live)) throw new Error("Herdr terminal changed before launch");
			await this.label(locator);
			await this.run(own, [
				"pane",
				"run",
				locator.pane,
				// ticket01 verified this form on Herdr 0.9.5: exit only this pane's
				// interactive shell on success, even if focused. No tab close (a user
				// may have added panes); on error retain the shell and readable output.
				`sh -c ${quote(`${quote(process.execPath)} ${quote(launchFile)}`)} && exit`,
			]);
			return {
				id: locator.tab,
				session: locator.workspace,
				locator,
				location: `tab ${spec.name} (${locator.tab}) in workspace ${locator.workspace}`,
			};
		} catch (error) {
			throw new WindowOpenError(String(error), "unknown");
		}
	}
	async observeLivePane(): Promise<HerdrPaneLocator | undefined> {
		const own = this.caller();
		if (!own) return undefined;
		const live = (await this.snapshot(own)).find((p) => p.pane_id === own.pane);
		if (!live || live.workspace_id !== own.workspace) return undefined;
		return {
			adapter: "herdr",
			version: 1,
			kind: "pane",
			...own,
			tab: live.tab_id,
			terminal: live.terminal_id,
			name: live.tab_id,
		};
	}
	async verifiedTarget(value: unknown): Promise<HerdrLocator | HerdrPaneLocator | undefined> {
		const locator = herdrLocator(value) ?? herdrPaneLocator(value);
		const own = this.caller();
		if (!locator || !own || locator.session !== own.session || locator.socket !== own.socket) return undefined;
		if (!(await this.snapshot(own)).some((p) => this.same(locator, p))) return undefined;
		// Recheck exact terminal immediately before the caller's explicit action.
		const last = pane(result(await this.run(own, ["pane", "get", locator.pane])).pane);
		return this.same(locator, last) ? locator : undefined;
	}
	async verifyLivePane(value: object): Promise<import("./tmux.ts").VerifiedLiveWindow | undefined> {
		if (!herdrPaneLocator(value)) return undefined;
		const locator = await this.verifiedTarget(value);
		return locator ? { locator, paneTarget: locator.pane } : undefined;
	}
	async show(target: WindowTarget, verify: () => Promise<boolean>): Promise<ShowResult> {
		const own = this.caller();
		if (!own) return { text: this.refusal, brief: "no Herdr pane context" };
		const origin = await this.observeLivePane();
		if (!(await verify())) return { shown: false };
		const locator = await this.verifiedTarget(target.locator);
		if (!locator) throw new Error("no verified open tab for this delegation; tab changed or unavailable");
		await this.run(own, ["tab", "focus", locator.tab]);
		return {
			shown: true,
			returnHint: `select ${origin ? `tab ${origin.tab}` : "your previous tab"} in Herdr's tab bar to return`,
		};
	}
	async peek(target: WindowTarget): Promise<string> {
		const locator = await this.verifiedTarget(target.locator);
		if (!locator) throw new Error("no verified open tab for this delegation; tab changed or unavailable");
		return this.run(locator, ["pane", "read", locator.pane, "--source", "recent"]);
	}
}

export function createHerdrClient(options: HerdrOptions = {}): DelegateHost {
	return new HerdrClient(options);
}

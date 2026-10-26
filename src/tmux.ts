// The tmux operations `delegate` needs, behind an interface so tests can use a
// fake. This client talks to tmux with `execFile` and no shell.
import { execFile } from "node:child_process";

import type { WindowPlacement } from "./window-placement.ts";

/** One window to open: its name, working directory, command and environment. */
export type WindowSpec = {
	name: string;
	cwd: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
};

/** One window as tmux lists it: its id, its session's name, its name, and whether the program in its pane has exited. */
export type TmuxWindow = { id: string; session: string; name: string; exited: boolean };

/** A window just opened: its id and the name of the session it is in, when known. */
export type OpenedWindow = { id: string; session: string | undefined };

/** The oldest tmux delegate windows need: `new-session -e` and `display-popup` arrived in 3.2. */
export const MIN_TMUX = { major: 3, minor: 2 } as const;

export type TmuxVersion = { text: string; major: number; minor: number };

/** Parse `tmux -V` output such as `tmux 3.7b` or `tmux next-3.4`; a build with no number (`tmux master`) counts as current. */
export function parseTmuxVersion(output: string): TmuxVersion {
	const text = output.trim();
	const match = /(\d+)\.(\d+)/.exec(text);
	if (match === null) return { text, major: Number.POSITIVE_INFINITY, minor: 0 };
	return { text, major: Number(match[1]), minor: Number(match[2]) };
}

/** Refuse a tmux older than `MIN_TMUX`, naming the version found. */
export async function requireTmuxVersion(tmux: { version(): Promise<TmuxVersion> }): Promise<void> {
	const found = await tmux.version();
	if (found.major < MIN_TMUX.major || (found.major === MIN_TMUX.major && found.minor < MIN_TMUX.minor)) {
		throw new Error(`delegate windows need tmux ${MIN_TMUX.major}.${MIN_TMUX.minor} or later; this is ${found.text}`);
	}
}

/**
 * The companion session for a parent in `parentSession`: its own when that is
 * a companion session (marked by pi-squire when it made it), else the name
 * plus `-squire`. The name alone says nothing: a user's session may end in it.
 */
export function companionName(parentSession: string, isCompanion: boolean): string {
	return isCompanion ? parentSession : `${parentSession}-squire`;
}

/**
 * Why a window could not be opened, and whether one may exist anyway:
 * `not-opened` only when nothing was dispatched to tmux that could create it.
 * Anything else, a timeout or a malformed answer included, is `unknown`.
 */
export class WindowOpenError extends Error {
	certainty: "not-opened" | "unknown";
	constructor(message: string, certainty: "not-opened" | "unknown") {
		super(message);
		this.name = "WindowOpenError";
		this.certainty = certainty;
	}
}

export interface TmuxClient {
	/** Whether this process runs in a tmux pane. */
	insideTmux(): boolean;
	/** The tmux version, asked once. */
	version(): Promise<TmuxVersion>;
	/**
	 * Open a detached window and return its id (for example `@3`) and session.
	 * `current` opens it in the parent's session; `companion` in
	 * `<parent's session>-squire`, created when it does not exist.
	 */
	openWindow(spec: WindowSpec, placement: WindowPlacement): Promise<OpenedWindow>;
	/** Every window on the server, in one tmux call. */
	listWindows(): Promise<TmuxWindow[]>;
	/** Kill a window. */
	kill(windowId: string): Promise<void>;
}

/** Run one tmux command and return its stdout; never a shell. */
function runTmux(args: string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { encoding: "utf8", timeout }, (error, stdout, stderr) => {
			if (error) {
				if (error.killed) {
					reject(new Error(`tmux ${args[0]} timed out after ${timeout / 1000} s`));
					return;
				}
				const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : error.message;
				reject(new Error(detail));
				return;
			}
			resolve(stdout);
		});
	});
}

type Run = (args: string[]) => Promise<string>;
type Parent = { id: string; name: string; companion: boolean };

/** The user option that marks a session pi-squire made for delegate windows. */
const COMPANION_OPTION = "@squire-companion";

/** The id, name and companion mark of the session the pane in `TMUX_PANE` belongs to, when known. */
async function parentSession(run: Run): Promise<Parent | undefined> {
	const pane = process.env.TMUX_PANE;
	if (pane === undefined || pane === "") return undefined;
	// Only the line's terminator goes: trailing spaces are legal in a session name.
	const format = `#{session_id}\t#{${COMPANION_OPTION}}\t#{session_name}`;
	const out = (await run(["display-message", "-p", "-t", pane, "-F", format])).replace(/\r?\n$/, "");
	// The name comes last, so it is whatever follows the second tab.
	const [id, marker, ...name] = out.split("\t");
	return id.trim() === "" ? undefined : { id: id.trim(), name: name.join("\t"), companion: marker === "1" };
}

const envArgs = (spec: WindowSpec): string[] =>
	Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);

/** Dispatch one create; after dispatch even an error or timeout may have left a window. */
async function create(run: Run, args: string[]): Promise<string> {
	let out: string;
	try {
		out = await run(args);
	} catch (err) {
		throw new WindowOpenError((err as Error).message, "unknown");
	}
	const windowId = out.trim();
	if (!/^@[0-9]+$/.test(windowId)) throw new WindowOpenError("tmux reported an invalid window id", "unknown");
	return windowId;
}

const failedWith = (err: unknown, text: string): boolean =>
	err instanceof WindowOpenError && err.message.includes(text);

/**
 * Open a window in the companion session: `new-window`, then on a missing
 * session one `new-session` that makes the delegate its first window and sets
 * `detach-on-destroy off` and the companion mark on that session only, then `new-window` again when
 * another launch created the session first.
 */
async function openCompanion(run: Run, spec: WindowSpec, session: string): Promise<string> {
	const newWindow = [
		"new-window",
		"-d",
		"-P",
		"-F",
		"#{window_id}",
		"-n",
		spec.name,
		"-c",
		spec.cwd,
		...envArgs(spec),
		"-t",
		`=${session}:`,
		"--",
		...spec.argv,
	];
	try {
		return await create(run, newWindow);
	} catch (err) {
		// tmux resolves the target before it creates anything, so nothing was dispatched that could create a window.
		if (!failedWith(err, "can't find session")) throw err;
		(err as WindowOpenError).certainty = "not-opened";
	}
	const newSession = ["new-session", "-d", "-s", session, "-n", spec.name, "-c", spec.cwd, ...envArgs(spec)];
	newSession.push("-P", "-F", "#{window_id}", "--", ...spec.argv);
	newSession.push(";", "set-option", "-t", `=${session}:`, "detach-on-destroy", "off");
	newSession.push(";", "set-option", "-t", `=${session}:`, COMPANION_OPTION, "1");
	try {
		return await create(run, newSession);
	} catch (err) {
		if (!failedWith(err, "duplicate session")) throw err;
	}
	return create(run, newWindow);
}

/** Open a window in the parent's own session, as delegates always did. */
function openCurrent(run: Run, spec: WindowSpec, parent: Parent | undefined): Promise<string> {
	const args = ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", spec.name, "-c", spec.cwd, ...envArgs(spec)];
	if (parent !== undefined) args.push("-t", parent.id);
	args.push("--", ...spec.argv);
	return create(run, args);
}

/**
 * The real client. A window is opened relative to the session of the pane in
 * `TMUX_PANE`, not whatever session a client happens to have attached, so it
 * works with several clients on one server.
 */
export function createTmuxClient(options: { timeoutMs?: number } = {}): TmuxClient {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const run: Run = (args) => runTmux(args, timeoutMs);
	let cachedVersion: Promise<TmuxVersion> | undefined;

	return {
		insideTmux: () => (process.env.TMUX ?? "") !== "",

		version() {
			// The in-flight ask is shared; a failed one is forgotten so the next call asks again.
			cachedVersion ??= run(["-V"]).then(parseTmuxVersion, (err: unknown) => {
				cachedVersion = undefined;
				throw err;
			});
			return cachedVersion;
		},

		async openWindow(spec, placement) {
			let parent: Parent | undefined;
			try {
				parent = await parentSession(run);
			} catch (err) {
				// The lookup only reads; no window can exist yet.
				throw new WindowOpenError((err as Error).message, "not-opened");
			}
			const known = parent === undefined || parent.name === "" ? undefined : parent.name;
			if (placement === "current") return { id: await openCurrent(run, spec, parent), session: known };
			if (known === undefined) {
				throw new WindowOpenError("could not tell which tmux session this pane is in (TMUX_PANE)", "not-opened");
			}
			const session = companionName(known, parent?.companion === true);
			return { id: await openCompanion(run, spec, session), session };
		},

		async listWindows() {
			// The window name goes last: it is the one field that could hold a tab.
			const format = "#{window_id}\t#{pane_dead}\t#{session_name}\t#{window_name}";
			const out = await run(["list-windows", "-a", "-F", format]);
			return out
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					const [id, dead, session, ...name] = line.split("\t");
					return { id, session, name: name.join("\t"), exited: dead === "1" };
				});
		},

		async kill(windowId) {
			await run(["kill-window", "-t", windowId]);
		},
	};
}

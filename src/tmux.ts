// The tmux operations `delegate` needs, behind an interface so tests can use a
// fake. This client talks to tmux with `execFile` and no shell.
import { execFile } from "node:child_process";

/** One window to open: its name, working directory, command and environment. */
export type WindowSpec = {
	name: string;
	cwd: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
};

/** One window as tmux lists it: its id, its name, and whether the program in its pane has exited. */
export type TmuxWindow = { id: string; name: string; exited: boolean };

export interface TmuxClient {
	/** Whether this process runs in a tmux pane. */
	insideTmux(): boolean;
	/** Open a detached window and return its id (for example `@3`). */
	openWindow(spec: WindowSpec): Promise<string>;
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

/**
 * The real client. A window is opened in the session of the pane in
 * `TMUX_PANE`, not in whatever session a client happens to have attached, so
 * it works with several clients on one server.
 */
export function createTmuxClient(options: { timeoutMs?: number } = {}): TmuxClient {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const run = (args: string[]) => runTmux(args, timeoutMs);

	/** The id of the session this pane belongs to, when known. */
	async function targetSession(): Promise<string | undefined> {
		const pane = process.env.TMUX_PANE;
		if (pane === undefined || pane === "") return undefined;
		const sessionId = (await run(["display-message", "-p", "-t", pane, "-F", "#{session_id}"])).trim();
		return sessionId === "" ? undefined : sessionId;
	}

	return {
		insideTmux: () => (process.env.TMUX ?? "") !== "",

		async openWindow(spec) {
			const args = ["new-window", "-d", "-P", "-F", "#{window_id}", "-n", spec.name, "-c", spec.cwd];
			for (const [key, value] of Object.entries(spec.env)) args.push("-e", `${key}=${value}`);
			const session = await targetSession();
			if (session !== undefined) args.push("-t", session);
			args.push("--", ...spec.argv);
			const windowId = (await run(args)).trim();
			if (windowId === "") throw new Error("tmux reported no window id");
			return windowId;
		},

		async listWindows() {
			// The name goes last: it is the one field that could hold a tab.
			const out = await run(["list-windows", "-a", "-F", "#{window_id}\t#{pane_dead}\t#{window_name}"]);
			return out
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => {
					const [id, dead, ...name] = line.split("\t");
					return { id, name: name.join("\t"), exited: dead === "1" };
				});
		},

		async kill(windowId) {
			await run(["kill-window", "-t", windowId]);
		},
	};
}

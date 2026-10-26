// The test stand-in for tmux, one of the package's two injected seams. It records the
// windows opened (name, cwd, argv, env) and the kills, and lists windows as
// the test sets them. It models sessions too: which windows each holds, a
// companion session created on demand and gone with its last window, and
// `detach-on-destroy` per session. The model is high level: placement is
// decided here from the parent and companion session names, not by parsing the
// real client's tmux arguments or exact-match targets (`test/tmux.test.ts`
// covers those against a stub `tmux`). The real tmux is exercised by hand, never here.
import {
	companionName,
	type OpenedWindow,
	parseTmuxVersion,
	type TmuxClient,
	type TmuxVersion,
	type TmuxWindow,
	WindowOpenError,
	type WindowSpec,
} from "../src/tmux.ts";
import type { WindowPlacement } from "../src/window-placement.ts";

export class FakeTmux implements TmuxClient {
	/** Whether the session looks like it runs inside tmux. */
	inside = true;
	/** The session the parent's pane is in. */
	parentSession = "work";
	/** The `tmux -V` text. */
	versionText = "tmux 3.7b";
	/** Every window opened, in order, each with the id and session it returned. */
	readonly opened: (WindowSpec & { windowId: string; session: string | undefined; placement: WindowPlacement })[] = [];
	/** Every window id passed to `kill`, in order. */
	readonly killed: string[] = [];
	/** Every window the server lists, by id. */
	readonly windows = new Map<string, { name: string; exited: boolean; session: string }>();
	/** Each session's window ids, by session name, derived from `windows`: a session with no window does not exist. */
	get sessions(): Map<string, string[]> {
		const bySession = new Map<string, string[]>();
		for (const [id, { session }] of this.windows) bySession.set(session, [...(bySession.get(session) ?? []), id]);
		return bySession;
	}
	/** The `detach-on-destroy` value set on a session, by session name; the user's sessions are never set. */
	readonly detachOnDestroy = new Map<string, string>();
	/** Sessions pi-squire marked as companions when it created them (`@squire-companion`); the mark goes with the session. */
	readonly companions = new Set<string>();
	/** The tmux commands `openWindow` ran, in order: `new-window <target>` and `new-session <name>`. */
	readonly commands: string[] = [];
	/** How many times `listWindows` was called. */
	listCalls = 0;
	/** When set, `listWindows` rejects with this message. */
	failList: string | undefined;
	/** When set, `openWindow` rejects with this message instead of opening. */
	failOpen: string | undefined;
	/** Whether a `failOpen` failure could have left a window; a known failure by default. */
	failOpenCertainty: "not-opened" | "unknown" | undefined;
	/** When set, a companion `new-session` loses a race: another launch created the session first. */
	raceNewSession = false;
	/** When set, the create step fails with this message after it was dispatched. */
	failAfterDispatch: string | undefined;
	/** When set with `raceNewSession`, the race winner's session is gone again by the retry. */
	raceWinnerGone = false;
	private next = 0;

	insideTmux(): boolean {
		return this.inside;
	}

	async version(): Promise<TmuxVersion> {
		return parseTmuxVersion(this.versionText);
	}

	private add(session: string, name: string): string {
		const windowId = `@${++this.next}`;
		this.windows.set(windowId, { name, exited: false, session });
		return windowId;
	}

	async openWindow(spec: WindowSpec, placement: WindowPlacement): Promise<OpenedWindow> {
		if (this.failOpen !== undefined) throw new WindowOpenError(this.failOpen, this.failOpenCertainty ?? "not-opened");
		const record = (windowId: string, session: string): OpenedWindow => {
			this.opened.push({ ...spec, argv: [...spec.argv], env: { ...spec.env }, windowId, session, placement });
			return { id: windowId, session };
		};
		const dispatchFailure = (): never => {
			throw new WindowOpenError(this.failAfterDispatch ?? "", "unknown");
		};
		if (placement === "current") {
			this.commands.push(`new-window ${this.parentSession}`);
			if (this.failAfterDispatch !== undefined) dispatchFailure();
			return record(this.add(this.parentSession, spec.name), this.parentSession);
		}
		const parentMarked = this.companions.has(this.parentSession) && this.sessions.has(this.parentSession);
		const session = companionName(this.parentSession, parentMarked);
		const newWindow = async (afterDispatch: boolean): Promise<OpenedWindow> => {
			this.commands.push(`new-window =${session}:`);
			if (!this.sessions.has(session)) {
				// The first try resolves its target before it creates anything; the retry follows a dispatched create.
				throw new WindowOpenError(`can't find session: ${session}`, afterDispatch ? "unknown" : "not-opened");
			}
			if (this.failAfterDispatch !== undefined) dispatchFailure();
			return record(this.add(session, spec.name), session);
		};
		try {
			return await newWindow(false);
		} catch (err) {
			if (!(err instanceof WindowOpenError) || !err.message.includes("can't find session")) throw err;
		}
		this.commands.push(`new-session ${session}`);
		if (this.failAfterDispatch !== undefined) dispatchFailure();
		if (this.raceNewSession) {
			this.raceNewSession = false;
			// The winner's window, which this launch knows nothing about.
			const other = this.add(session, "other-launch");
			this.companions.add(session);
			if (this.raceWinnerGone) this.windows.delete(other);
			return newWindow(true);
		}
		const windowId = this.add(session, spec.name);
		// A fresh session, so any earlier settings went with its predecessor.
		this.detachOnDestroy.set(session, "off");
		this.companions.add(session);
		return record(windowId, session);
	}

	async listWindows(): Promise<TmuxWindow[]> {
		this.listCalls++;
		if (this.failList !== undefined) throw new Error(this.failList);
		return [...this.windows].map(([id, { name, exited, session }]) => ({ id, session, name, exited }));
	}

	/** Mark a window's program as exited; the window stays listed, as with `remain-on-exit`. */
	exit(windowId: string): void {
		const window = this.windows.get(windowId);
		if (window !== undefined) window.exited = true;
	}

	/** Add a window this fake did not open, such as one that holds a recycled id. */
	addWindow(id: string, name: string, session = this.parentSession): void {
		this.windows.set(id, { name, exited: false, session });
	}

	/** Move a window to another session, as `move-window` does; its id stays. */
	moveWindow(windowId: string, session: string): void {
		const window = this.windows.get(windowId);
		if (window !== undefined) window.session = session;
	}

	async kill(windowId: string): Promise<void> {
		this.killed.push(windowId);
		this.windows.delete(windowId);
	}
}

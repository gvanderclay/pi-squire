// The test stand-in for tmux, the package's one injected seam. It records the
// windows opened (name, cwd, argv, env) and the kills, and lists windows as
// the test sets them. The real client is exercised by hand, never here.
import type { TmuxClient, TmuxWindow, WindowSpec } from "../src/tmux.ts";

export class FakeTmux implements TmuxClient {
	/** Whether the session looks like it runs inside tmux. */
	inside = true;
	/** Every window opened, in order, each with the id it returned. */
	readonly opened: (WindowSpec & { windowId: string })[] = [];
	/** Every window id passed to `kill`, in order. */
	readonly killed: string[] = [];
	/** Every window the server lists, by id. */
	readonly windows = new Map<string, { name: string; exited: boolean }>();
	/** How many times `listWindows` was called. */
	listCalls = 0;
	/** When set, `listWindows` rejects with this message. */
	failList: string | undefined;
	/** When set, `openWindow` rejects with this message instead of opening. */
	failOpen: string | undefined;
	private next = 0;

	insideTmux(): boolean {
		return this.inside;
	}

	async openWindow(spec: WindowSpec): Promise<string> {
		if (this.failOpen !== undefined) throw new Error(this.failOpen);
		const windowId = `@${++this.next}`;
		this.opened.push({ ...spec, argv: [...spec.argv], env: { ...spec.env }, windowId });
		this.windows.set(windowId, { name: spec.name, exited: false });
		return windowId;
	}

	async listWindows(): Promise<TmuxWindow[]> {
		this.listCalls++;
		if (this.failList !== undefined) throw new Error(this.failList);
		return [...this.windows].map(([id, { name, exited }]) => ({ id, name, exited }));
	}

	/** Mark a window's program as exited; the window stays listed, as with `remain-on-exit`. */
	exit(windowId: string): void {
		const window = this.windows.get(windowId);
		if (window !== undefined) window.exited = true;
	}

	/** Add a window this fake did not open, such as one that holds a recycled id. */
	addWindow(id: string, name: string): void {
		this.windows.set(id, { name, exited: false });
	}

	async kill(windowId: string): Promise<void> {
		this.killed.push(windowId);
		this.windows.delete(windowId);
	}
}

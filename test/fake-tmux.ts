// The test stand-in for tmux, the package's one injected seam. It records the
// windows opened (name, cwd, argv, env) and the kills, and reports liveness as
// the test sets it. The real client is exercised by hand, never here.
import type { TmuxClient, WindowSpec } from "../src/tmux.ts";

export class FakeTmux implements TmuxClient {
	/** Whether the session looks like it runs inside tmux. */
	inside = true;
	/** Every window opened, in order, each with the id it returned. */
	readonly opened: (WindowSpec & { windowId: string })[] = [];
	/** Every window id passed to `kill`, in order. */
	readonly killed: string[] = [];
	/** Window ids `isAlive` reports as still open. */
	readonly alive = new Set<string>();
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
		this.alive.add(windowId);
		return windowId;
	}

	async isAlive(windowId: string): Promise<boolean> {
		return this.alive.has(windowId);
	}

	async kill(windowId: string): Promise<void> {
		this.killed.push(windowId);
		this.alive.delete(windowId);
	}
}

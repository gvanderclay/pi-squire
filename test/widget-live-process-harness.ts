import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

type Reply = { key: number; result?: unknown; error?: string; ready?: boolean };
export class ActivityProcess {
	readonly child: ChildProcess;
	private sequence = 0;
	private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	readonly ready: Promise<void>;
	constructor(agentDir: string, fixture = "widget-live.ts", environment: NodeJS.ProcessEnv = {}) {
		this.child = fork(fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)), [], {
			env: { ...process.env, ...environment, PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.ready = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(Error("activity fixture startup timed out")), 10000);
			this.child.once("error", reject);
			this.child.on("message", (reply: Reply) => {
				if (reply.ready) {
					clearTimeout(timer);
					resolve();
					return;
				}
				const request = this.waiting.get(reply.key);
				if (!request) return;
				this.waiting.delete(reply.key);
				if (reply.error) request.reject(Error(reply.error));
				else request.resolve(reply.result);
			});
		});
		this.child.once("exit", () => {
			for (const request of this.waiting.values()) request.reject(Error("activity fixture exited"));
			this.waiting.clear();
		});
	}
	async command<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
		await this.ready;
		const key = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(key);
				reject(Error(`activity fixture timeout: ${op}`));
			}, 10000);
			this.waiting.set(key, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.send({ key, op, ...args });
		});
	}
	async kill(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			this.child.kill("SIGKILL");
		});
	}
}

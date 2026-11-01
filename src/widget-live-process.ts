import { execFile } from "node:child_process";

export type ProcessIdentity = { pid: number; processStart: string };
export type Liveness = "live" | "dead" | "unknown";

export function processStart(pid: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		// lstart is formatted text: publisher and reader must use the same locale/time zone.
		execFile(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{ timeout: 1000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
			(error, stdout) => {
				resolve(error ? undefined : stdout.trim() || undefined);
			},
		);
	});
}

/** Only ESRCH or a successfully observed different start token proves a dead generation. */
export async function processLiveness(owner: ProcessIdentity): Promise<Liveness> {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
		return "unknown";
	}
	const start: string | undefined = await processStart(owner.pid);
	if (start === undefined) return "unknown";
	return start === owner.processStart ? "live" : "dead";
}

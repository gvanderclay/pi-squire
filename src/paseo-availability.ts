// Read-only daemon classification; the absent path never imports the Paseo SDK.
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

export type PaseoAvailability = { state: "available" } | { state: "absent" | "ambiguous"; reason: string };
const pidFile = (home: string): string => join(home, "paseo.pid");
const CONNECT_TIMEOUT_MS = 10_000;

// Paseo 0.15.4 server/server/pid-lock.js acquirePidLock writes pid and nullable
// listen; an unpublished address stays ambiguous unless its pid is dead.
// Older listen-only records are probed.
type DaemonDescriptor = { listen: string; host: string; port: number };
export function descriptor(home: string): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(pidFile(home), "utf8"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "absent", reason: `Paseo is not running: ${pidFile(home)} is missing` }
			: { state: "ambiguous", reason: `Paseo descriptor unreadable: ${pidFile(home)} (${(error as Error).message})` };
	}
	return parseDescriptor(home, value);
}
function parseDescriptor(
	home: string,
	value: unknown,
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	if (!value || typeof value !== "object") return malformed(home);
	const { listen, pid } = value as { listen?: unknown; pid?: unknown };
	if (pid !== undefined && (!Number.isSafeInteger(pid) || Number(pid) <= 0)) return malformed(home);
	if (listen === null && typeof pid === "number")
		return (
			checkPid(home, pid) ?? { state: "ambiguous", reason: `Paseo daemon has no published address: ${pidFile(home)}` }
		);
	if (typeof listen !== "string" || !listen) return malformed(home);
	const address = parseAddress(home, listen);
	if ("state" in address) return address;
	return (typeof pid === "number" ? checkPid(home, pid) : undefined) ?? address;
}
function parseAddress(
	home: string,
	listen: string,
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	let url: URL;
	try {
		url = new URL(`ws://${listen}/ws`);
		if (
			!url.hostname ||
			!/:\d+$/.test(listen) ||
			url.pathname !== "/ws" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			return malformed(home);
	} catch {
		return malformed(home);
	}
	if (Number(url.port) === 0 && url.port !== "") return malformed(home);
	return { listen, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
}
function checkPid(home: string, pid: number): Exclude<PaseoAvailability, { state: "available" }> | undefined {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH")
			return { state: "absent", reason: `Paseo is not running: ${pidFile(home)} names dead pid ${pid}` };
		// EPERM proves a process exists, not that we may signal it.
		if ((error as NodeJS.ErrnoException).code !== "EPERM")
			return { state: "ambiguous", reason: `Paseo pid liveness unverified: ${(error as Error).message}` };
	}
	return undefined;
}
const malformed = (home: string): Exclude<PaseoAvailability, { state: "available" }> => ({
	state: "ambiguous",
	reason: `Paseo descriptor malformed: ${pidFile(home)}`,
});

/** Probe TCP before loading the SDK: its browser transport can erase ECONNREFUSED
 * (0.15.4 daemon-client.js onError/describeTransportError). Never infer absence
 * from an authentication failure, timeout, or generic transport error.
 */
function probe(address: DaemonDescriptor): Promise<PaseoAvailability> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: address.host, port: address.port });
		const finish = (state: PaseoAvailability): void => {
			clearTimeout(timer);
			socket.destroy();
			resolve(state);
		};
		const timer = setTimeout(
			() =>
				finish({
					state: "ambiguous",
					reason: `Paseo connection timed out: ${address.listen}`,
				}),
			CONNECT_TIMEOUT_MS,
		);
		socket.once("connect", () => finish({ state: "available" }));
		socket.once("error", (error: NodeJS.ErrnoException) =>
			finish({
				state: error.code === "ECONNREFUSED" ? "absent" : "ambiguous",
				reason: `Paseo connection ${error.code === "ECONNREFUSED" ? "refused" : "unverified"}: ${address.listen} (${error.message})`,
			}),
		);
	});
}
export async function daemonAvailability(home: string, connect: () => Promise<void>): Promise<PaseoAvailability> {
	const address = descriptor(home);
	if ("state" in address) return address;
	const tcp = await probe(address);
	if (tcp.state !== "available") return tcp;
	try {
		await connect();
		return { state: "available" };
	} catch (error) {
		return { state: "ambiguous", reason: `Paseo daemon unavailable: ${(error as Error).message}` };
	}
}

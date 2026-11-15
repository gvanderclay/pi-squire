// Read-only daemon classification; the absent path never imports the Paseo SDK.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";

export type PaseoAvailability = { state: "available" } | { state: "absent" | "ambiguous"; reason: string };
const pidFile = (home: string): string => join(home, "paseo.pid");
const CONNECT_TIMEOUT_MS = 10_000;

// Paseo 0.15.4 server/server/pid-lock.js acquirePidLock writes pid and nullable
// listen; an unpublished address stays ambiguous unless its pid is dead.
// Older listen-only records are probed.
type DaemonDescriptor = { listen: string } & ({ host: string; port: number } | { path: string });
type HostIdentity = { hostname?: unknown; bootId?: unknown };
export function descriptor(
	home: string,
	mode: "cleanup" | "admission" | "connect" = "cleanup",
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(pidFile(home), "utf8"));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { state: "absent", reason: `Paseo is not running: ${pidFile(home)} is missing` }
			: { state: "ambiguous", reason: `Paseo descriptor unreadable: ${pidFile(home)} (${(error as Error).message})` };
	}
	return parseDescriptor(home, value, mode);
}
function parseDescriptor(
	home: string,
	value: unknown,
	mode: "cleanup" | "admission" | "connect",
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return malformed(home);
	const { listen, pid, ...identity } = value as HostIdentity & { listen?: unknown; pid?: unknown };
	// Connection/authentication, unlike absence classification, must not depend
	// on whether this process can verify the daemon's pid namespace or host.
	if (mode === "connect")
		return listen === null || listen === undefined ? unpublished(home) : parseListen(home, listen);
	if (pid !== undefined && (!Number.isSafeInteger(pid) || Number(pid) <= 0)) return malformed(home);
	// A stale pid proves absence even before an address was published, or when
	// listen is a Unix socket path (bootstrap.js formatListenTarget).
	const stopped = typeof pid === "number" ? checkPid(home, pid, identity, mode === "cleanup") : undefined;
	// Admission must not spawn an identity lookup. A refused socket is still
	// positive absence even if a dead pid belongs to an unverified host.
	if (stopped && (mode === "cleanup" || stopped.state === "absent")) return stopped;
	if (listen === null && typeof pid === "number") return unpublished(home);
	return parseListen(home, listen);
}
function parseListen(
	home: string,
	listen: unknown,
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	return typeof listen === "string" && listen ? parseAddress(home, listen) : malformed(home);
}
function parseAddress(
	home: string,
	listen: string,
): DaemonDescriptor | Exclude<PaseoAvailability, { state: "available" }> {
	if (listen.startsWith("/") && !listen.includes("\0")) return { listen, path: listen };
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
// Installed Paseo app.asar: @getpaseo/server/dist/server/server/{pid-lock,host-name}.js.
// Match the writer, not macOS's DHCP/kernel hostname. Read each identity at
// most once per descriptor check; never spawn scutil during launch admission.
function identityMatches(identity: HostIdentity): boolean {
	try {
		if (identity.hostname !== undefined) {
			const local =
				process.platform === "darwin"
					? execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1_000 }).trim()
					: hostname();
			if (!local || identity.hostname !== local) return false;
		}
		return (
			identity.bootId === undefined ||
			identity.bootId === readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
		);
	} catch {
		return false;
	}
}
function checkPid(
	home: string,
	pid: number,
	identity: HostIdentity,
	verifyIdentity: boolean,
): Exclude<PaseoAvailability, { state: "available" }> | undefined {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") {
			const hasIdentity = identity.hostname !== undefined || identity.bootId !== undefined;
			if (hasIdentity && (!verifyIdentity || !identityMatches(identity)))
				return {
					state: "ambiguous",
					reason: `Paseo pid liveness unverified: descriptor host/boot identity does not match or cannot be verified (${pidFile(home)})`,
				};
			return { state: "absent", reason: `Paseo is not running: ${pidFile(home)} names dead pid ${pid}` };
		}
		// EPERM proves a process exists, not that we may signal it.
		if ((error as NodeJS.ErrnoException).code !== "EPERM")
			return { state: "ambiguous", reason: `Paseo pid liveness unverified: ${(error as Error).message}` };
	}
	return undefined;
}
const unpublished = (home: string): Exclude<PaseoAvailability, { state: "available" }> => ({
	state: "ambiguous",
	reason: `Paseo daemon has no published address: ${pidFile(home)}`,
});
const malformed = (home: string): Exclude<PaseoAvailability, { state: "available" }> => ({
	state: "ambiguous",
	reason: `Paseo descriptor malformed: ${pidFile(home)}`,
});

/** Probe TCP or a Unix socket before loading the SDK: its browser transport can erase ECONNREFUSED
 * (0.15.4 daemon-client.js onError/describeTransportError). Never infer absence
 * from an authentication failure, timeout, or generic transport error.
 */
function probe(address: DaemonDescriptor): Promise<PaseoAvailability> {
	return new Promise((resolve) => {
		const socket = createConnection(
			"path" in address ? { path: address.path } : { host: address.host, port: address.port },
		);
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
/** SDK-free admission: only positive absence should refuse a launch. */
export async function probeDaemonAvailability(home: string, verifyIdentity = true): Promise<PaseoAvailability> {
	const address = descriptor(home, verifyIdentity ? "cleanup" : "admission");
	return "state" in address ? address : probe(address);
}

export async function daemonAvailability(home: string, connect: () => Promise<void>): Promise<PaseoAvailability> {
	const socket = await probeDaemonAvailability(home);
	if (socket.state !== "available") return socket;
	try {
		await connect();
		return { state: "available" };
	} catch (error) {
		return { state: "ambiguous", reason: `Paseo daemon unavailable: ${(error as Error).message}` };
	}
}

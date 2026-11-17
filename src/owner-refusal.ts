// Words the refusal a duplicate Pi shows before it quits, because the TUI clears
// its notification on shutdown. Names the owning process so a user can tell a
// forgotten terminal from a host-started Pi (Paseo starts one on resume), and
// gives the command that stops it. Stopping it is the user's choice; Squire
// never evicts a live owner itself.
import { execFileSync } from "node:child_process";

export type OwnerProcess = { command?: string; started?: string; parentPid?: number; parentCommand?: string };
export type ReadPs = (fields: string, pid: number) => string | undefined;

function readPs(fields: string, pid: number): string | undefined {
	try {
		const value: string = execFileSync("ps", ["-o", fields, "-p", String(pid)], {
			encoding: "utf8",
			timeout: 1000,
			// Fixed `lstart` layout: five space-separated fields.
			env: { ...process.env, LC_ALL: "C" },
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/** Best effort: empty where `ps` is missing or the process has gone. */
export function describeProcess(pid: number, ps: ReadPs = readPs): OwnerProcess {
	const line: string | undefined = ps("ppid=,lstart=,comm=", pid);
	if (!line) return {};
	const [ppid, ...rest] = line.split(/\s+/);
	const parentPid: number = Number(ppid);
	const described: OwnerProcess = {
		started: rest.slice(0, 5).join(" ") || undefined,
		command: rest.slice(5).join(" ") || undefined,
	};
	if (Number.isSafeInteger(parentPid) && parentPid > 1) {
		described.parentPid = parentPid;
		described.parentCommand = ps("comm=", parentPid);
	}
	return described;
}

/**
 * The refusal, one fact per line, ending with the commands that free the session.
 * `reopen` is what `pi --session` takes: the session file, or its id.
 */
export function ownerRefusal(reopen: string, pid: number, record: string, owner: OwnerProcess): string {
	const name: string = owner.command ? ` (${owner.command})` : "";
	const started: string = owner.started ? `, started ${owner.started}` : "";
	const parent: string = owner.parentPid
		? `, child of PID ${owner.parentPid}${owner.parentCommand ? ` (${owner.parentCommand})` : ""}`
		: "";
	return [
		"pi-squire: this Pi session is already open in another process, so this Pi quit.",
		`Owner: PID ${pid}${name}${started}${parent}.`,
		`To quit that process and open the session here, run: kill ${pid}`,
		`then, once it has exited: pi --session ${reopen}`,
		`If it does not exit, force it: kill -9 ${pid}`,
		`Owner record: ${record}`,
	].join("\n");
}

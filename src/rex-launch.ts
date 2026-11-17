// Rex launch staging and the runner's published status. Rex starts node on an
// owner-only file directly (--shell=none), so no text is ever typed into a
// shell, and the terminal's exit is read from the status file, never guessed
// from screen text.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowSpec } from "./host.ts";

const routing = (key: string): boolean => /^(?:TMUX|HERDR|REX_)/.test(key);
const launchIdentity = (key: string): boolean => key.startsWith("PI_DELEGATE_") || key === "PI_SQUIRE_LIVE_LAUNCH";

/**
 * The parent's environment without any multiplexer's routing or this
 * coordinator's delegation identity, then the launch's own additions. Rex
 * gives the new terminal its own REX_* values, which the runner keeps.
 */
export function launchEnvironment(
	spec: Pick<WindowSpec, "env">,
	parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
	const kept = (
		source: Readonly<Record<string, string | undefined>>,
		drop: (key: string) => boolean,
	): [string, string][] =>
		Object.entries(source).filter(
			(entry): entry is [string, string] => !routing(entry[0]) && !drop(entry[0]) && entry[1] !== undefined,
		);
	return Object.fromEntries([...kept(parent, launchIdentity), ...kept(spec.env, () => false)]);
}

/** Stage argv/env in an owner-only file: Rex starts node on it directly, with no shell line. */
export function stageLaunch(spec: WindowSpec): string {
	const path = join(mkdtempSync(join(tmpdir(), "pi-squire-rex-")), "launch.mjs");
	const data = JSON.stringify({ argv: spec.argv, env: launchEnvironment(spec), cwd: spec.cwd });
	writeFileSync(
		path,
		`import {spawn} from 'node:child_process';
import {writeFileSync,renameSync} from 'node:fs';
const spec = ${data};
const statusFile = ${JSON.stringify(`${path}.status`)};
const status = {pid:process.pid};
function publish(){writeFileSync(statusFile+'.next',JSON.stringify(status),{mode:0o600});renameSync(statusFile+'.next',statusFile);}
const env = {...process.env};
for(const key of Object.keys(env)) if(key.startsWith('TMUX') || key.startsWith('HERDR') || key.startsWith('PI_DELEGATE_') || key==='PI_SQUIRE_LIVE_LAUNCH') delete env[key];
Object.assign(env,spec.env);
publish();
const child=spawn(spec.argv[0],spec.argv.slice(1),{cwd:spec.cwd,env,stdio:'inherit'});
status.child=child.pid;publish();
function finish(code){status.exit=code;publish();process.exitCode=code;if(code!==0) console.error('pi-squire: delegate exited with status '+code);}
child.on('error',(error)=>{console.error('pi-squire: failed to start delegate: '+error.message);finish(1);});
child.on('exit',(code,signal)=>{if(signal) console.error('pi-squire: delegate terminated by '+signal);finish(code??1);});
`,
		{ mode: 0o600 },
	);
	return path;
}

export type LaunchStatus = { pid: number; child?: number; exit?: number };

/** The runner's published status; a missing file means it has not started yet. */
export function readLaunchStatus(launchFile: string): LaunchStatus | undefined {
	try {
		const value = JSON.parse(readFileSync(`${launchFile}.status`, "utf8")) as Record<string, unknown>;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid launch status");
		if (
			!Number.isSafeInteger(value.pid) ||
			(value.pid as number) <= 0 ||
			(value.exit !== undefined &&
				(!Number.isSafeInteger(value.exit) || (value.exit as number) < 0 || (value.exit as number) > 255))
		)
			throw new Error("invalid launch status");
		return value as LaunchStatus;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

// How pi-squire hands tmux its commands: execFile with no shell, and tmux's own
// command-sequence escaping, which execFile does not provide.
import { execFile } from "node:child_process";

/**
 * Escape one argument for tmux's own command parsing, which execFile does not
 * do: tmux splits argv at any argument whose last character is ';', and turns
 * a final '\;' into a literal ';' (man tmux, PARSING SYNTAX; cmd-parse.y
 * cmd_parse_from_arguments, the same rule in 3.2 and 3.8). Only the last
 * character is special, so a backslash before it needs no escape of its own.
 */
export function tmuxArgument(value: string): string {
	return value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value;
}

/** One tmux argv for a command sequence: every argument escaped, a bare ';' only between commands. */
export function tmuxSequence(commands: readonly (readonly string[])[]): string[] {
	return commands.flatMap((command, index) => [...(index === 0 ? [] : [";"]), ...command.map(tmuxArgument)]);
}

/** Run one tmux command, or a sequence in one queue, and return its stdout; never a shell. */
export function runTmux(commands: readonly (readonly string[])[], timeout: number): Promise<string> {
	const name = commands[0][0];
	return new Promise((resolve, reject) => {
		execFile("tmux", tmuxSequence(commands), { encoding: "utf8", timeout }, (error, stdout, stderr) => {
			if (error) {
				if (error.killed) {
					reject(new Error(`tmux ${name} timed out after ${timeout / 1000} s`));
					return;
				}
				const reason = ["duplicate session", "can't find session"].find((text) => stderr.includes(text));
				reject(new Error(`tmux ${name} failed${reason === undefined ? "" : `: ${reason}`}`));
				return;
			}
			resolve(stdout);
		});
	});
}

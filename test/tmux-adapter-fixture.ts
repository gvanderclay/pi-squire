// Real adapter driver, isolated on a private socket with empty tmux config.
// Faults live at the CLI boundary; all non-faulted calls execute real tmux.
// No user server is addressed, even by commands nested in the test program.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { createTmuxClient, type WindowRecord, windowLocator, windowPresentation } from "../src/tmux.ts";
import { askToClose, askWindowStates } from "../src/window-state.ts";
import type { AdapterContract, AdapterFixture } from "./adapter-contract.ts";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("private tmux fixture did not reach expected state within 3 seconds");
}

export async function tmuxAdapter(): Promise<AdapterFixture> {
	const real = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
	const dir = mkdtempSync(join(tmpdir(), "squire-adapter-"));
	const socket = join(dir, "tmux.sock");
	const failedAsk = join(dir, "fail-ask");
	const ambiguous = join(dir, "ambiguous");
	const saved = { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
	const run = (...args: string[]): string =>
		execFileSync(real, ["-S", socket, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
	const flag = (path: string, on: boolean): void => {
		if (on) writeFileSync(path, "");
		else if (existsSync(path)) rmSync(path);
	};
	let viewer: ChildProcess | undefined;
	const dispose = async (): Promise<void> => {
		try {
			run("kill-server");
		} finally {
			if (viewer && viewer.exitCode === null && viewer.signalCode === null) {
				const stopped = new Promise<void>((resolve) => viewer!.once("exit", () => resolve()));
				viewer.kill();
				await stopped;
			}
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		}
	};
	try {
		process.env.TMUX_PANE = run(
			"-f",
			devNull,
			"new-session",
			"-d",
			"-s",
			"parent",
			"-P",
			"-F",
			"#{pane_id}",
			"sleep 120",
		);
		// A control-mode client is genuinely attached without needing a user's TTY.
		viewer = spawn(real, ["-S", socket, "-C", "attach-session", "-t", "=parent:"], {
			env: { ...process.env, TERM: "xterm" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		viewer.stdout!.resume();
		viewer.stderr!.resume();
		await until(() => run("list-clients", "-F", "#{client_name}") !== "");
		const command = `${quote(real)} -S ${quote(socket)} "$@"`;
		writeFileSync(
			join(dir, "tmux"),
			[
				"#!/bin/sh",
				`if [ -f ${quote(failedAsk)} ] && [ "$1" = list-windows ]; then exit 1; fi`,
				`if [ -f ${quote(ambiguous)} ] && [ "$1" = new-window ]; then`,
				`  rm ${quote(ambiguous)}`,
				`  ${command} > /dev/null || exit 1`,
				"  printf 'lost-create-answer\\n'",
				"  exit 0",
				"fi",
				`exec ${command}`,
				"",
			].join("\n"),
		);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.PATH}`;
		process.env.TMUX = `${socket},0,0`;
		const client = createTmuxClient();
		const id = (record: WindowRecord): string => windowPresentation(record).windowId;
		const adapter: AdapterContract = {
			async open(name) {
				const opened = await client.openWindow(
					{
						name,
						cwd: dir,
						env: {},
						argv: [process.execPath, new URL("./fixtures/adapter-program.mjs", import.meta.url).pathname],
					},
					"current",
					"unused",
				);
				const record = { locator: windowLocator({ id: opened.id, name }) };
				await until(async () => (await client.peek({ windowId: opened.id })).includes("SQUIRE-ADAPTER-SCREEN"));
				return record;
			},
			async state(record) {
				return (await askWindowStates(client)).state(record);
			},
			async close(record) {
				return (await askToClose(client)).close(record);
			},
			show: (record, verify) => client.show({ windowId: id(record) }, verify),
			peek: (record) => client.peek({ windowId: id(record) }),
			unavailable: (checkVersion) => (checkVersion ? client.unavailable(true) : client.unavailable()),
		};
		return {
			adapter,
			async exit(record) {
				run("send-keys", "-t", id(record), "exit", "Enter");
				await until(() => !run("list-windows", "-a", "-F", "#{window_id}").split("\n").includes(id(record)));
			},
			async replace(record) {
				// Same address, different identity: a stale record must not close it.
				run("rename-window", "-t", id(record), "replacement");
				return { locator: windowLocator({ id: id(record), name: "replacement" }) };
			},
			failAsk: (fail) => flag(failedAsk, fail),
			ambiguousOpen: () => flag(ambiguous, true),
			async ambiguousSurvives() {
				return run("list-windows", "-a", "-F", "#{window_name}").split("\n").includes("ambiguous");
			},
			setUnavailable(value) {
				if (value) delete process.env.TMUX;
				else process.env.TMUX = `${socket},0,0`;
			},
			async isShown(record) {
				return run("list-clients", "-F", "#{window_id}").split("\n").includes(id(record));
			},
			dispose,
		};
	} catch (error) {
		await dispose();
		throw error;
	}
}

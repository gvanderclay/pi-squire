// Opt-in: actual attached client and exact live ancestor navigation, private socket only.
// SQUIRE_REAL_TMUX=1 node --test test/widget-ancestor-real.test.ts
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeIdentity } from "../src/identity.ts";
import type { LiveLocator } from "../src/widget-live.ts";
import { agentDir, cleanup } from "./harness.ts";
import { TreeProcess } from "./tree-process-harness.ts";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 7000;
	let value: T;
	do {
		value = await read();
		if (accept(value)) return value;
		await new Promise((r) => setTimeout(r, 30));
	} while (Date.now() < deadline);
	throw new Error(`private tmux observation timed out: ${JSON.stringify(value)}`);
}
test("real private tmux: attached-client root switch, exact pane/server scope, rename and moved-window reattachment", {
	skip: process.env.SQUIRE_REAL_TMUX !== "1",
}, async () => {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/widget-ancestor-"));
	const socket = "./tmux.sock";
	const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
	const saved = { path: process.env.PATH, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
	const run = (...args: string[]): string =>
		execFileSync(realTmux, ["-S", socket, ...args], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	let attached: ChildProcess | undefined;
	const workers: TreeProcess[] = [];
	try {
		const rootPane = run(
			"-f",
			devNull,
			"new-session",
			"-d",
			"-s",
			"ancestor-root",
			"-n",
			"root",
			"-P",
			"-F",
			"#{pane_id}",
			"sleep 120",
		);
		const childPane = run(
			"new-session",
			"-d",
			"-s",
			"ancestor-child",
			"-n",
			"child",
			"-P",
			"-F",
			"#{pane_id}",
			"sleep 120",
		);
		const rootWindow = run("display-message", "-p", "-t", rootPane, "#{window_id}");
		const childWindow = run("display-message", "-p", "-t", childPane, "#{window_id}");
		run("new-window", "-d", "-t", "ancestor-root:", "-n", "anchor", "sleep 120");
		run("new-session", "-d", "-s", "moved-root", "sleep 120");
		const log = join(dir, "commands.log");
		writeFileSync(
			join(dir, "tmux"),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\ncd ${quote(dir)} || exit 1\nexec ${quote(realTmux)} -S ${quote(socket)} "$@"\n`,
		);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.path}`;
		process.env.TMUX = `${socket},0,0`;
		const root = new TreeProcess(agentDir, "./fixtures/widget-ancestor.ts");
		workers.push(root);
		await root.command("boot", { session: "real-root", real: true, pane: rootPane });
		writeIdentity("real-leaf", {
			parent: "real-root",
			root: "real-root",
			depth: 1,
			agent: "leaf",
			chain: ["leaf"],
			rootPlacement: "original-delegate-session",
			autoExit: false,
		});
		const child = new TreeProcess(agentDir, "./fixtures/widget-ancestor.ts");
		workers.push(child);
		await child.command("boot", { session: "real-leaf", real: true, pane: childPane });
		const live = await until(
			() => child.command<LiveLocator | null>("locator", { target: "real-root" }),
			(v) => !!v,
		);
		assert.equal(live!.locator.windowId, rootWindow);
		assert.equal(live!.locator.paneId, rootPane);
		assert.equal(live!.locator.socket, run("display-message", "-p", "-t", rootPane, "#{socket_path}"));
		assert.ok(live!.locator.serverPid > 0);
		attached = spawn(
			"python3",
			[
				fileURLToPath(new URL("./fixtures/widget-attach.py", import.meta.url)),
				realTmux,
				"-S",
				socket,
				"attach-session",
				"-t",
				"ancestor-child",
			],
			{
				cwd: dir,
				env: { ...process.env, TMUX: "", TMUX_PANE: "", TERM: "xterm-256color" },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let output = "";
		attached.stdout?.on("data", (chunk) => {
			output += String(chunk);
		});
		attached.stderr?.on("data", (chunk) => {
			output += String(chunk);
		});
		const client = await until(
			async () => {
				if (attached?.exitCode !== null) throw new Error(`attached client exited: ${output}`);
				return run("list-clients", "-F", "#{client_name}");
			},
			(v) => !!v,
		);
		await child.command("switch", { target: "real-root" });
		assert.equal(run("display-message", "-p", "-c", client, "#{window_id}"), rootWindow);
		run("switch-client", "-c", client, "-t", childWindow);
		run("rename-window", "-t", rootWindow, "root-renamed");
		await until(
			() => child.command<LiveLocator | null>("locator", { target: "real-root" }),
			(v) => v?.locator.windowName === "root-renamed",
		);
		run("move-window", "-s", rootWindow, "-t", "moved-root:2");
		await child.command("switch", { target: "real-root" });
		assert.equal(run("display-message", "-p", "-c", client, "#{session_name}"), "moved-root");
		assert.equal(run("display-message", "-p", "-c", client, "#{window_id}"), rootWindow);
		run("switch-client", "-c", client, "-t", childWindow);
		run("set-window-option", "-t", rootWindow, "remain-on-exit", "on");
		const deadPane = run("split-window", "-d", "-t", rootWindow, "-P", "-F", "#{pane_id}", "exit 0");
		await until(
			async () => run("display-message", "-p", "-t", deadPane, "#{pane_dead}"),
			(v) => v === "1",
		);
		run("select-pane", "-t", deadPane);
		assert.equal(run("display-message", "-p", "-t", rootWindow, "#{pane_dead}"), "1");
		await child.command("switch", { target: "real-root" });
		assert.equal(run("display-message", "-p", "-c", client, "#{window_id}"), rootWindow);
		run("switch-client", "-c", client, "-t", childWindow);
		run("break-pane", "-d", "-s", rootPane, "-t", "moved-root:3");
		const newWindow = run("display-message", "-p", "-t", rootPane, "#{window_id}");
		assert.notEqual(newWindow, rootWindow);
		await until(
			() => child.command<LiveLocator | null>("locator", { target: "real-root" }),
			(v) => v?.locator.windowId === newWindow,
		);
		await child.command("switch", { target: "real-root" });
		assert.equal(run("display-message", "-p", "-c", client, "#{window_id}"), newWindow);
		const commands = readFileSync(log, "utf8").trim().split("\n");
		assert.ok(commands.some((line) => line.startsWith("switch-client ")));
		assert.ok(
			commands.every((line) => /^(display-message|list-windows|list-clients|switch-client) /.test(line)),
			`Squire navigation must not create/kill windows: ${commands.join("\n")}`,
		);
	} finally {
		for (const worker of workers) {
			try {
				await worker.command("shutdown");
			} finally {
				await worker.kill();
			}
		}
		attached?.kill("SIGHUP");
		try {
			run("kill-server");
		} finally {
			if (saved.path === undefined) delete process.env.PATH;
			else process.env.PATH = saved.path;
			if (saved.tmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = saved.tmux;
			if (saved.pane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = saved.pane;
			rmSync(dir, { recursive: true, force: true });
			cleanup();
		}
	}
});

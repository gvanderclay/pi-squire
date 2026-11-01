// Opt-in integration check: every tmux call targets a private socket and an
// empty configuration. No command reaches the user's or delegates' server.
// Run: SQUIRE_REAL_TMUX=1 node --test test/tmux-real.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTmuxClient, type TmuxClient } from "../src/tmux.ts";

type Fixture = { dir: string; run: (...args: string[]) => string; client: TmuxClient };
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function isolated(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	const realTmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
	const dir = mkdtempSync(join(tmpdir(), "squire-real-"));
	const socket = join(dir, "tmux.sock");
	const saved = { path: process.env.PATH, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
	const run = (...args: string[]): string =>
		execFileSync(realTmux, ["-S", socket, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
	try {
		const pane = run("-f", devNull, "new-session", "-d", "-s", "test-parent", "-P", "-F", "#{pane_id}", "sleep 120");
		writeFileSync(join(dir, "tmux"), `#!/bin/sh\nexec ${quote(realTmux)} -S ${quote(socket)} "$@"\n`);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.path}`;
		process.env.TMUX = `${socket},0,0`;
		process.env.TMUX_PANE = pane;
		await body({ dir, run, client: createTmuxClient() });
	} finally {
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
		}
	}
}

test("real tmux: exact ownership targeting, unmarked collisions, alternative reuse and independent window close", {
	skip: process.env.SQUIRE_REAL_TMUX !== "1",
}, async () => {
	await isolated(async ({ dir, run, client }) => {
		const own = await client.currentWindow?.();
		assert.match(own?.id ?? "", /^@[0-9]+$/);
		assert.equal(own?.name, run("display-message", "-p", "-t", process.env.TMUX_PANE!, "-F", "#{window_name}"));
		const base = "api-delegate-session";
		for (const name of [base, `${base}-2`, `${base}-old`]) {
			run("new-session", "-d", "-s", name, "sleep 120");
			run("set-option", "-t", `=${name}:`, "detach-on-destroy", "on");
		}
		const spec = { name: "first", cwd: dir, env: {}, argv: ["sleep", "120"] };
		const first = await client.openWindow(spec, "companion", base);
		assert.equal(first.session, `${base}-3`);
		for (const name of [base, `${base}-2`, `${base}-old`]) {
			assert.equal(run("show-options", "-v", "-t", `=${name}:`, "detach-on-destroy"), "on");
			assert.equal(run("display-message", "-p", "-t", `=${name}:`, "#{@squire-companion}"), "");
			assert.equal(run("list-windows", "-t", `=${name}:`, "-F", "#{window_id}").split("\n").length, 1);
		}
		assert.equal(run("show-options", "-v", "-t", `=${first.session}:`, "@squire-companion"), "1");
		assert.equal(run("show-options", "-v", "-t", `=${first.session}:`, "detach-on-destroy"), "off");
		run("kill-session", "-t", `=${base}:`);
		const second = await client.openWindow({ ...spec, name: "second" }, "companion", base);
		assert.equal(second.session, first.session, "freeing the base must not split the managed companion");
		// A duplicate command queue aborts before either option can touch the user's session.
		assert.throws(
			() =>
				run(
					"new-session",
					"-d",
					"-s",
					`${base}-2`,
					"sleep 120",
					";",
					"set-option",
					"-t",
					`=${base}-2:`,
					"@squire-companion",
					"1",
					";",
					"set-option",
					"-t",
					`=${base}-2:`,
					"detach-on-destroy",
					"off",
				),
			/duplicate session/,
		);
		assert.equal(run("display-message", "-p", "-t", `=${base}-2:`, "#{@squire-companion}"), "");
		assert.equal(run("show-options", "-v", "-t", `=${base}-2:`, "detach-on-destroy"), "on");
		await client.kill(first.id);
		assert.ok((await client.listWindows()).some((window) => window.id === second.id));
	});
});

test("real tmux: delegate environment reaches each window but never persists in its companion session", {
	skip: process.env.SQUIRE_REAL_TMUX !== "1",
}, async () => {
	await isolated(async ({ dir, run, client }) => {
		for (const key of ["PI_UNATTENDED", "SQUIRE_TEST_API_KEY"]) run("set-environment", "-gu", key);
		const probe = join(dir, "probe.cjs");
		writeFileSync(
			probe,
			`const { writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
writeFileSync(process.argv[2], JSON.stringify({
  unattended: process.env.PI_UNATTENDED === "1",
  parent: process.env.SQUIRE_TEST_PARENT_API_KEY !== undefined,
  token: process.env.SQUIRE_TEST_API_KEY === "synthetic token ' \\$ value",
}));
execFileSync(${JSON.stringify(join(dir, "tmux"))}, ["wait-for", "-S", process.argv[3]]);
setInterval(() => {}, 1000);
`,
		);
		const launch = async (name: string, env: Record<string, string>) => {
			const output = join(dir, `${name}.json`);
			const opened = await client.openWindow(
				{ name, cwd: dir, env, argv: [process.execPath, probe, output, name] },
				"companion",
				"env-delegate-session",
			);
			run("wait-for", name);
			return { ...opened, observed: JSON.parse(readFileSync(output, "utf8")) };
		};
		const env = { PI_UNATTENDED: "1", SQUIRE_TEST_API_KEY: "synthetic token ' $ value" };
		const previous = process.env.SQUIRE_TEST_PARENT_API_KEY;
		let first: Awaited<ReturnType<typeof launch>>;
		try {
			process.env.SQUIRE_TEST_PARENT_API_KEY = "parent-only-synthetic-credential";
			first = await launch("first-env", env);
		} finally {
			if (previous === undefined) delete process.env.SQUIRE_TEST_PARENT_API_KEY;
			else process.env.SQUIRE_TEST_PARENT_API_KEY = previous;
		}
		assert.deepEqual(first.observed, { unattended: true, token: true, parent: false });
		assert.throws(
			() => run("show-environment", "-t", `=${first.session}:`, "SQUIRE_TEST_PARENT_API_KEY"),
			/unknown variable/,
		);
		for (const key of Object.keys(env))
			assert.throws(() => run("show-environment", "-t", `=${first.session}:`, key), /unknown variable/);
		const second = await launch("second-empty", {});
		assert.equal(second.session, first.session);
		assert.deepEqual(second.observed, { unattended: false, token: false, parent: false });
		const third = await launch("third-env", env);
		assert.deepEqual(third.observed, { unattended: true, token: true, parent: false });
		for (const key of Object.keys(env))
			assert.throws(() => run("show-environment", "-t", `=${third.session}:`, key), /unknown variable/);
	});
});

test("real tmux: a managed companion losing its last window after lookup is recreated without duplicating the task", {
	skip: process.env.SQUIRE_REAL_TMUX !== "1",
}, async () => {
	await isolated(async ({ dir, run, client }) => {
		const base = "vanishing-delegate-session";
		const lastWindow = run("new-session", "-d", "-s", base, "-P", "-F", "#{window_id}", "sleep 120");
		run("set-option", "-t", `=${base}:`, "@squire-companion", "1");
		const shim = join(dir, "tmux");
		const wrapper = readFileSync(shim, "utf8");
		const removed = join(dir, "removed");
		// Drop the last window immediately before dispatching the real new-window.
		// The original wrapper still pins every nested call to this private socket.
		writeFileSync(
			shim,
			wrapper.replace(
				"exec ",
				[
					`if [ "$1" = new-window ] && [ ! -f ${quote(removed)} ]; then`,
					`touch ${quote(removed)}`,
					`"$0" kill-window -t ${quote(lastWindow)}`,
					"fi",
					"exec ",
				].join("\n"),
			),
		);
		const script = join(dir, "once.mjs");
		const log = join(dir, "starts.txt");
		writeFileSync(
			script,
			'import {appendFileSync} from "node:fs"; appendFileSync(process.argv[2], "started\\n"); setInterval(() => {}, 1000);\n',
		);
		const opened = await client.openWindow(
			{
				name: "after-exit",
				cwd: dir,
				env: {},
				argv: [process.execPath, script, log],
			},
			"companion",
			base,
		);
		assert.equal(opened.session, base);
		assert.notEqual(opened.id, lastWindow);
		assert.equal(run("list-windows", "-t", `=${base}:`, "-F", "#{window_id}"), opened.id);
		assert.equal(run("show-options", "-v", "-t", `=${base}:`, "@squire-companion"), "1");
		assert.equal(run("show-options", "-v", "-t", `=${base}:`, "detach-on-destroy"), "off");
		let starts = "";
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				starts = readFileSync(log, "utf8");
			} catch {
				/* task process is starting */
			}
			if (starts !== "") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(starts, "started\n");
	});
});

test("real tmux: parallel creators converge, with exactly one task process per launch", {
	skip: process.env.SQUIRE_REAL_TMUX !== "1",
}, async () => {
	await isolated(async ({ dir, run, client }) => {
		const script = join(dir, "task.mjs");
		const log = join(dir, "tasks.txt");
		writeFileSync(
			script,
			'import {appendFileSync} from "node:fs"; appendFileSync(process.argv[2], process.argv[3] + "\\n"); setInterval(() => {}, 1000);\n',
		);
		const launches = Array.from({ length: 24 }, (_, index) => ({
			name: `parallel-${index}`,
			cwd: dir,
			env: {},
			argv: [process.execPath, script, log, String(index)],
		}));
		const opened = await Promise.all(
			launches.map((spec) => client.openWindow(spec, "companion", "parallel-delegate-session")),
		);
		assert.equal(new Set(opened.map((window) => window.session)).size, 1);
		assert.equal(new Set(opened.map((window) => window.id)).size, 24);
		assert.equal(run("list-windows", "-t", "=parallel-delegate-session:", "-F", "#{window_id}").split("\n").length, 24);
		// Wait for the task processes to record their starts, with a bounded deadline.
		let tasks: string[] = [];
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				tasks = readFileSync(log, "utf8").trim().split("\n");
			} catch {
				/* task processes are starting */
			}
			if (tasks.length === 24) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.deepEqual(
			tasks.map(Number).sort((a, b) => a - b),
			launches.map((_, index) => index),
		);
	});
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTmuxClient, navigationVerbs, type TmuxNavigation } from "../src/tmux.ts";
import { FakeTmux } from "./fake-tmux.ts";

test("show finds the current session's client before revalidation and switches only afterward", async () => {
	const tmux = new FakeTmux();
	tmux.attachClient("old", 1);
	tmux.attachClient("new", 2);
	const calls: string[] = [];
	const own = tmux.ownSession.bind(tmux);
	const clients = tmux.clientFor.bind(tmux);
	const switchTo = tmux.switchTo.bind(tmux);
	tmux.ownSession = async () => {
		calls.push("session");
		return own();
	};
	tmux.clientFor = async (session) => {
		calls.push(`clients:${session}`);
		return clients(session);
	};
	tmux.switchTo = async (client, window) => {
		calls.push(`switch:${client}:${window}`);
		await switchTo(client, window);
	};
	assert.deepEqual(
		await tmux.show({ windowId: "@7" }, async () => {
			calls.push("verify");
			return true;
		}),
		{ shown: true, returnHint: "your tmux last-session key returns you" },
	);
	assert.deepEqual(calls, ["session", "clients:work", "verify", "switch:new:@7"]);
});

test("show refuses before verification, preserves lookup causes, and never switches a canceled target", async () => {
	const tmux = new FakeTmux();
	let verified = false;
	const verify = async (): Promise<boolean> => {
		verified = true;
		return false;
	};
	assert.deepEqual(await tmux.show({ windowId: "@1" }, verify), {
		text: "no tmux client is attached to session work",
		brief: "no tmux client attached to this session",
	});
	assert.equal(verified, false);
	const cause = new Error("lookup failed");
	tmux.ownSession = async () => {
		throw cause;
	};
	const failed = await tmux.show({ windowId: "@1" }, verify);
	assert.ok("cause" in failed);
	assert.equal(failed.cause, cause);
	assert.equal(verified, false);
	tmux.ownSession = async () => ({ id: "$1", name: "work" });
	tmux.fail.clientFor = "server gone";
	const missing = await tmux.show({ windowId: "@1" }, verify);
	assert.ok("text" in missing);
	assert.equal(missing.text, "could not list tmux clients: server gone");
	tmux.fail.clientFor = undefined;
	tmux.attachClient("client", 1);
	assert.deepEqual(await tmux.show({ windowId: "@1" }, verify), { shown: false });
	assert.equal(verified, true);
	assert.deepEqual(tmux.switches, []);
});

test("peek uses the exact pane locator when present and otherwise the window", async () => {
	const tmux = new FakeTmux();
	tmux.screens.set("@7", "window");
	tmux.screens.set("%2", "pane");
	assert.equal(await tmux.peek({ windowId: "@7" }), "window");
	assert.equal(await tmux.peek({ windowId: "@7", paneId: "%2" }), "pane");
	assert.deepEqual(tmux.captures, ["@7", "%2"]);
});

test("unavailable checks environment alone synchronously, and environment before version at launch", async () => {
	const tmux = new FakeTmux();
	let versions = 0;
	const version = tmux.version.bind(tmux);
	tmux.version = async () => {
		versions++;
		return version();
	};
	tmux.inside = false;
	assert.equal(
		tmux.unavailable(),
		"this session is not inside tmux; start it in a tmux pane to open a delegate window",
	);
	assert.equal(await tmux.unavailable(true), tmux.unavailable());
	assert.equal(versions, 0);
	tmux.inside = true;
	tmux.versionText = "tmux 3.1";
	assert.equal(tmux.unavailable(), undefined);
	assert.equal(versions, 0);
	assert.equal(await tmux.unavailable(true), "delegate windows need tmux 3.2 or later; this is tmux 3.1");
	assert.equal(versions, 1);
	tmux.versionText = "tmux 3.2";
	assert.equal(await tmux.unavailable(true), undefined);
	assert.equal(versions, 2);
});

test("real adapter show, peek and availability keep the exact tmux command budget", async () => {
	const dir = mkdtempSync(join(tmpdir(), "squire-navigation-verbs-"));
	const saved = { path: process.env.PATH, pane: process.env.TMUX_PANE, tmux: process.env.TMUX };
	try {
		writeFileSync(
			join(dir, "tmux"),
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${dir}/log'`,
				'case "$1" in',
				'-V) echo "tmux 3.7b";;',
				"display-message) printf '$1\\twork\\n';;",
				"list-clients) printf '100\\told\\n900\\tnew\\n';;",
				"capture-pane) echo 'screen';;",
				"esac",
			].join("\n"),
		);
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${saved.path}`;
		process.env.TMUX_PANE = "%1";
		process.env.TMUX = "present";
		const tmux = createTmuxClient();
		assert.equal(await tmux.unavailable(true), undefined);
		assert.equal(await tmux.unavailable(true), undefined);
		assert.deepEqual(
			await tmux.show({ windowId: "@7" }, async () => {
				assert.deepEqual(readFileSync(join(dir, "log"), "utf8").trimEnd().split("\n"), [
					"-V",
					"display-message -p -t %1 -F #{session_id}\t#{session_name}",
					"list-clients -t =work: -F #{client_activity}\t#{client_name}",
				]);
				return true;
			}),
			{ shown: true, returnHint: "your tmux last-session key returns you" },
		);
		assert.equal(await tmux.peek({ windowId: "@7", paneId: "%2" }), "screen\n");
		assert.equal(await tmux.peek({ windowId: "@7" }), "screen\n");
		assert.deepEqual(readFileSync(join(dir, "log"), "utf8").trimEnd().split("\n"), [
			"-V",
			"display-message -p -t %1 -F #{session_id}\t#{session_name}",
			"list-clients -t =work: -F #{client_activity}\t#{client_name}",
			"switch-client -c new -t @7",
			"capture-pane -p -t %2",
			"capture-pane -p -t @7",
		]);
	} finally {
		if (saved.path === undefined) delete process.env.PATH;
		else process.env.PATH = saved.path;
		if (saved.pane === undefined) delete process.env.TMUX_PANE;
		else process.env.TMUX_PANE = saved.pane;
		if (saved.tmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = saved.tmux;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("adapter verbs work with the tmux protocol independently of FakeTmux", async () => {
	const targets: string[] = [];
	const calls: TmuxNavigation = {
		insideTmux: () => true,
		version: async () => ({ text: "tmux 3.2", major: 3, minor: 2 }),
		ownSession: async () => ({ id: "$1", name: "work" }),
		clientFor: async () => "client",
		switchTo: async (client, window) => {
			targets.push(`${client}:${window}`);
		},
		capture: async (target) => target,
	};
	const adapter = navigationVerbs(calls);
	await adapter.show({ windowId: "@7", paneId: "%2" }, async () => true);
	assert.deepEqual(targets, ["client:@7"]);
	assert.equal(await adapter.peek({ windowId: "@7", paneId: "%2" }), "%2");
});

// Where delegate windows open: the shared root-project companion
// by default, the parent's own session with `windowPlacement: "current"`. The
// tmux is the harness's fake, which models sessions; the real client is
// exercised by hand.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { WindowOpenError } from "../src/tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

const companion = `${basename(root)}-delegates`;

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
after(() => cleanup());

const settingsFile = join(agentDir, "squire", "settings.json");
const setSettings = (value: unknown): void => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(value));
};

type Session = ReturnType<typeof session>;
const started = async (): Promise<Session> => {
	const s = session();
	await s.start();
	return s;
};
const call = (s: Session, label: string) => s.toolCall("delegate", { agent: "scout", task: "look", label });

test("by default the delegate is the first window of a new companion session, with detach-on-destroy off", async () => {
	const s = await started();
	await call(s, "first");
	const [window] = s.tmux.opened;
	assert.equal(window.session, companion);
	assert.equal(window.placement, "companion");
	assert.deepEqual(s.tmux.commands, [`new-session ${companion}`]);
	assert.deepEqual([...s.tmux.sessions], [[companion, [window.windowId]]]);
	assert.equal(s.tmux.detachOnDestroy.get(companion), "off");
	assert.equal(s.tmux.sessions.has("work"), false, "nothing is recorded in the parent's session");
	assert.equal(s.tmux.detachOnDestroy.has("work"), false, "the user's own session keeps its options");
});

test("a configured suffix opens the normalized root project companion", async () => {
	setSettings({ companionSuffix: "playpen" });
	const s = session({ cwd: join(root, "Client API") });
	mkdirSync(join(root, "Client API"));
	await s.start();
	const result = await call(s, "configured");
	assert.equal(s.tmux.opened[0].session, "Client-API-playpen");
	assert.equal((result.structuredContent as { windowSession: string }).windowSession, "Client-API-playpen");
});

test("valid suffixes preserve case, underscores, internal hyphens and the length limit", async () => {
	const s = await started();
	for (const suffix of ["a", "A_9", "x--y", "a".repeat(32)]) {
		setSettings({ companionSuffix: suffix });
		await call(s, suffix);
		assert.equal(s.tmux.opened.at(-1)?.session, `${basename(root)}-${suffix}`);
	}
});

test("an invalid companionSuffix refuses before mail is sent or a window opens", async () => {
	const s = await started();
	for (const value of ["2", "x-10", "a b", "a".repeat(33), "", "-a", "a-", "../x", "a\n", "é", 3, null]) {
		setSettings({ companionSuffix: value });
		await assert.rejects(call(s, "bad"), (err: Error) => {
			assert.ok(err.message.includes(settingsFile), err.message);
			assert.match(err.message, /companionSuffix must be/);
			return true;
		});
	}
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.entries, []);
});

test("/delegate reports an invalid companionSuffix and starts nothing", async () => {
	setSettings({ companionSuffix: "x-10" });
	const s = await started();
	await s.delegate("scout look");
	assert.ok(s.errors.some((line) => line.includes(settingsFile) && line.includes("companionSuffix")));
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("the companion suffix is read at launch but a resume keeps its saved preference", async () => {
	setSettings({ companionSuffix: "playpen" });
	const d = await exitedDelegate();
	const original = `${basename(root)}-playpen`;
	assert.equal(d.s.tmux.opened[0].session, original);
	setSettings({ companionSuffix: "other" });
	await call(d.s, "new");
	assert.equal(d.s.tmux.opened.at(-1)?.session, `${basename(root)}-other`);
	d.s.tmux.exit(d.windowId);
	const result = await d.s.toolCall("delegation_resume", { id: d.id, task: "more" });
	assert.equal((result.structuredContent as { windowSession: string }).windowSession, original);
});

test("an existing companion session gets a new window", async () => {
	const s = await started();
	await call(s, "first");
	s.tmux.commands.length = 0;
	await call(s, "second");
	assert.deepEqual(s.tmux.commands, [`new-window =${companion}:`]);
	assert.equal(s.tmux.sessions.get(companion)?.length, 2);
});

test("a companion session that vanished is created again by the next launch", async () => {
	const s = await started();
	await call(s, "first");
	await s.tmux.kill(s.tmux.opened[0].windowId);
	assert.equal(s.tmux.sessions.has(companion), false, "tmux destroys a session with its last window");
	s.tmux.commands.length = 0;
	await call(s, "second");
	assert.deepEqual(s.tmux.commands, [`new-session ${companion}`]);
	assert.equal(s.tmux.opened.at(-1)?.session, companion);
	assert.equal(s.tmux.detachOnDestroy.get(companion), "off");
});

test("losing the new-session race retries new-window once", async () => {
	const s = await started();
	s.tmux.raceNewSession = true;
	await call(s, "first");
	assert.deepEqual(s.tmux.commands, [`new-session ${companion}`, `new-window =${companion}:`]);
	assert.equal(s.tmux.opened.length, 1);
	assert.equal(s.tmux.opened[0].session, companion);
});

test("the root project still wins when the invoking pane is in a marked companion", async () => {
	const s = await started();
	await call(s, "first"); // creates and marks the project companion
	s.tmux.parentSession = companion;
	await call(s, "nested");
	assert.equal(s.tmux.opened[1].session, companion);
	assert.deepEqual([...s.tmux.sessions.keys()], [companion]);
});

test("the parent tmux session name does not affect project placement", async () => {
	const s = await started();
	s.tmux.parentSession = "pi-squire";
	await call(s, "first");
	assert.equal(s.tmux.opened[0].session, companion);
	assert.equal(s.tmux.sessions.has("pi-squire"), false);
	assert.equal(s.tmux.detachOnDestroy.has("pi-squire"), false);
	// Moving the invoking pane does not change the root project.
	s.tmux.parentSession = "pi-squire-squire";
	await call(s, "nested");
	assert.equal(s.tmux.opened[1].session, companion);
});

test('windowPlacement "current" opens in the parent\'s session and touches no other', async () => {
	setSettings({ windowPlacement: "current" });
	const s = await started();
	const result = await call(s, "first");
	assert.deepEqual(s.tmux.commands, ["new-window work"]);
	assert.equal(s.tmux.opened[0].session, "work");
	assert.equal(s.tmux.opened[0].placement, "current");
	assert.deepEqual([...s.tmux.sessions.keys()], ["work"]);
	assert.equal(s.tmux.detachOnDestroy.size, 0);
	assert.match(result.content[0].text, /in window scout-first in session work\./);
});

test("the setting is read at call time", async () => {
	const s = await started();
	setSettings({ windowPlacement: "current" });
	await call(s, "one");
	setSettings({ windowPlacement: "companion" });
	await call(s, "two");
	assert.deepEqual(
		s.tmux.opened.map((window) => window.session),
		["work", companion],
	);
});

test("an invalid windowPlacement refuses before mail is sent or a window opens", async () => {
	const s = await started();
	for (const value of ["pane", "", 3, null]) {
		setSettings({ windowPlacement: value });
		await assert.rejects(call(s, "bad"), (err: Error) => {
			assert.ok(err.message.includes(settingsFile), err.message);
			assert.match(err.message, /windowPlacement must be "companion" or "current"/);
			return true;
		});
	}
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.tmux.commands, []);
	assert.deepEqual(s.entries, []);
});

test("/delegate with an invalid windowPlacement reports the file and starts nothing", async () => {
	setSettings({ windowPlacement: "pane" });
	const s = await started();
	await s.delegate("scout look");
	assert.ok(
		s.errors.some((line) => line.includes(settingsFile)),
		s.errors.join("\n"),
	);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("tmux older than 3.2 refuses a launch with its version, before mail or a window", async () => {
	const s = await started();
	s.tmux.versionText = "tmux 3.1c";
	await assert.rejects(call(s, "old"), /tmux 3\.2 or later; this is tmux 3\.1c/);
	await s.delegate("scout look");
	assert.ok(
		s.errors.some((line) => /tmux 3\.2 or later; this is tmux 3\.1c/.test(line)),
		s.errors.join("\n"),
	);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("tmux 3.2, a newer release and a development build are accepted", async () => {
	for (const text of ["tmux 3.2", "tmux 3.7b", "tmux next-3.4", "tmux master", "tmux 10.0"]) {
		const s = await started();
		s.tmux.versionText = text;
		await call(s, "ok");
		assert.equal(s.tmux.opened.length, 1, text);
	}
});

/** A delegation whose window has exited, with the session file a resume needs. */
async function exitedDelegate(options: { move?: string } = {}) {
	const s = await started();
	await s.delegate("scout --label first look into it");
	const entry = s.entries[0].data as { id: string; windowId: string };
	mkdirSync(sessionDir, { recursive: true });
	const header = { type: "session", version: 3, id: entry.id, timestamp: "2026-10-26T00:00:00.000Z", cwd: root };
	writeFileSync(join(sessionDir, `20261026T000000_${entry.id}.jsonl`), `${JSON.stringify(header)}\n`);
	if (options.move !== undefined) s.tmux.moveWindow(entry.windowId, options.move);
	return { s, id: entry.id, windowId: entry.windowId };
}

test("tmux older than 3.2 refuses a resume with its version, and kills nothing", async () => {
	const d = await exitedDelegate();
	d.s.tmux.exit(d.windowId);
	d.s.tmux.versionText = "tmux 3.0a";
	await assert.rejects(
		d.s.toolCall("delegation_resume", { id: d.id, task: "more" }),
		/tmux 3\.2 or later; this is tmux 3\.0a/,
	);
	assert.deepEqual(d.s.tmux.killed, []);
	assert.equal(d.s.tmux.opened.length, 1);
});

test("/delegate-resume on tmux older than 3.2 reports the version and mails nothing", async () => {
	const d = await exitedDelegate();
	d.s.tmux.exit(d.windowId);
	d.s.tmux.versionText = "tmux 3.1c";
	const sends = d.s.sendCalls.length;
	await d.s.command("delegate-resume", `${d.id} more`);
	assert.ok(
		d.s.errors.some((line) => /tmux 3\.2 or later; this is tmux 3\.1c/.test(line)),
		d.s.errors.join("\n"),
	);
	assert.equal(d.s.sendCalls.length, sends);
	assert.deepEqual(d.s.tmux.killed, []);
	assert.equal(d.s.tmux.opened.length, 1);
});

test("a launch keeps the placement it read first when the settings change before its window opens", async () => {
	const s = await started();
	for (const later of [
		{ windowPlacement: "bad" },
		{ windowPlacement: "current" },
		{ companionSuffix: "playpen" },
		{ companionSuffix: "2" },
	]) {
		const off = s.events.on("session:launch", () => setSettings(later)); // it comes after the task was mailed
		const result = await call(s, `late-${s.tmux.opened.length}`);
		assert.equal((result.structuredContent as { windowSession?: string }).windowSession, companion);
		off();
		rmSync(settingsFile, { force: true });
	}
	assert.deepEqual(
		s.tmux.opened.map((window) => window.session),
		[companion, companion, companion, companion],
	);
});

test("a resume keeps the placement it read first when the settings change before its window opens", async () => {
	const d = await exitedDelegate();
	d.s.tmux.exit(d.windowId);
	d.s.events.on("session:launch", () => setSettings({ windowPlacement: "bad" }));
	const result = await d.s.toolCall("delegation_resume", { id: d.id, task: "more" });
	assert.equal((result.structuredContent as { windowSession?: string }).windowSession, companion);
	assert.equal(d.s.sendCalls.length, 2, "the task mail went out after a coherent start");
});

test("malformed, unreadable or non-object settings refuse launch rather than erase tree caps", async () => {
	const s = await started();
	const bad: (() => void)[] = [
		() => writeFileSync(settingsFile, "{"),
		() => writeFileSync(settingsFile, JSON.stringify(["current"])),
		() => writeFileSync(settingsFile, "null"),
		() => {
			rmSync(settingsFile, { force: true });
			mkdirSync(settingsFile); // a directory: reading it fails
		},
	];
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	for (const [index, damage] of bad.entries()) {
		rmSync(settingsFile, { recursive: true, force: true });
		damage();
		await assert.rejects(call(s, `fallback-${index}`), /tree caps/);
	}
	assert.equal(s.tmux.opened.length, 0);
	assert.equal(s.sendCalls.length, 0);
});

test("a failed retry after losing the new-session race is unknown, never not-opened", async () => {
	const s = await started();
	s.tmux.raceNewSession = true;
	s.tmux.raceWinnerGone = true;
	const error = await call(s, "racy").catch((err: unknown) => err);
	assert.ok(error instanceof WindowOpenError);
	assert.equal(error.certainty, "unknown");
});

test("a window moved to another session is still matched by status and closed by delegation_close", async () => {
	const d = await exitedDelegate({ move: "elsewhere" });
	const status = (await d.s.toolCall("delegation_status", { id: d.id })).content[0].text;
	assert.match(status, /state: running/);
	assert.ok(status.includes(`window: scout-first (${d.windowId}) in session elsewhere`), status);
	const result = await d.s.toolCall("delegation_close", { id: d.id });
	assert.match(result.content[0].text, /killed scout-first/);
	assert.deepEqual(d.s.tmux.killed, [d.windowId]);
});

test("a window moved to another session is still resumable once its program exited", async () => {
	const d = await exitedDelegate({ move: "elsewhere" });
	d.s.tmux.exit(d.windowId);
	const result = await d.s.toolCall("delegation_resume", { id: d.id, task: "more" });
	assert.deepEqual(d.s.tmux.killed, [d.windowId], "the exited window is killed wherever it is");
	const details = result.structuredContent as { windowSession?: string };
	assert.equal(details.windowSession, companion, "the resumed window follows the setting");
	assert.match(result.content[0].text, new RegExp(`in window scout-first in session ${companion}\\.`));
	assert.match(
		d.s.notes.at(-1) ?? "",
		new RegExp(`resumed .* as .*: scout in window scout-first in session ${companion}`),
	);
});

test("the start text, the tool result and the status show the session", async () => {
	const s = await started();
	const result = await call(s, "first");
	const id = (result.structuredContent as { id: string }).id;
	assert.match(result.content[0].text, new RegExp(`in window scout-first in session ${companion}\\.`));
	assert.equal((result.structuredContent as { windowSession?: string }).windowSession, companion);
	assert.equal(s.notes.at(-1), `delegate: scout ${id} started in window scout-first in session ${companion}`);

	const status = await s.toolCall("delegation_status", { id });
	assert.match(status.content[0].text, new RegExp(`window: scout-first \\(@\\d+\\) in session ${companion}\\n`));
	const [row] = (status.structuredContent as { delegations: { windowSession?: string }[] }).delegations;
	assert.equal(row.windowSession, companion);
});

test("the status follows a renamed session and omits the session once the window is gone", async () => {
	const s = await started();
	const id = ((await call(s, "first")).structuredContent as { id: string }).id;
	s.tmux.moveWindow(s.tmux.opened[0].windowId, "renamed");
	const moved = await s.toolCall("delegation_status", { id });
	assert.match(moved.content[0].text, /\) in session renamed\n/);
	s.tmux.windows.clear();
	const gone = await s.toolCall("delegation_status", { id });
	assert.match(gone.content[0].text, /window: scout-first \(@\d+\)\n/);
	const [row] = (gone.structuredContent as { delegations: Record<string, unknown>[] }).delegations;
	assert.equal("windowSession" in row, false);
});

test("a known failure before anything was dispatched is not-opened; one after dispatch is unknown", async () => {
	const s = await started();
	s.tmux.failOpen = "no server running";
	const known = await call(s, "known").catch((err: unknown) => err);
	assert.ok(known instanceof WindowOpenError);
	assert.equal(known.certainty, "not-opened");

	s.tmux.failOpen = undefined;
	s.tmux.failAfterDispatch = "tmux timed out";
	const unknown = await call(s, "unknown").catch((err: unknown) => err);
	assert.ok(unknown instanceof WindowOpenError);
	assert.equal(unknown.certainty, "unknown");
	assert.equal(s.tmux.commands.at(-1), `new-session ${companion}`);
});

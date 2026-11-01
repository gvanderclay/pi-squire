import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";
import { externalHoldsReady } from "../src/completion-holds.ts";
import { readTree } from "../src/tree-registry.ts";
import { agentFile, cleanup, resetRoot, type SessionOptions, session, writeAgent } from "./harness.ts";
import { envelopes, mailSession, scan } from "./mail-harness.ts";

const KEY = Symbol.for("pi.completion-holds.v1");
type Table = {
	version: number;
	hosts: Map<string, Map<string, string>>;
	holds: Map<string, Map<string, { provider: string; ready: boolean }>>;
};
const shared = globalThis as unknown as Record<symbol, unknown>;
const table = () => shared[KEY] as Table;
const active: ReturnType<typeof session>[] = [];
function instance(options: SessionOptions = {}) {
	const s = session(options);
	active.push(s);
	return s;
}
function mail(options: SessionOptions = {}) {
	const s = mailSession(options);
	active.push(s);
	return s;
}
function hold(sessionId: string, id: string, ready = false) {
	const rows = table().holds.get(sessionId) ?? new Map();
	const entry = { provider: "test-operation", ready };
	rows.set(id, entry);
	table().holds.set(sessionId, rows);
	return entry;
}
beforeEach(() => {
	resetRoot();
	delete shared[KEY];
	writeAgent("worker", agentFile({ model: "alpha/fast-model" }));
});
afterEach(async () => {
	for (const s of active.splice(0)) await s.shutdown();
	delete shared[KEY];
});
after(cleanup);

test("host exists only after active exact-session start and is removed on every shutdown", async () => {
	const s = instance();
	assert.equal(shared[KEY], undefined, "a factory is not a live completion host");
	await s.start();
	const token = table().hosts.get(s.parent)?.get("pi-squire");
	assert.equal(typeof token, "string");
	assert.equal(table().hosts.has("another-session"), false);
	const row = hold(s.parent, "operation");
	await s.fire("session_shutdown", { reason: "reload" });
	assert.equal(table().hosts.has(s.parent), false);
	assert.equal(table().holds.get(s.parent)?.get("operation"), row, "host never removes provider entries");
	assert.equal(externalHoldsReady(s.parent), false);
	const replacement = instance({ parent: s.parent });
	await replacement.start();
	const nextToken = table().hosts.get(s.parent)?.get("pi-squire");
	assert.notEqual(token, nextToken);
	await s.shutdown();
	assert.equal(table().hosts.get(s.parent)?.get("pi-squire"), nextToken, "stale cleanup cannot delete replacement");
	await replacement.shutdown();
	assert.equal(table().hosts.has(s.parent), false);
});

test("an asynchronous earlier startup handler cannot advertise Squire support before ownership", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const s = instance({
		beforeSquire: (pi) => {
			pi.on("session_start", async () => {
				await gate;
			});
		},
	});
	const starting = s.start();
	assert.equal(shared[KEY], undefined);
	release?.();
	await starting;
	assert.equal(typeof table().hosts.get(s.parent)?.get("pi-squire"), "string");
});

test("losing duplicate runtime neither advertises nor overwrites the active owner's host", async () => {
	const first = instance();
	await first.start();
	const token = table().hosts.get(first.parent)?.get("pi-squire");
	const duplicate = instance({ parent: first.parent });
	await duplicate.start();
	assert.equal(duplicate.shutdowns(), 1);
	assert.equal(table().hosts.get(first.parent)?.get("pi-squire"), token);
	await duplicate.shutdown();
	assert.equal(table().hosts.get(first.parent)?.get("pi-squire"), token);
});

test("no holds and other-session holds preserve completion; overlapping rows all need readiness", async () => {
	assert.equal(externalHoldsReady("session"), true);
	const s = instance();
	await s.start();
	hold("another-session", "foreign");
	assert.equal(externalHoldsReady(s.parent), true);
	const first = hold(s.parent, "first");
	const second = hold(s.parent, "second");
	assert.equal(externalHoldsReady(s.parent), false);
	first.ready = true;
	assert.equal(externalHoldsReady(s.parent), false);
	second.ready = true;
	assert.equal(externalHoldsReady(s.parent), true);
	table().hosts.delete(s.parent);
	assert.equal(externalHoldsReady(s.parent), true, "host absence cannot unready an observed terminal");
});

test("malformed tables/current rows fail closed without host repair or overwrite", async () => {
	for (const value of [null, {}, { version: 2, hosts: new Map(), holds: new Map() }]) {
		shared[KEY] = value;
		assert.equal(externalHoldsReady("session"), false);
		const s = instance();
		await assert.rejects(s.start(), /completion/);
		assert.equal(shared[KEY], value);
	}
	delete shared[KEY];
	const s = instance();
	await s.start();
	for (const row of [null, { provider: "", ready: true }, { provider: "x", ready: "true" }, { provider: "x" }]) {
		table().holds.set(s.parent, new Map([["bad", row as never]]));
		assert.equal(externalHoldsReady(s.parent), false);
	}
	table().holds.set(s.parent, [] as never);
	assert.equal(externalHoldsReady(s.parent), false);
	table().holds.delete(s.parent);
	table().hosts.set(s.parent, new Map([["pi-squire", ""]]));
	assert.equal(externalHoldsReady(s.parent), false);
});

test("shutdown removes own token even when another table field has become corrupt", async () => {
	const s = instance();
	await s.start();
	const hosts = table().hosts;
	shared[KEY] = { version: 2, hosts, holds: null };
	await s.shutdown();
	assert.equal(hosts.has(s.parent), false);
	assert.equal(externalHoldsReady(s.parent), false);
});

test("reload retains accepted holds and owed work without an early reply from replacement startup", async () => {
	const parent = mail();
	await parent.start();
	const launched = await parent.toolCall("delegate", { agent: "worker", task: "finish held operation" });
	const id = (launched.structuredContent as { id: string }).id;
	const requestId = parent.entries.findLast(({ data }) => data.id === id)?.data.requestId;
	assert.ok(typeof requestId === "string");
	// Claiming mail moves it from new/ to cur/ without changing reply identity.
	const replies = () =>
		[...envelopes(parent.parent, "new"), ...envelopes(parent.parent, "cur")].filter(
			(entry) => entry.from === id && entry.to === parent.parent && entry.in_reply_to.includes(requestId),
		);
	const child = mail({ parent: id, tmux: parent.tmux });
	await child.start();
	scan(child);
	const row = hold(id, "unobserved");
	await child.run();
	await child.fire("session_shutdown", { reason: "reload" });
	const replacement = mail({ parent: id, tmux: parent.tmux });
	await replacement.start();
	assert.equal(table().holds.get(id)?.get("unobserved"), row);
	await replacement.run();
	scan(parent);
	assert.equal(replies().length, 0);
	assert.notEqual(readTree(parent.parent).entries.find((entry) => entry.id === id)?.finished, true);
	assert.equal(replacement.shutdowns(), 0);
	row.ready = true;
	await replacement.run();
	scan(parent); // Deterministically exercise the claimed location, not watcher timing.
	const received = replies();
	assert.equal(received.length, 1);
	const reply = received[0];
	assert.ok(reply);
	assert.deepEqual(reply.in_reply_to, [requestId]);
	assert.equal(reply.body, "answer");
	assert.equal(reply.status, "done");
	assert.equal(
		envelopes(parent.parent, "new").some((entry) => entry.id === reply.id),
		false,
	);
	scan(parent);
	assert.deepEqual(
		replies().map((entry) => entry.id),
		[reply.id],
	);
	assert.equal(replacement.shutdowns(), 1);
});

for (const autoExit of [true, false]) {
	test(`real task/child callbacks auto_exit=${autoExit}: holds gate reply, tree terminal and shutdown`, async () => {
		writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: String(autoExit) }));
		const parent = mail();
		await parent.start();
		const launched = await parent.toolCall("delegate", { agent: "worker", task: "own background work" });
		const id = (launched.structuredContent as { id: string }).id;
		const child = mail({ parent: id, tmux: parent.tmux });
		await child.start();
		scan(child);
		const first = hold(id, "running");
		const second = hold(id, "terminal-unobserved");
		const state = () => readTree(parent.parent).entries.find((entry) => entry.id === id);
		const replies = () =>
			[...envelopes(parent.parent, "new"), ...envelopes(parent.parent, "cur")].filter(
				(entry) => entry.in_reply_to.length,
			);
		await child.run();
		assert.equal(replies().length, 0);
		assert.notEqual(state()?.finished, true);
		assert.equal(child.shutdowns(), 0);
		first.ready = true;
		await child.run("error");
		assert.equal(replies().length, 0);
		assert.notEqual(state()?.finished, true);
		assert.equal(child.shutdowns(), 0);
		// Provider owns observation: queued/unseen and error candidates stay false.
		await child.run();
		assert.equal(replies().length, 0);
		second.ready = true; // terminal observed and committed by the provider's normal agent_end
		await child.run();
		assert.equal(replies().length, 1);
		assert.equal(replies()[0].body, "answer");
		assert.equal(state()?.finished, true);
		assert.equal(child.shutdowns(), autoExit ? 1 : 0);
		if (!autoExit) {
			await child.run();
			assert.equal(replies().length, 1, "terminal observation produces one correlated reply only");
		}
		assert.equal(child.continuations.length, 0, "a hold never adds model continue loops");
	});
}

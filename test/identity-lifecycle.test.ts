import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createIdentity, type Identity, type IdentityNotification, writeIdentity } from "../src/identity.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const saved: Identity = {
	parent: "coordinator-id",
	root: "root-id",
	rootPlacement: "test-delegate-session",
	agent: "worker",
	chain: ["coordinator", "worker"],
	depth: 2,
	autoExit: false,
};
const identityPath = (id: string) => join(agentDir, "squire", "identity", `${encodeURIComponent(id)}.json`);

/** Only the identity lifecycle, with Pi's actual bus and synchronous start handler. */
function lifecycle() {
	const events = createEventBus();
	let start: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined;
	const pi = {
		events,
		on: (name: string, handler: typeof start) => {
			assert.equal(name, "session_start");
			start = handler;
		},
	} as unknown as ExtensionAPI;
	const identity = createIdentity(pi);
	const seen: IdentityNotification[] = [];
	const notes: string[] = [];
	events.on("squire:identity", (payload) => {
		seen.push(payload as IdentityNotification);
	});
	return {
		identity,
		events,
		seen,
		notes,
		start: (id: string) =>
			start?.({ type: "session_start" }, {
				sessionManager: { getSessionId: () => id },
				ui: { notify: (message: string) => notes.push(message) },
			} as unknown as ExtensionContext),
	};
}

test("same-id no-env reopen emits the persisted delegate projection on every restore", () => {
	writeIdentity("worker-id", saved);
	const s = lifecycle();
	s.start("worker-id");
	assert.deepEqual(s.seen, [
		{
			sessionId: "worker-id",
			status: "delegate",
			identity: { parent: saved.parent, root: saved.root, agent: saved.agent, chain: saved.chain, depth: 2 },
		},
	]);
	assert.deepEqual(s.identity.current(), saved);
	s.start("worker-id");
	assert.equal(s.seen.length, 2);
	assert.notEqual(s.seen[0], s.seen[1]);
	assert.deepEqual(s.seen[0], s.seen[1]);
	assert.deepEqual(s.notes, []);
});

test("absent exact-id state clears a prior delegate regardless of inherited launch labels", () => {
	writeIdentity("worker-id", saved);
	const s = lifecycle();
	s.start("worker-id");
	process.env.PI_DELEGATE_PARENT = saved.parent;
	process.env.PI_DELEGATE_ROOT = saved.root;
	process.env.PI_DELEGATE_AGENT = saved.agent;
	process.env.PI_DELEGATE_CHAIN = JSON.stringify(saved.chain);
	for (const id of ["new-id", "fork-id", "ordinary-root-id"]) {
		s.start(id);
		assert.equal(s.identity.current(), undefined);
		assert.deepEqual(s.seen.at(-1), { sessionId: id, status: "root" });
	}
});

test("notification is deeply frozen, detached, and exposes no internal identity fields", () => {
	writeIdentity("worker-id", saved);
	const s = lifecycle();
	s.start("worker-id");
	const snapshot = s.seen[0];
	assert.ok(Object.isFrozen(snapshot));
	assert.equal(snapshot.status, "delegate");
	if (snapshot.status !== "delegate") throw new Error("expected delegate");
	assert.deepEqual(Object.keys(snapshot.identity).sort(), ["agent", "chain", "depth", "parent", "root"]);
	assert.ok(Object.isFrozen(snapshot.identity));
	assert.ok(Object.isFrozen(snapshot.identity.chain));
	assert.equal(Reflect.set(snapshot, "status", "root"), false);
	assert.equal(Reflect.set(snapshot.identity, "root", "other"), false);
	assert.equal(Reflect.set(snapshot.identity.chain, "0", "other"), false);
	const internal = s.identity.current();
	assert.ok(internal);
	internal.chain.push("internal-only");
	internal.root = "changed-internally";
	assert.deepEqual(snapshot.identity.chain, saved.chain);
	assert.equal(snapshot.identity.root, saved.root);
});

for (const [name, content] of [
	["corrupt JSON", "{"],
	["invalid identity", JSON.stringify({ ...saved, parent: "" })],
	["invalid placement", JSON.stringify({ ...saved, rootPlacement: null })],
] as const) {
	test(`${name} emits invalid without stale identity or raw errors`, () => {
		writeIdentity("worker-id", saved);
		const s = lifecycle();
		s.start("worker-id");
		writeFileSync(identityPath("worker-id"), content);
		s.start("worker-id");
		assert.deepEqual(s.seen.at(-1), { sessionId: "worker-id", status: "invalid" });
		assert.ok(Object.isFrozen(s.seen.at(-1)));
		assert.throws(() => s.identity.current());
		assert.equal(s.notes.length, 1);
	});
}

test("read and persistence failures emit invalid before reporting the existing restore error", () => {
	writeIdentity("worker-id", saved);
	const s = lifecycle();
	s.start("worker-id");
	// A directory at the atomic temporary filename deterministically refuses the write,
	// even when tests run as a user that can bypass file permission bits.
	const temporary = `${identityPath("worker-id")}.${process.pid}.tmp`;
	mkdirSync(temporary);
	s.start("worker-id");
	assert.deepEqual(s.seen.at(-1), { sessionId: "worker-id", status: "invalid" });
	assert.throws(() => s.identity.current());
	rmSync(temporary, { recursive: true });
	rmSync(identityPath("worker-id"));
	mkdirSync(identityPath("worker-id"));
	s.start("worker-id");
	assert.deepEqual(s.seen.at(-1), { sessionId: "worker-id", status: "invalid" });
	assert.throws(() => s.identity.current());
	rmSync(identityPath("worker-id"), { recursive: true });
	s.start("worker-id");
	assert.deepEqual(s.seen.at(-1), { sessionId: "worker-id", status: "root" });
	assert.equal(s.identity.current(), undefined);
});

test("synchronous observation finishes before start returns; async listener work is not awaited", async () => {
	writeIdentity("worker-id", saved);
	const s = lifecycle();
	const order: string[] = [];
	s.events.on("squire:identity", async () => {
		order.push("notification");
		await Promise.resolve();
		order.push("async-tail");
	});
	s.start("worker-id");
	order.push("provider-like-activation");
	assert.deepEqual(order, ["notification", "provider-like-activation"]);
	await Promise.resolve();
	assert.deepEqual(order, ["notification", "provider-like-activation", "async-tail"]);
});

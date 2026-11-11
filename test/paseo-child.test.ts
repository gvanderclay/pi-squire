import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createIdentity,
	type Identity,
	type IdentityNotification,
	readIdentity,
	writeIdentity,
} from "../src/identity.ts";
import { PASEO_TOOLS_ENV, PASEO_TRUST_ENV, registerPaseoChild } from "../src/paseo-child.ts";
import { cleanup, resetRoot } from "./harness.ts";

/** The agent id Paseo chose and exported to the child it started. */
const AGENT = "6f1d2c3b-4a59-4e8f-9b7c-5d3e2f1a0b9c";
/** The session id Paseo, not pi-squire, assigned to that child. */
const SESSION = "session-chosen-by-paseo";
const LAUNCH: Identity = {
	parent: "coordinator",
	root: "coordinator",
	rootPlacement: "test-delegate-session",
	agent: "worker",
	chain: ["coordinator", "worker"],
	depth: 1,
	autoExit: false,
};
const INVENTORY = [
	"read",
	"bash",
	"edit",
	"write",
	"todo_read",
	"todo_write",
	"delegate",
	"delegation_status",
	"delegation_close",
];
/** What `/delegate` would have activated in a child that grants one delegation tool. */
const STARTED = ["read", "bash", "edit", "write", "delegate"];

/** The variables this file sets, restored after each test so nothing leaks into other files. */
const SAVED = {
	agent: process.env.PASEO_AGENT_ID,
	cwd: process.env.PASEO_AGENT_CWD,
	tools: process.env[PASEO_TOOLS_ENV],
	trust: process.env[PASEO_TRUST_ENV],
};

function put(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	resetRoot();
	put("PASEO_AGENT_ID", undefined);
	put("PASEO_AGENT_CWD", undefined);
	put(PASEO_TOOLS_ENV, undefined);
	put(PASEO_TRUST_ENV, undefined);
});

afterEach(() => {
	put("PASEO_AGENT_ID", SAVED.agent);
	put("PASEO_AGENT_CWD", SAVED.cwd);
	put(PASEO_TOOLS_ENV, SAVED.tools);
	put(PASEO_TRUST_ENV, SAVED.trust);
});

/** Throwaway folders the trust tests created, removed when this file finishes. */
const TEMPS: string[] = [];

/** A real folder plus a symlink naming it, both under one throwaway directory. */
function folder(): { real: string; link: string } {
	const dir = mkdtempSync(join(tmpdir(), "squire-paseo-cwd-"));
	TEMPS.push(dir);
	const real = join(dir, "work");
	mkdirSync(real);
	const link = join(dir, "link");
	symlinkSync(real, link);
	return { real, link };
}

after(() => {
	for (const dir of TEMPS) rmSync(dir, { recursive: true, force: true });
	cleanup();
});

/** The identity lifecycle alone, on Pi's own bus, as `test/identity-lifecycle.test.ts` runs it. */
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
	events.on("squire:identity", (payload) => {
		seen.push(payload as IdentityNotification);
	});
	const begin = (id: string): void => {
		start?.({ type: "session_start" }, {
			sessionManager: { getSessionId: () => id },
			ui: { notify: () => {} },
		} as unknown as ExtensionContext);
	};
	return { identity, seen, begin };
}

/** A child Pi with a fixed tool inventory and one active list to change. */
function child(active: readonly string[] = STARTED) {
	type Handler = (event: unknown) => unknown;
	const handlers: Record<string, Handler[]> = {};
	const writes: string[][] = [];
	let activeTools = [...active];
	const pi = {
		on: (name: string, handler: Handler) => {
			(handlers[name] ??= []).push(handler);
		},
		getAllTools: () => INVENTORY.map((name) => ({ name })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			writes.push([...names]);
			activeTools = [...names];
		},
	};
	registerPaseoChild(pi as unknown as ExtensionAPI);
	return {
		/** Every `pi.setActiveTools` call, in order. */
		writes,
		active: (): string[] => [...activeTools],
		/** Another extension adding a tool back after `session_start`, as the measured Paseo child does. */
		restore: (name: string): void => {
			activeTools = [...activeTools, name];
		},
		fire: async (name: string, event: object = {}): Promise<unknown[]> => {
			const results: unknown[] = [];
			for (const handler of handlers[name] ?? []) results.push(await handler({ type: name, ...event }));
			return results;
		},
	};
}

test("a Paseo child adopts the launch record filed under its agent id and re-files it", () => {
	writeIdentity(AGENT, LAUNCH);
	process.env.PASEO_AGENT_ID = AGENT;
	const s = lifecycle();
	s.begin(SESSION);
	assert.deepEqual(s.identity.current(), LAUNCH);
	assert.deepEqual(readIdentity(SESSION), LAUNCH);
	assert.deepEqual(s.seen, [
		{
			sessionId: SESSION,
			status: "delegate",
			identity: {
				parent: LAUNCH.parent,
				root: LAUNCH.root,
				agent: "worker",
				chain: ["coordinator", "worker"],
				depth: 1,
			},
		},
	]);
});

test("a child without PASEO_AGENT_ID stays a root", () => {
	writeIdentity(AGENT, LAUNCH);
	const s = lifecycle();
	s.begin(SESSION);
	assert.equal(s.identity.current(), undefined);
	assert.equal(readIdentity(SESSION), undefined);
	assert.deepEqual(s.seen, [{ sessionId: SESSION, status: "root" }]);
});

test("a child whose PASEO_AGENT_ID is not a UUID reads no agent record", () => {
	writeIdentity("worker", LAUNCH);
	process.env.PASEO_AGENT_ID = "worker";
	const s = lifecycle();
	s.begin(SESSION);
	assert.equal(s.identity.current(), undefined);
	assert.equal(readIdentity(SESSION), undefined);
});

test("a Paseo child keeps the listed tools and the delegation tools it already had", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TOOLS_ENV] = "read";
	const c = child();
	await c.fire("session_start");
	assert.deepEqual(c.active(), ["read", "delegate"]);
});

test("a Paseo child expands patterns, trims entries and ignores empty ones", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TOOLS_ENV] = " read , todo_* ,";
	const c = child();
	await c.fire("session_start");
	assert.deepEqual(c.active(), ["read", "todo_read", "todo_write", "delegate"]);
});

test("an empty tool list leaves a Paseo child only its delegation tools", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TOOLS_ENV] = "";
	const c = child();
	await c.fire("session_start");
	assert.deepEqual(c.active(), ["delegate"]);
});

test("a Paseo child applies the list again when a tool comes back before a run", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TOOLS_ENV] = "read";
	const c = child();
	await c.fire("session_start");
	c.restore("bash");
	await c.fire("before_agent_start");
	assert.deepEqual(c.active(), ["read", "delegate"]);
	assert.equal(c.writes.length, 2);
});

test("a Paseo child blocks a call outside its list and allows one inside", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TOOLS_ENV] = "read";
	const c = child();
	assert.deepEqual(await c.fire("tool_call", { toolName: "bash", toolCallId: "call-1", input: {} }), [
		{ block: true, reason: "bash is not in this delegate's tool list" },
	]);
	assert.deepEqual(await c.fire("tool_call", { toolName: "read", toolCallId: "call-2", input: {} }), [undefined]);
	assert.deepEqual(await c.fire("tool_call", { toolName: "delegate", toolCallId: "call-3", input: {} }), [undefined]);
});

test("a child with no PI_DELEGATE_PASEO_TOOLS changes no tool", async () => {
	process.env.PASEO_AGENT_ID = AGENT;
	const c = child();
	await c.fire("session_start");
	await c.fire("before_agent_start");
	assert.deepEqual(c.writes, []);
	assert.deepEqual(c.active(), STARTED);
	assert.deepEqual(await c.fire("tool_call", { toolName: "bash", toolCallId: "call-1", input: {} }), [undefined]);
});

test("a child with no PASEO_AGENT_ID changes no tool even with a list set", async () => {
	process.env[PASEO_TOOLS_ENV] = "read";
	const c = child();
	await c.fire("session_start");
	assert.deepEqual(c.writes, []);
	assert.deepEqual(c.active(), STARTED);
	assert.deepEqual(await c.fire("tool_call", { toolName: "bash", toolCallId: "call-1", input: {} }), [undefined]);
});

test("a Paseo child answers the trust question from its environment", async () => {
	const { real } = folder();
	process.env.PASEO_AGENT_ID = AGENT;
	process.env.PASEO_AGENT_CWD = real;
	const c = child();
	const ask = async (): Promise<unknown> => (await c.fire("project_trust", { cwd: real }))[0];
	process.env[PASEO_TRUST_ENV] = "yes";
	assert.deepEqual(await ask(), { trusted: "yes" });
	process.env[PASEO_TRUST_ENV] = "no";
	assert.deepEqual(await ask(), { trusted: "no" });
	put(PASEO_TRUST_ENV, undefined);
	assert.deepEqual(await ask(), { trusted: "undecided" });
	process.env[PASEO_TRUST_ENV] = "maybe";
	assert.deepEqual(await ask(), { trusted: "undecided" });
});

test("a Paseo child answers its own folder when a symlink names it", async () => {
	const { real, link } = folder();
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TRUST_ENV] = "yes";
	const c = child();
	const ask = async (cwd: string): Promise<unknown> => (await c.fire("project_trust", { cwd }))[0];
	process.env.PASEO_AGENT_CWD = real;
	assert.deepEqual(await ask(link), { trusted: "yes" });
	process.env.PASEO_AGENT_CWD = link;
	assert.deepEqual(await ask(real), { trusted: "yes" });
	process.env[PASEO_TRUST_ENV] = "no";
	assert.deepEqual(await ask(real), { trusted: "no" });
});

test("a Paseo child answers undecided for a folder other than the one it started in", async () => {
	const own = folder();
	const other = folder();
	process.env.PASEO_AGENT_ID = AGENT;
	process.env.PASEO_AGENT_CWD = own.real;
	process.env[PASEO_TRUST_ENV] = "yes";
	const c = child();
	assert.deepEqual((await c.fire("project_trust", { cwd: other.real }))[0], { trusted: "undecided" });
	process.env[PASEO_TRUST_ENV] = "no";
	assert.deepEqual((await c.fire("project_trust", { cwd: other.real }))[0], { trusted: "undecided" });
});

test("a Paseo child answers undecided when a folder cannot be resolved", async () => {
	const { real } = folder();
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TRUST_ENV] = "yes";
	const c = child();
	const gone = join(real, "gone");
	process.env.PASEO_AGENT_CWD = gone;
	assert.deepEqual((await c.fire("project_trust", { cwd: gone }))[0], { trusted: "undecided" });
	process.env.PASEO_AGENT_CWD = real;
	assert.deepEqual((await c.fire("project_trust", { cwd: gone }))[0], { trusted: "undecided" });
});

test("a Paseo child with no PASEO_AGENT_CWD answers undecided", async () => {
	const { real } = folder();
	process.env.PASEO_AGENT_ID = AGENT;
	process.env[PASEO_TRUST_ENV] = "yes";
	const c = child();
	assert.deepEqual((await c.fire("project_trust", { cwd: real }))[0], { trusted: "undecided" });
});

test("a child without PASEO_AGENT_ID leaves the trust decision to Pi", async () => {
	const { real } = folder();
	process.env.PASEO_AGENT_CWD = real;
	process.env[PASEO_TRUST_ENV] = "yes";
	const c = child();
	assert.deepEqual((await c.fire("project_trust", { cwd: real }))[0], { trusted: "undecided" });
});

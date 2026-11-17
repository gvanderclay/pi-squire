// Rex companion ownership and acquisition: receipts, numbering, races and
// failure accounting. The wire is the deterministic multi-session fixture; the
// process tests use a separate-process driver so contention is real.
import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { WindowOpenError, type WindowSpec } from "../src/host.ts";
import { writeState } from "../src/local-state.ts";
import { companionStatePath, createRexCompanions } from "../src/rex-companions.ts";
import { rexLocator } from "../src/rex-locator.ts";
import type { WindowPlacement } from "../src/window-placement.ts";
import { askWindowStates } from "../src/window-state.ts";
import { cleanup, resetRoot, root } from "./harness.ts";
import { RexWire } from "./rex-adapter-fixture.ts";

const wires: RexWire[] = [];
beforeEach(resetRoot);
after(async () => {
	for (const wire of wires) wire.dispose();
	await cleanup();
});
function wire(options: ConstructorParameters<typeof RexWire>[0] = {}): RexWire {
	const value = new RexWire(options);
	wires.push(value);
	return value;
}
const spec = (name = "worker"): WindowSpec => ({
	name,
	cwd: process.cwd(),
	argv: [process.execPath, "unused"],
	env: {},
});
async function open(wire: RexWire, base: string, placement: WindowPlacement = "companion") {
	const opened = await wire.client.openWindow(spec(), placement, base);
	const own = rexLocator(opened.locator);
	if (!own) throw new Error("missing Rex locator");
	wire.staged.push(dirname(own.launchFile));
	return own;
}
async function refuses(promise: Promise<unknown>, pattern: RegExp): Promise<WindowOpenError> {
	const error = await promise.then(
		() => assert.fail("expected a refusal"),
		(value: unknown) => value,
	);
	assert.ok(error instanceof WindowOpenError, String(error));
	assert.equal(error.certainty, "not-opened");
	assert.match(error.message, pattern);
	return error;
}
const created = (wire: RexWire) =>
	wire.calls.filter((call) => call.args[0] === "api" && call.args[2] === "session.create");
const windows = (wire: RexWire) => wire.calls.filter((call) => call.args[0] === "window" && call.args[1] === "new");
function seed(wire: RexWire, base: string, value: unknown): string {
	const path = companionStatePath(wire.agentDir, wire.context.server, base);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

test("a companion is created empty, then holds one full delegate window; later launches reuse it", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	assert.equal(created(r).length, 1);
	assert.deepEqual(JSON.parse(created(r)[0].args[3]), { label: "project-delegates" });
	const companion = r.sessions.get(first.session);
	assert.ok(companion);
	assert.equal(companion.label, "project-delegates");
	assert.equal(companion.blocks.size, 1, "exactly one delegate tab, no unused shell tab");
	assert.equal(r.session.blocks.size, 1, "the caller session keeps only its own block");
	assert.equal(windows(r).length, 1);
	assert.equal(windows(r)[0].args[3], first.session, "the window targets the exact created id");
	const second = await open(r, "project-delegates");
	assert.equal(second.session, first.session);
	assert.equal(created(r).length, 1, "a proved companion is reused, not recreated");
	assert.equal(companion.blocks.size, 2);
	assert.deepEqual(r.receipts("project-delegates"), [{ session: first.session, createdLabel: "project-delegates" }]);
});

test("current placement opens in the caller session and never touches companion storage", async () => {
	const r = wire();
	const path = seed(r, "project-delegates", "{not json");
	const own = await open(r, "project-delegates", "current");
	assert.equal(own.session, r.context.session);
	assert.equal(
		r.calls.some((call) => call.args[0] === "api"),
		false,
		"no session list or create",
	);
	assert.equal(r.sessions.size, 1);
	const refusal = await refuses(open(r, "project-delegates", "companion"), /could not read Rex companion state/);
	assert.ok(refusal.message.includes(path), "the refusal names the state file to repair");
});

test("an occupied base and an unproved numbered name are skipped, never adopted", async () => {
	const r = wire();
	r.addSession("project-delegates");
	r.addSession("project-delegates-2");
	const own = await open(r, "project-delegates");
	assert.equal(r.sessions.get(own.session)?.label, "project-delegates-3");
	assert.deepEqual(
		r.receipts("project-delegates").map((receipt) => receipt.createdLabel),
		["project-delegates-3"],
	);
	assert.equal(r.sessions.size, 4);
});

test("a proved numbered companion is preferred even after a lower name becomes free", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const companion = r.sessions.get(first.session);
	assert.ok(companion);
	// The user renames the proved companion within its own numbered family.
	companion.label = "project-delegates-3";
	r.addSession("project-delegates");
	const second = await open(r, "project-delegates");
	assert.equal(second.session, first.session);
	assert.equal(created(r).length, 1);
	// The lower name is free again; the proved candidate still wins.
	r.removeSession("project-delegates");
	const third = await open(r, "project-delegates");
	assert.equal(third.session, first.session);
	assert.equal(created(r).length, 1);
});

test("duplicate labels neither authorize an unproved id nor collapse two sessions", async () => {
	const r = wire();
	const one = r.addSession("project-delegates");
	const two = r.addSession("project-delegates");
	const own = await open(r, "project-delegates");
	assert.notEqual(own.session, one.id);
	assert.notEqual(own.session, two.id);
	assert.equal(r.sessions.get(own.session)?.label, "project-delegates-2");
	assert.equal(one.blocks.size, 0);
	assert.equal(two.blocks.size, 0);
	assert.deepEqual(
		r.receipts("project-delegates").map((receipt) => receipt.session),
		[own.session],
	);
});

test("a deleted receipted id replaced by the same label is not adopted", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	r.removeSession(first.session);
	const impostor = r.addSession("project-delegates");
	const second = await open(r, "project-delegates");
	assert.notEqual(second.session, impostor.id, "a live label is not proof of ownership");
	assert.equal(r.sessions.get(second.session)?.label, "project-delegates-2");
	assert.equal(impostor.blocks.size, 0);
	assert.deepEqual(
		r.receipts("project-delegates").map((receipt) => receipt.session),
		[first.session, second.session],
	);
});

test("a companion renamed outside its family is left alone for new placement, and its delegate still works", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const companion = r.sessions.get(first.session);
	assert.ok(companion);
	companion.label = "unrelated-work";
	const second = await open(r, "project-delegates");
	assert.notEqual(second.session, first.session);
	assert.equal(r.sessions.get(second.session)?.label, "project-delegates");
	assert.equal(companion.label, "unrelated-work", "the rename is never undone");
	// The known delegate is still observed, peeked and closed by its exact ids.
	const record = { locator: { ...first, name: "worker" } };
	const states = await askWindowStates(r.client);
	assert.equal(states.state(record), "running");
	assert.match(await r.client.peek({ windowId: first.window, locator: record.locator }), /SQUIRE-ADAPTER-SCREEN/);
	assert.equal(await states.close(record), true);
	assert.equal(companion.blocks.has(first.block), false);
});

test("malformed, unreadable and unwritable state refuses without a session or window", async () => {
	const r = wire();
	const path = seed(r, "project-delegates", {
		version: 2,
		server: r.context.server,
		base: "project-delegates",
		receipts: [],
	});
	await refuses(open(r, "project-delegates"), /unusable: its version is not 1/);
	assert.equal(created(r).length, 0);
	assert.equal(windows(r).length, 0);
	writeFileSync(path, "{not json");
	await refuses(open(r, "project-delegates"), /could not read Rex companion state/);
	assert.equal(created(r).length, 0);
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			server: r.context.server,
			base: "project-delegates",
			receipts: [
				{ session: "session:one", createdLabel: "project-delegates" },
				{ session: "session:one", createdLabel: "x" },
			],
		}),
	);
	await refuses(open(r, "project-delegates"), /two receipts name the same session id/);
	seed(r, "project-delegates", { version: 1, server: r.context.server, base: "project-delegates", receipts: [] });
	r.writeState = () => {
		throw new Error("disk full");
	};
	await refuses(open(r, "project-delegates"), /could not write Rex companion state.*disk full/);
	assert.equal(created(r).length, 0);
});

test("an overlong companion label refuses before any session or window exists", async () => {
	const r = wire();
	const base = "a".repeat(129);
	await refuses(open(r, base), /longer than Rex's 128-character limit/);
	assert.equal(
		r.calls.some((call) => call.args[0] === "api" && call.args[2] === "session.create"),
		false,
	);
	assert.equal(windows(r).length, 0);
	// Exactly 128 characters is Rex's documented maximum and is allowed.
	const longest = await open(r, "b".repeat(128));
	assert.equal(r.sessions.get(longest.session)?.label, "b".repeat(128));
});

test("receipts are scoped to one agent directory and one exact endpoint", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const otherDir = join(root, "agent-other");
	const other = createRexCompanions({
		run: (route, args) => r.run(route, args),
		agentDir: () => otherDir,
	});
	const acquired = await other.acquire({ server: r.context.server }, "project-delegates");
	assert.notEqual(acquired.session, first.session, "another directory never adopts an unproved session");
	assert.equal(acquired.label, "project-delegates-2");
	assert.deepEqual(other.receipts({ server: r.context.server }, "project-delegates"), [
		{ session: acquired.session, createdLabel: "project-delegates-2" },
	]);
	assert.deepEqual(r.receipts("project-delegates"), [{ session: first.session, createdLabel: "project-delegates" }]);
	// A different endpoint is a different ownership scope.
	assert.notEqual(
		companionStatePath(r.agentDir, r.context.server, "project-delegates"),
		companionStatePath(r.agentDir, "unix:///other.sock", "project-delegates"),
	);
	assert.deepEqual(other.receipts({ server: "unix:///other.sock" }, "project-delegates"), []);
});

test("a live pending claim refuses acquisition without creating a session", async () => {
	const r = wire();
	seed(r, "project-delegates", {
		version: 1,
		server: r.context.server,
		base: "project-delegates",
		receipts: [],
		pending: { token: "claim", pid: process.pid, label: "" },
	});
	await refuses(open(r, "project-delegates"), /companion acquisition busy; retry/);
	assert.equal(created(r).length, 0);
	assert.equal(windows(r).length, 0);
});

test("a dead claim is replaced and its leaked empty session is skipped, never adopted", async () => {
	const r = wire();
	const leaked = r.addSession("project-delegates");
	r.alive = () => false;
	seed(r, "project-delegates", {
		version: 1,
		server: r.context.server,
		base: "project-delegates",
		receipts: [],
		pending: { token: "dead-claim", pid: 999_999, label: "project-delegates" },
	});
	const own = await open(r, "project-delegates");
	assert.notEqual(own.session, leaked.id);
	assert.equal(r.sessions.get(own.session)?.label, "project-delegates-2");
	assert.equal(leaked.blocks.size, 0, "the leaked empty session is untouched");
	assert.deepEqual(
		r.receipts("project-delegates").map((receipt) => receipt.session),
		[own.session],
	);
});

test("a receipt commit failure starts no delegate window and leaves an unowned empty session", async () => {
	const r = wire();
	r.writeState = (path, state) => {
		if (((state as { receipts?: unknown[] }).receipts?.length ?? 0) > 0) throw new Error("disk full");
		writeState(path, state);
	};
	await refuses(open(r, "project-delegates"), /could not write Rex companion state.*disk full/);
	assert.equal(windows(r).length, 0, "no delegate window was requested");
	const leaked = [...r.sessions.values()].filter((session) => session.label === "project-delegates");
	assert.equal(leaked.length, 1);
	assert.equal(leaked[0].blocks.size, 0, "the empty session is left alone");
	r.writeState = writeState;
	const own = await open(r, "project-delegates");
	assert.equal(r.sessions.get(own.session)?.label, "project-delegates-2", "the unproved session is skipped");
	assert.deepEqual(
		r.receipts("project-delegates").map((receipt) => receipt.session),
		[own.session],
	);
});

test("a lost empty-create acknowledgement starts no delegate window and reports the residue", async () => {
	const r = wire();
	r.lostCreateAck = true;
	await refuses(open(r, "project-delegates"), /empty session may remain/);
	assert.equal(windows(r).length, 0);
	assert.equal([...r.sessions.values()].filter((session) => session.label === "project-delegates").length, 1);
	r.lostCreateAck = false;
	const own = await open(r, "project-delegates");
	assert.equal(r.sessions.get(own.session)?.label, "project-delegates-2");
});

test("a lost window acknowledgement is unknown and is never retried or cleaned up", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	r.ambiguous = true;
	const error = await open(r, "project-delegates").then(
		() => assert.fail("expected an unknown outcome"),
		(value: unknown) => value,
	);
	assert.ok(error instanceof WindowOpenError);
	assert.equal(error.certainty, "unknown");
	assert.equal(windows(r).length, 2, "exactly one window request per open");
	assert.equal(r.sessions.get(first.session)?.blocks.size, 2, "the shared session and its blocks are kept");
	assert.equal(
		r.calls.some((call) => call.args[0] === "window" && call.args[1] === "close"),
		false,
	);
	assert.equal(
		r.calls.some((call) => call.args[0] === "api" && call.args[2] === "session.destroy"),
		false,
	);
});

test("a companion session that disappears before dispatch fails safely without a retry", async () => {
	const r = wire();
	const run = r.run.bind(r);
	let removed: string | undefined;
	r.run = async (route, args) => {
		if (args[0] === "window" && args[1] === "new" && removed === undefined) {
			removed = args[3];
			r.sessions.delete(removed);
		}
		return run(route, args);
	};
	const error = await open(r, "project-delegates").then(
		() => assert.fail("expected an unknown outcome"),
		(value: unknown) => value,
	);
	assert.ok(error instanceof WindowOpenError);
	assert.equal(error.certainty, "unknown", "a dispatched request is never retried");
	assert.equal(windows(r).length, 1);
	assert.equal(
		r.calls.some((call) => call.args[0] === "api" && call.args[2] === "session.destroy"),
		false,
	);
});

test("a failed window creation preserves the shared session and user blocks", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const companion = r.sessions.get(first.session);
	assert.ok(companion);
	companion.blocks.set("block:user", {
		block_id: "block:user",
		window_id: first.window,
		label: "shell",
		placement: "placed",
	});
	r.failWindowNew = "window limit reached";
	const error = await open(r, "project-delegates").then(
		() => assert.fail("expected an unknown outcome"),
		(value: unknown) => value,
	);
	assert.ok(error instanceof WindowOpenError);
	assert.equal(error.certainty, "unknown");
	assert.match(error.message, /window limit reached/);
	assert.equal(r.sessions.get(first.session)?.label, "project-delegates");
	assert.equal(companion.blocks.has("block:user"), true);
	assert.equal(companion.blocks.has(first.block), true);
	assert.equal(
		r.calls.some((call) => call.args[0] === "api" && call.args[2] === "session.destroy"),
		false,
	);
});

test("a session that disappears between observation and close is gone, not an error", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const record = { locator: { ...first, name: "worker" } };
	const states = await askWindowStates(r.client);
	assert.equal(states.state(record), "running");
	// The whole companion session vanishes after the observation.
	r.removeSession(first.session);
	assert.equal(await states.close(record), false, "a successful list that omits it proves it gone");
	// A transport failure is still unknown, never gone.
	const second = await open(r, "project-delegates");
	const again = await askWindowStates(r.client);
	r.failedAsk = true;
	await assert.rejects(again.close({ locator: { ...second, name: "worker" } }));
	assert.equal(r.sessions.get(second.session)?.blocks.has(second.block), true);
});

test("a failed per-session block query is unknown and never permits a close", async () => {
	const r = wire();
	const first = await open(r, "project-delegates");
	const companion = r.sessions.get(first.session);
	assert.ok(companion);
	companion.failBlocks = true;
	const record = { locator: { ...first, name: "worker" } };
	const states = await askWindowStates(r.client);
	assert.equal(states.answered, true, "the session list answered");
	assert.equal(states.state(record), "unknown");
	assert.equal(states.listed(record), false);
	await assert.rejects(states.close(record), /could not read that Rex session's blocks/);
	assert.equal(companion.blocks.has(first.block), true);
	companion.failBlocks = false;
	assert.equal(await (await askWindowStates(r.client)).close(record), true);
});

// ---- Separate-process contention and crash recovery. ----

type Reply = { key: number; result?: unknown; error?: string; ready?: boolean; gated?: string };
class CompanionProcess {
	readonly child: ChildProcess;
	private sequence = 0;
	private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly gates = new Map<string, () => void>();
	readonly ready: Promise<void>;
	constructor(directory: string) {
		this.child = fork(fileURLToPath(new URL("./fixtures/rex-companion-process.ts", import.meta.url)), [], {
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, SQUIRE_TEST_AGENT_DIR: directory },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		this.ready = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("fixture startup timed out")), 10_000);
			this.child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			this.child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("fixture exited before ready"));
			});
			this.child.on("message", (reply: Reply) => {
				if (reply.ready) {
					clearTimeout(timer);
					resolve();
					return;
				}
				if (reply.gated !== undefined) {
					this.gates.get(reply.gated)?.();
					this.gates.delete(reply.gated);
					return;
				}
				const request = this.waiting.get(reply.key);
				if (!request) return;
				this.waiting.delete(reply.key);
				if (reply.error !== undefined) request.reject(new Error(reply.error));
				else request.resolve(reply.result);
			});
		});
		this.child.once("exit", () => {
			for (const request of this.waiting.values()) request.reject(new Error("fixture process exited"));
			this.waiting.clear();
		});
	}
	async command<T = unknown>(op: string, args: Record<string, unknown>): Promise<T> {
		await this.ready;
		const key = ++this.sequence;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiting.delete(key);
				reject(new Error(`fixture timed out: ${op}`));
			}, 10_000);
			this.waiting.set(key, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.send({ key, op, ...args });
		});
	}
	/** Resolve once the child blocks inside the named Rex call. */
	gate(name: string): Promise<void> {
		return new Promise((resolve) => this.gates.set(name, resolve));
	}
	release(name: string): void {
		this.child.send({ release: name });
	}
	async kill(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			this.child.kill("SIGKILL");
		});
	}
}

const processes: CompanionProcess[] = [];
after(async () => {
	for (const fixture of processes.splice(0)) await fixture.kill();
});
function processFor(directory: string): CompanionProcess {
	const value = new CompanionProcess(directory);
	processes.push(value);
	return value;
}
function serverFile(): string {
	return join(mkdtempSync(join(root, "rex-server-")), "sessions.jsonl");
}
function sessionsIn(file: string): { session_id: string; label: string }[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as { session_id: string; label: string });
}

test("separate processes contend for one base: the live owner refuses the other, then its receipt is shared", async () => {
	const directory = join(root, "agent-process");
	const file = serverFile();
	const base = "project-delegates";
	const owner = processFor(directory);
	const contender = processFor(directory);
	const blocked = owner.gate("list");
	const first = owner.command<{ session: string; label: string }>("acquire", {
		agentDir: directory,
		server: "unix:///shared.sock",
		base,
		file,
		gate: "list",
	});
	await blocked;
	// The owner holds a live claim: the second process refuses instead of creating.
	await assert.rejects(
		contender.command("acquire", { agentDir: directory, server: "unix:///shared.sock", base, file }),
		/companion acquisition busy; retry/,
	);
	owner.release("list");
	const acquired = await first;
	assert.equal(acquired.label, base);
	const written = sessionsIn(file);
	assert.equal(written.length, 1, "exactly one session was created");
	assert.equal(acquired.session, written[0].session_id);
	// The receipt is durable: a later process reuses the same exact id.
	const reused = await contender.command<{ session: string; label: string }>("acquire", {
		agentDir: directory,
		server: "unix:///shared.sock",
		base,
		file,
	});
	assert.equal(reused.session, acquired.session);
	assert.equal(reused.label, base);
});

test("a killed owner's claim and leaked empty session are recovered without adoption", async () => {
	const directory = join(root, "agent-crash");
	const file = serverFile();
	const base = "project-delegates";
	const owner = processFor(directory);
	const leaked = owner.gate("create");
	const doomed = owner.command("acquire", {
		agentDir: directory,
		server: "unix:///shared.sock",
		base,
		file,
		gate: "create",
	});
	await leaked;
	await owner.kill();
	await assert.rejects(doomed, /fixture process exited/);
	// The dead owner's claim is replaced, and its unproved empty session skipped.
	const next = processFor(directory);
	const acquired = await next.command<{ session: string; label: string }>("acquire", {
		agentDir: directory,
		server: "unix:///shared.sock",
		base,
		file,
	});
	const written = sessionsIn(file);
	assert.equal(written.length, 2, "the leaked empty session remains");
	assert.equal(written[0].label, "project-delegates");
	assert.notEqual(acquired.session, written[0].session_id, "the leaked session is not adopted");
	assert.equal(acquired.label, "project-delegates-2");
	assert.equal(acquired.session, written[1].session_id);
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaseoWorkspace } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Value } from "typebox/value";
import { ChildTasks, readChildRecords } from "../src/child-tasks.ts";
import { cleanup as runCleanup } from "../src/cleanup.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { createPaseoApi, type PaseoApi, type PaseoProgress } from "../src/paseo-api.ts";
import { paseoLocator } from "../src/paseo-locator.ts";
import { restoreRecords } from "../src/result-restore.ts";
import { isStarted, type Recorded, START_TYPE } from "../src/result-types.ts";
import { AttemptSchema } from "../src/tracking-attempt.ts";
import { readTree, treeTransaction } from "../src/tree-registry.ts";
import type { PaseoReceipt } from "../src/worktree.ts";
import { fixture } from "./cleanup-fixture.ts";
import { agentDir, agentFile, cleanup, type Entry, resetRoot, root, session, writeAgent } from "./harness.ts";
import { FakePaseo } from "./paseo-fixture.ts";
import { TreeProcess } from "./tree-process-harness.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
});
after(cleanup);

test("the attempt schema passes through host recovery facts without opaque field declarations", () => {
	assert.equal("locator" in AttemptSchema.properties, false);
	assert.equal("paseo" in AttemptSchema.properties, false);
	assert.ok("additionalProperties" in AttemptSchema);
	assert.equal(AttemptSchema.additionalProperties, true);
	assert.equal(AttemptSchema.properties.sessionId.type, "string");
});

type Provenance = "created" | "opened" | "reused" | "unobserved";
type Boundary =
	| "workspace-ack"
	| "workspace-list"
	| "agent-ack"
	| "session-wait"
	| "session-assigned"
	| "configure"
	| "mail"
	| "record";
type WorkspaceList = Awaited<ReturnType<DaemonClient["fetchWorkspaces"]>>;

function partialApi(t: TestContext, source: string, mode: Provenance, boundary: Boundary) {
	const home: string = realpathSync(mkdtempSync(join(root, "daemon-")));
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ pid: process.pid, listen: "127.0.0.1:1" }));
	writeFileSync(join(home, "local-credential"), "test");
	const api: FakePaseo = new FakePaseo();
	const sdk: PaseoApi = createPaseoApi(home);
	const observed: PaseoProgress[] = [];
	let cwd = "";
	let agentId = "";
	let registered = false;
	const workspace = (): { id: string; workspaceDirectory: string; projectId: string } => ({
		id: "partial-workspace",
		workspaceDirectory: cwd,
		projectId: "project",
	});
	t.mock.method(DaemonClient.prototype, "connect", async () => {});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		if (boundary === "session-assigned" && observed.some((progress: PaseoProgress) => progress.sessionId))
			throw new Error("injected session-assigned");
	});
	t.mock.method(
		DaemonClient.prototype,
		"fetchWorkspaces",
		async (options?: { filter?: { includeBackground?: boolean } }) => {
			if (mode === "unobserved" && options?.filter?.includeBackground) throw new Error("snapshot unavailable");
			if (boundary === "workspace-list" && registered) throw new Error("injected workspace-list");
			return {
				entries: [
					...(mode === "opened" ? [] : [{ id: "main", workspaceDirectory: source, projectId: "project" }]),
					...(registered || mode === "reused" ? [workspace()] : []),
				],
				pageInfo: { hasMore: false },
			} as unknown as WorkspaceList;
		},
	);
	const placed = async (): Promise<{ workspace: ReturnType<typeof workspace>; error: null }> => {
		registered = true;
		api.workspaces.set("partial-workspace", {
			...workspace(),
			archivingAt: null,
			scripts: [],
		} as unknown as PaseoWorkspace);
		if (boundary === "workspace-ack") throw new Error("injected workspace-ack");
		return { workspace: workspace(), error: null };
	};
	t.mock.method(DaemonClient.prototype, "createWorkspace", placed);
	t.mock.method(DaemonClient.prototype, "openProject", placed);
	t.mock.method(DaemonClient.prototype, "createAgent", async () => {
		api.running.add(agentId);
		api.agents.push({ id: agentId, workspaceId: "partial-workspace", cwd });
		if (boundary === "agent-ack") throw new Error("injected agent-ack");
		return { id: agentId } as unknown as Awaited<ReturnType<DaemonClient["createAgent"]>>;
	});
	t.mock.method(DaemonClient.prototype, "fetchAgent", async () => {
		if (boundary === "session-wait") throw new Error("injected session-wait");
		return { agent: { id: agentId, runtimeInfo: { sessionId: "assigned-session" } } } as unknown as Awaited<
			ReturnType<DaemonClient["fetchAgent"]>
		>;
	});
	api.create = async (input: Parameters<PaseoApi["create"]>[0], sink?: Parameters<PaseoApi["create"]>[1]) => {
		cwd = input.cwd;
		agentId = input.agentId;
		return sdk.create(input, (progress: PaseoProgress) => {
			sink?.(progress);
			observed.push(structuredClone(progress));
		});
	};
	// A refused taskless close must preserve the receipt as well as the live resource.
	api.failRemove = true;
	return { api, observed, home, cwd: (): string => cwd };
}

test("a failed requested-locator journal write rolls back before any Paseo call", async (t) => {
	const f = fixture();
	const { api, observed, cwd } = partialApi(t, f.source, "created", "agent-ack");
	const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
	const s = session({ cwd: f.source, multiplexer: host });
	try {
		await s.start();
		const append = s.pi.appendEntry.bind(s.pi);
		let failed = false;
		t.mock.method(s.pi, "appendEntry", (kind: string, data: unknown) => {
			if (!failed && data && typeof data === "object" && "locator" in data) {
				failed = true;
				throw new Error("injected requested-locator storage failure");
			}
			append(kind, data);
		});
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "work", worktree: "pre-progress" }),
			/injected requested-locator storage failure.*outcome rolled-back/,
		);
		assert.equal(failed, true);
		assert.equal(cwd(), "", "the create API must not be called");
		assert.deepEqual(observed, []);
		assert.deepEqual(api.removals, []);
		const attempt = readChildRecords(s.parent).at(-1);
		assert.ok(attempt && !isStarted(attempt));
		assert.equal(attempt.attempt.phase, "rolled-back");
		assert.equal(existsSync(attempt.plan.destination), false);
		const tree = readTree(s.parent).entries.find((item) => item.id === attempt.id);
		assert.ok(tree);
		assert.equal(tree.phase, "not-started", "refund the pre-dispatch reservation");
		assert.equal(tree.createPending, false);
	} finally {
		await s.shutdown();
	}
});

test("a failed progress journal write stops launch and retains acknowledged placement", async (t) => {
	const f = fixture();
	const { api, home, cwd } = partialApi(t, f.source, "created", "agent-ack");
	const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
	const s = session({ cwd: f.source, multiplexer: host });
	try {
		await s.start();
		const append = s.pi.appendEntry.bind(s.pi);
		let failed = false;
		t.mock.method(s.pi, "appendEntry", (kind: string, data: unknown) => {
			if (!failed && data && typeof data === "object" && "paseo" in data) {
				failed = true;
				throw new Error("injected progress storage failure");
			}
			append(kind, data);
		});
		await assert.rejects(
			s.toolCall("delegate", { agent: "scout", task: "work", worktree: "progress" }),
			/injected progress storage failure/,
		);
		assert.equal(failed, true);
		assert.equal(api.running.size, 0, "agent dispatch must not follow a failed receipt write");
		assert.deepEqual(api.removals, []);
		assert.equal(existsSync(cwd()), true);
		const attempt = readChildRecords(s.parent).at(-1);
		assert.ok(attempt && !isStarted(attempt));
		assert.equal(attempt.attempt.phase, "retained");
		const tree = readTree(s.parent).entries.find((item) => item.id === attempt.id);
		assert.ok(tree);
		assert.equal(tree.phase, "dispatched", "post-daemon uncertainty keeps its reservation");
		assert.equal(tree.createPending, true);
		assert.deepEqual(attempt.paseo, {
			home,
			workspaceId: "partial-workspace",
			directory: cwd(),
			projectId: "project",
			provenance: "created",
		});
		await s.shutdown();
		const restored = session({ parent: s.parent, cwd: f.source, multiplexer: host, entries: s.entries });
		try {
			await restored.start();
			const record = readChildRecords(s.parent).find((item) => item.id === attempt.id);
			assert.ok(record && !isStarted(record));
			assert.deepEqual(record.paseo, attempt.paseo);
		} finally {
			await restored.shutdown();
		}
	} finally {
		await s.shutdown();
	}
});

test("a crashed opener restores created-phase attempts and preserves receipt-specific cleanup authority", async (t) => {
	for (const provenance of ["created", "opened", "reused"] as const) {
		await t.test(provenance, async () => {
			resetRoot();
			writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
			const f = fixture();
			const home = realpathSync(mkdtempSync(join(root, "crash-daemon-")));
			const receipt: PaseoReceipt = {
				home,
				workspaceId: "crash-workspace",
				directory: f.cwd,
				projectId: "project",
				provenance,
			};
			const parent = `crash-parent-${provenance}-${process.pid}`;
			const child = new TreeProcess(agentDir, "./fixtures/paseo-crash.ts");
			let checkpoint: { entries: Entry[]; cwd: string; id: string };
			try {
				checkpoint = await child.command("launch", { parent, source: f.source, receipt });
				const record = readChildRecords(parent).find((item) => item.id === checkpoint.id);
				assert.ok(record && !isStarted(record));
				assert.equal(record.attempt.phase, "created");
				assert.deepEqual(record.paseo, { ...receipt, directory: checkpoint.cwd });
			} finally {
				await child.kill();
			}
			assert.equal(child.child.signalCode, "SIGKILL", "no catch/finally launch rollback may run");
			const api = new FakePaseo();
			api.workspaces.set(receipt.workspaceId, {
				id: receipt.workspaceId,
				workspaceDirectory: checkpoint.cwd,
				projectId: receipt.projectId,
				archivingAt: null,
				scripts: [],
			} as unknown as PaseoWorkspace);
			const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
			const restored = session({ parent, cwd: f.source, multiplexer: host, entries: checkpoint.entries });
			try {
				await restored.start();
				const records = restoreRecords(restored.context as unknown as ExtensionContext, new ChildTasks());
				const record = records.find((item) => item.id === checkpoint.id);
				assert.ok(record && !isStarted(record));
				assert.equal(record.attempt.phase, "interrupted");
				assert.equal(record.attempt.phase === "interrupted" && record.attempt.lastPhase, "created");
				assert.deepEqual(record.paseo, { ...receipt, directory: checkpoint.cwd });
				assert.ok(paseoLocator(record.locator));
				assert.equal(record.sessionId, "crash-assigned-session");
				// Also prove restoration with the crash transcript as the only source.
				const path = join(agentDir, "squire", "child-tasks", `${parent}.json`);
				renameSync(path, `${path}.saved`);
				try {
					const transcript = restoreRecords(restored.context as unknown as ExtensionContext, new ChildTasks());
					assert.deepEqual(
						transcript.find((item) => item.id === checkpoint.id),
						record,
					);
				} finally {
					renameSync(`${path}.saved`, path);
				}
				const status = await restored.toolCall("delegation_status", { id: checkpoint.id });
				const details = status.structuredContent as { delegations: (Recorded & { state: string })[] };
				assert.equal(details.delegations[0].state, "interrupted");
				assert.deepEqual(details.delegations[0], { ...record, state: "interrupted" });
				assert.match(status.content[0].text, /Paseo recovery target:/);
				const schema = restored.tool("delegation_status").outputSchema;
				assert.ok(schema);
				assert.equal(Value.Check(schema, JSON.parse(JSON.stringify(status.structuredContent))), true);
				const result = await runCleanup(
					{ ids: [checkpoint.id] },
					{ host, assertActive: () => {}, gh: () => ({ ok: false, message: "absent" }), paseoApi: () => api },
					restored.context as unknown as ExtensionContext,
				);
				const created = provenance === "created";
				assert.equal(result.items[0].outcome, created ? "removed" : "kept", result.items[0].reason);
				assert.equal(api.calls.includes("archiveWorkspace"), created);
				assert.equal(existsSync(checkpoint.cwd), !created);
			} finally {
				await restored.shutdown();
			}
		});
	}
});

test("partial Paseo opens persist exact receipts before each failure and restore cleanup authority", async (t) => {
	const modes: Provenance[] = ["created", "opened", "reused", "unobserved"];
	const boundaries: Boundary[] = [
		"workspace-ack",
		"workspace-list",
		"agent-ack",
		"session-wait",
		"session-assigned",
		"configure",
		"mail",
		"record",
	];
	for (const mode of modes) {
		for (const boundary of boundaries) {
			// open/reuse has no post-create listing; do not invent one for testing.
			if (boundary === "workspace-list" && (mode === "opened" || mode === "reused")) continue;
			await t.test(`${mode}: ${boundary}`, async (st) => {
				resetRoot();
				writeAgent("scout", agentFile({ model: "alpha/fast-model" }));
				const f = fixture();
				const { api, observed, home, cwd } = partialApi(st, f.source, mode, boundary);
				const host = createPaseoHost(api, { PASEO_AGENT_ID: "11111111-1111-4111-8111-111111111111" });
				if (boundary === "configure")
					host.configureStart = async () => {
						throw new Error("injected configure");
					};
				const s = session({ cwd: f.source, multiplexer: host, send: boundary === "mail" ? "error" : "envelope" });
				let restored: ReturnType<typeof session> | undefined;
				try {
					await s.start();
					const append = s.pi.appendEntry.bind(s.pi);
					if (boundary === "record")
						st.mock.method(s.pi, "appendEntry", (kind: string, data: unknown) => {
							if (kind === START_TYPE) throw new Error("injected record");
							append(kind, data);
						});
					await assert.rejects(
						s.toolCall("delegate", { agent: "scout", task: "work", worktree: "partial" }),
						boundary === "mail" ? /could not send the task/ : /injected/,
					);
					const attempt = readChildRecords(s.parent).at(-1);
					assert.ok(attempt && !isStarted(attempt));
					assert.equal(attempt.attempt.phase, "retained");
					assert.equal(existsSync(cwd()), true, "never roll back an uncertain checkout");
					assert.equal(api.calls.includes("archiveWorkspace"), false);
					if (!["configure", "mail"].includes(boundary)) assert.deepEqual(api.removals, []);
					const expected: PaseoReceipt | undefined =
						boundary === "workspace-ack"
							? undefined
							: {
									home,
									workspaceId: "partial-workspace",
									directory: cwd(),
									projectId: "project",
									provenance: mode === "unobserved" ? "reused" : mode,
								};
					assert.deepEqual(attempt.paseo, expected);
					assert.deepEqual(observed.at(-1)?.paseo, expected);
					assert.ok(paseoLocator(attempt.locator));
					const tree = readTree(s.parent).entries.at(-1);
					assert.ok(tree);
					assert.equal(tree.workspace?.mode, "managed");
					assert.deepEqual(tree.workspace?.mode === "managed" ? tree.workspace.paseo : undefined, expected);
					assert.deepEqual(tree.locator, attempt.locator);
					if (["workspace-ack", "workspace-list", "agent-ack", "session-wait", "session-assigned"].includes(boundary))
						assert.equal(tree.createPending, true, "resource progress does not complete dispatch");
					if (["session-assigned", "configure", "mail", "record"].includes(boundary))
						assert.equal(attempt.sessionId, "assigned-session");
					await s.shutdown();
					restored = session({ parent: s.parent, cwd: f.source, multiplexer: host, entries: s.entries });
					await restored.start();
					for (const records of [
						readChildRecords(s.parent),
						restoreRecords(restored.context as unknown as ExtensionContext, new ChildTasks()),
					]) {
						const record: Recorded | undefined = records.find((item: Recorded) => item.id === attempt.id);
						assert.ok(record && !isStarted(record));
						assert.deepEqual(record.paseo, expected);
						assert.deepEqual(record.locator, attempt.locator);
						assert.equal(record.sessionId, attempt.sessionId);
					}
					// A transcript-only reopen must carry exactly the same partial facts.
					const path = join(agentDir, "squire", "child-tasks", `${s.parent}.json`);
					renameSync(path, `${path}.saved`);
					try {
						const transcript = restoreRecords(restored.context as unknown as ExtensionContext, new ChildTasks());
						const record = transcript.find((item) => item.id === attempt.id);
						assert.ok(record && !isStarted(record));
						assert.deepEqual(record.paseo, expected);
						assert.deepEqual(record.locator, attempt.locator);
						assert.equal(record.sessionId, attempt.sessionId);
					} finally {
						renameSync(`${path}.saved`, path);
					}
					const status = await restored.toolCall("delegation_status", { id: attempt.id });
					assert.match(status.content[0].text, /Paseo recovery target:/);
					const schema = restored.tool("delegation_status").outputSchema;
					assert.ok(schema);
					assert.equal(Value.Check(schema, JSON.parse(JSON.stringify(status.structuredContent))), true);
					// Model an exited opener and a positively closed agent, not a guessed create outcome.
					treeTransaction(s.parent, (state) => {
						const entry = state.entries.find((item) => item.id === attempt.id);
						assert.ok(entry);
						entry.ownerPid = 2147483647;
						if (entry.phase === "started") entry.closed = true;
					});
					const run = () =>
						runCleanup(
							{ ids: [attempt.id] },
							{
								host,
								assertActive: () => {},
								gh: () => ({ ok: false, message: "absent" }),
								paseoApi: () => api,
							},
							restored!.context as unknown as ExtensionContext,
						);
					if (api.agents.length && expected?.provenance === "created") {
						const live = await run();
						assert.equal(live.items[0].outcome, "kept");
						assert.equal(api.calls.includes("archiveWorkspace"), false);
						assert.equal(existsSync(cwd()), true);
					}
					api.agents.splice(0);
					api.running.clear();
					const result = await run();
					const created = expected?.provenance === "created";
					assert.equal(result.items[0].outcome, created ? "removed" : "kept", result.items[0].reason);
					assert.equal(api.calls.includes("archiveWorkspace"), created);
					assert.equal(existsSync(cwd()), !created);
				} finally {
					await s.shutdown();
					await restored?.shutdown();
				}
			});
		}
	}
});

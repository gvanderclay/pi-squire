import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { herdrLocator } from "../src/herdr-locator.ts";
import type { DelegateHost, OpenedWindow, WindowSpec } from "../src/host.ts";
import { readIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import type { StartedRecorded } from "../src/results.ts";
import { readTree } from "../src/tree-registry.ts";
import type { WindowPlacement } from "../src/window-placement.ts";
import type { PaseoReceipt } from "../src/worktree.ts";
import { fixture } from "./cleanup-fixture.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";
import { MemoryHost } from "./memory-host.ts";
import { FakePaseo } from "./paseo-fixture.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
});
after(cleanup);

function sessionFile(id: string, cwd = root): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `source_${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-10-26T00:00:00.000Z" })}\n`,
	);
}
function lastRecord(s: ReturnType<typeof session>): StartedRecorded {
	return s.entries.findLast((entry) => entry.customType === "delegate-start-v2")?.data as StartedRecorded;
}

function instrument(client: DelegateHost, calls: string[], wire?: HerdrWire): void {
	const open = client.openWindow.bind(client);
	client.openWindow = async (
		spec: WindowSpec,
		placement: WindowPlacement,
		companion: string,
	): Promise<OpenedWindow> => {
		calls.push("open");
		assert.equal(readTree("order-parent").entries.at(-1)?.phase, "dispatched");
		const result = await open(spec, placement, companion);
		const locator = herdrLocator(result.locator);
		if (locator && wire) wire.staged.push(dirname(locator.launchFile));
		calls.push("opened");
		return result;
	};
}

async function orders(client: DelegateHost, exit: (record: StartedRecorded) => void, wire?: HerdrWire): Promise<void> {
	const calls: string[] = [];
	instrument(client, calls, wire);
	const s = session({
		parent: "order-parent",
		multiplexer: client,
		beforeSquire: (pi) => {
			const append = pi.appendEntry.bind(pi);
			pi.appendEntry = (type: string, data: unknown): void => {
				if (type === "delegate-start-v2") calls.push("record");
				append(type, data);
			};
		},
	});
	await s.start();
	s.events.on("message:send", () => calls.push("mail"));
	s.events.on("session:launch", (value: unknown) => {
		calls.push("hook");
		const payload = value as { env: Record<string, string> };
		const live = JSON.parse(payload.env.PI_SQUIRE_LIVE_LAUNCH) as { sessionId: string };
		assert.ok(readIdentity(live.sessionId));
		assert.equal(readTree(s.parent).entries.at(-1)?.phase, "reserved");
	});
	try {
		await s.toolCall("delegate", { agent: "scout", task: "first" });
		assert.deepEqual(calls.splice(0), ["mail", "hook", "open", "opened", "record"]);
		const first = lastRecord(s);
		sessionFile(first.id);
		exit(first);
		await s.toolCall("delegation_resume", { id: first.id, task: "second" });
		assert.deepEqual(calls.splice(0), ["hook", "open", "opened", "mail", "record"]);
		await s.toolCall("delegation_fork", { id: lastRecord(s).id, task: "third" });
		assert.deepEqual(calls, ["mail", "hook", "open", "opened", "record"]);
	} finally {
		await s.shutdown();
	}
}

test("an agent's skills and context_files reach launch, resume and fork as Pi's resource flags", async () => {
	writeAgent(
		"lean",
		agentFile({ model: "alpha/fast-model", thinking: "low", skills: "false", context_files: "false" }),
	);
	const s = session();
	try {
		await s.start();
		await s.toolCall("delegate", { agent: "lean", task: "first" });
		const first = lastRecord(s);
		sessionFile(first.id);
		s.tmux.windows.delete((first.locator as { id: string }).id);
		await s.toolCall("delegation_resume", { id: first.id, task: "second" });
		await s.toolCall("delegation_fork", { id: lastRecord(s).id, task: "third" });
		assert.equal(s.tmux.opened.length, 3);
		for (const { argv } of s.tmux.opened) {
			assert.ok(argv.includes("--no-skills"), argv.join(" "));
			assert.ok(argv.includes("--no-context-files"), argv.join(" "));
		}
	} finally {
		await s.shutdown();
	}
});

test("only Paseo copies explicit parent mail/state locations, never parent credentials", async (t) => {
	const keys = ["PI_SESSION_MAIL_ROOT", "XDG_STATE_HOME", "OPENAI_API_KEY"] as const;
	const saved = keys.map((key) => process.env[key]);
	try {
		for (const value of [undefined, join(root, "private state"), ""])
			await t.test(value === undefined ? "unset" : value === "" ? "empty" : "set", async () => {
				for (const key of keys) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				process.env.OPENAI_API_KEY = "must-not-be-copied";
				const api = new FakePaseo();
				const wire = new HerdrWire();
				const hosts = [new FakeTmux(), wire.client, createPaseoHost(api, { PASEO_AGENT_ID: "coordinator" })];
				try {
					for (const host of hosts) {
						let launched: WindowSpec | undefined;
						const open = host.openWindow.bind(host);
						host.openWindow = async (spec, placement, companion) => {
							launched = spec;
							const result = await open(spec, placement, companion);
							const locator = herdrLocator(result.locator);
							if (locator) wire.staged.push(dirname(locator.launchFile));
							return result;
						};
						const s = session({ multiplexer: host });
						try {
							await s.toolCall("delegate", { agent: "scout", task: "go" });
							assert.ok(launched);
							const env = host.id === "paseo" ? api.created.at(-1)?.env : launched.env;
							assert.ok(env);
							assert.equal(env.PI_CODING_AGENT_DIR, agentDir);
							for (const key of ["PI_SESSION_MAIL_ROOT", "XDG_STATE_HOME"])
								if (host.id === "paseo" && value !== undefined) assert.equal(env[key], value);
								else assert.equal(key in env, false, host.id);
							assert.equal("OPENAI_API_KEY" in env, false, host.id);
						} finally {
							await s.shutdown();
						}
					}
				} finally {
					wire.dispose();
				}
			});
	} finally {
		for (const [index, key] of keys.entries()) {
			if (saved[index] === undefined) delete process.env[key];
			else process.env[key] = saved[index];
		}
	}
});

test("an agent without skills or context_files passes neither resource flag", async () => {
	const s = session();
	try {
		await s.start();
		await s.toolCall("delegate", { agent: "scout", task: "go" });
		const { argv } = s.tmux.opened[0];
		assert.ok(!argv.includes("--no-skills") && !argv.includes("--no-context-files"), argv.join(" "));
	} finally {
		await s.shutdown();
	}
});

test("tmux launch/resume/fork keep mail, identity, hook, dispatch, open and record order", async () => {
	const host = new FakeTmux();
	await orders(host, (record: StartedRecorded) => {
		const locator = record.locator as { id: string };
		host.windows.delete(locator.id);
	});
});

test("memory host launch/resume/fork keep the same order as tmux, with no tmux model", async () => {
	const host = new MemoryHost();
	await orders(host, (record: StartedRecorded) => host.exit(record));
	assert.deepEqual(
		host.started.map((start) => start.argv.includes("--session")),
		[false, true, false],
		"only the resume reopens a session file",
	);
});

test("managed resume copies its source workspace and preserves created receipts only for the same home and id", async (t) => {
	for (const change of ["same", "home", "id", "legacy"] as const)
		await t.test(change, async () => {
			resetRoot();
			writeAgent("scout", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
			const f = fixture();
			const host = new MemoryHost();
			const open = host.openWindow.bind(host);
			let receipt: PaseoReceipt | undefined;
			host.openWindow = async (spec, placement, companion) => {
				const opened = await open(spec, placement, companion);
				if (host.started.length === 1 && change !== "legacy")
					receipt = {
						home: "/paseo",
						workspaceId: "original",
						directory: spec.cwd,
						projectId: "project",
						provenance: "created",
					};
				return { ...opened, ...(receipt ? { paseo: receipt } : {}) };
			};
			const s = session({ cwd: f.source, multiplexer: host });
			try {
				await s.start();
				const launch = await s.toolCall("delegate", { agent: "scout", task: "first", worktree: "receipt" });
				const first = lastRecord(s);
				assert.ok(first.workspace?.mode === "managed");
				const source = first.workspace;
				const before = structuredClone(source);
				assert.deepEqual((launch.structuredContent as { workspace: unknown }).workspace, source);
				if (change !== "legacy") assert.equal(source.paseo?.provenance, "created");
				Object.freeze(source);
				if (source.paseo) Object.freeze(source.paseo);
				sessionFile(first.id, source.cwd);
				host.exit(first);
				receipt = {
					home: change === "home" ? "/other-paseo" : "/paseo",
					workspaceId: change === "id" ? "other" : "original",
					directory: source.cwd,
					projectId: "project",
					provenance: "reused",
				};
				const resume = await s.toolCall("delegation_resume", { id: first.id, task: "second" });
				const current = lastRecord(s);
				assert.ok(current.workspace?.mode === "managed");
				assert.notEqual(current.workspace, source);
				assert.deepEqual(source, before, "the original record workspace and receipt are unchanged");
				assert.deepEqual(current.workspace.paseo, change === "same" ? before.paseo : receipt);
				assert.deepEqual((resume.structuredContent as { workspace: unknown }).workspace, current.workspace);
			} finally {
				await s.shutdown();
			}
		});
});

test("Herdr launch/resume/fork keep mail, identity, hook, dispatch, open and record order", async () => {
	const wire = new HerdrWire();
	try {
		await orders(
			wire.client,
			(record: StartedRecorded) => {
				const locator = herdrLocator(record.locator);
				assert.ok(locator);
				writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
			},
			wire,
		);
	} finally {
		wire.dispose();
	}
});

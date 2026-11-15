import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, type TestContext, test } from "node:test";
import type { PaseoAgent } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi, type PaseoResumeInput } from "../src/paseo-api.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(t: TestContext) {
	mkdirSync(".scratch/tmp", { recursive: true });
	const home = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-resume-api-"));
	dirs.push(home);
	writeFileSync(join(home, "paseo.pid"), JSON.stringify({ pid: process.pid, listen: "127.0.0.1:1" }));
	writeFileSync(join(home, "local-credential"), "private-test-credential");
	const input: PaseoResumeInput = {
		agentId: randomUUID(),
		parentAgentId: randomUUID(),
		sessionId: randomUUID(),
		path: join(home, "session.jsonl"),
		cwd: home,
	};
	writeFileSync(input.path, `${JSON.stringify({ type: "session", version: 3, id: input.sessionId, cwd: home })}\n`);
	const agent = {
		id: input.agentId,
		provider: "pi",
		cwd: home,
		archivedAt: "2026-11-15T00:00:00Z",
		model: "opencode-go/deepseek-v4.1-flash",
		thinkingOptionId: "low",
		labels: { "pi-squire": "1", "paseo.parent-agent-id": input.parentAgentId },
		runtimeInfo: { provider: "pi", sessionId: input.sessionId },
		persistence: { provider: "pi", sessionId: input.sessionId, nativeHandle: input.path },
	} as unknown as PaseoAgent;
	const calls: string[] = [];
	let reload: (() => void) | undefined;
	let fetch: (() => void) | undefined;
	t.mock.method(DaemonClient.prototype, "connect", async () => {
		calls.push("connect");
	});
	t.mock.method(DaemonClient.prototype, "close", async () => {
		calls.push("close");
	});
	t.mock.method(DaemonClient.prototype, "fetchAgent", async () => {
		calls.push("fetch");
		fetch?.();
		return { agent };
	});
	t.mock.method(DaemonClient.prototype, "refreshAgent", async () => {
		calls.push("reload");
		reload?.();
		agent.archivedAt = null;
	});
	t.mock.method(DaemonClient.prototype, "fetchAgents", async () => ({
		entries: [],
		pageInfo: { hasMore: false, nextCursor: null, prevCursor: null },
	}));
	t.mock.method(DaemonClient.prototype, "archiveAgent", async () => {
		calls.push("archive");
		return { archivedAt: "archived" };
	});
	t.mock.method(DaemonClient.prototype, "deleteAgent", async () => {
		throw new Error("resume must NEVER delete the source");
	});
	return {
		home,
		input,
		agent,
		calls,
		api: createPaseoApi(home),
		onReload: (callback: () => void) => {
			reload = callback;
		},
		onFetch: (callback: () => void) => {
			fetch = callback;
		},
	};
}

test("native readiness is read-only; resume reloads the exact archived handle on one closed connection", async (t) => {
	const f = fixture(t);
	assert.deepEqual(await f.api.resumeConfiguration(f.input), { model: f.agent.model, thinking: "low" });
	assert.deepEqual(f.calls, ["connect", "fetch", "close"]);
	f.calls.length = 0;
	await f.api.resume(f.input);
	assert.deepEqual(f.calls, ["connect", "fetch", "reload", "fetch", "close"]);
});

test("native resume refuses every identity or archive mismatch before reload", async (t) => {
	const cases: [string, (agent: PaseoAgent) => void][] = [
		[
			"agent id",
			(agent) => {
				agent.id = randomUUID();
			},
		],
		[
			"provider",
			(agent) => {
				agent.provider = "codex";
			},
		],
		[
			"cwd",
			(agent) => {
				agent.cwd += "/moved";
			},
		],
		[
			"label",
			(agent) => {
				delete agent.labels["pi-squire"];
			},
		],
		[
			"parent",
			(agent) => {
				agent.labels["paseo.parent-agent-id"] = randomUUID();
			},
		],
		[
			"runtime",
			(agent) => {
				if (agent.runtimeInfo) agent.runtimeInfo.sessionId = randomUUID();
			},
		],
		[
			"persistence id",
			(agent) => {
				if (agent.persistence) agent.persistence.sessionId = randomUUID();
			},
		],
		[
			"persistence path",
			(agent) => {
				if (agent.persistence) agent.persistence.nativeHandle += ".moved";
			},
		],
		[
			"not archived",
			(agent) => {
				agent.archivedAt = null;
			},
		],
		[
			"model unavailable",
			(agent) => {
				agent.model = null;
			},
		],
	];
	for (const [name, change] of cases)
		await t.test(name, async (sub) => {
			const f = fixture(sub);
			change(f.agent);
			await assert.rejects(f.api.resume(f.input), /Paseo resume refused/);
			assert.equal(f.calls.includes("reload"), false);
			assert.equal(f.calls.at(-1), "close");
		});
});

test("moved/missing paths, wrong header id/cwd and a mismatched daemon receipt refuse before reload", async (t) => {
	for (const mode of ["moved", "header-id", "header-cwd", "daemon"])
		await t.test(mode, async (sub) => {
			const f = fixture(sub);
			if (mode === "moved") renameSync(f.input.path, `${f.input.path}.moved`);
			else if (mode === "daemon") f.input.home = join(f.home, "other-daemon");
			else
				writeFileSync(
					f.input.path,
					JSON.stringify({
						type: "session",
						id: mode === "header-id" ? randomUUID() : f.input.sessionId,
						cwd: mode === "header-cwd" ? "/" : f.input.cwd,
					}),
				);
			await assert.rejects(f.api.resume(f.input));
			assert.equal(f.calls.includes("reload"), false);
		});
});

test("deleted agents and unavailable/ambiguous daemon reads never reload or import", async (t) => {
	for (const mode of ["deleted", "connection", "read"])
		await t.test(mode, async (sub) => {
			const f = fixture(sub);
			if (mode === "deleted") sub.mock.method(DaemonClient.prototype, "fetchAgent", async () => null);
			if (mode === "connection")
				sub.mock.method(DaemonClient.prototype, "connect", async () => {
					throw new Error("ambiguous daemon");
				});
			if (mode === "read")
				f.onFetch(() => {
					throw new Error("daemon read failed");
				});
			await assert.rejects(f.api.resume(f.input));
			assert.equal(f.calls.includes("reload"), false);
			assert.equal(f.calls.at(-1), "close");
		});
});

test("readiness is rechecked at dispatch; changed archive state prevents reload", async (t) => {
	const f = fixture(t);
	await f.api.resumeConfiguration(f.input);
	f.agent.archivedAt = null;
	await assert.rejects(f.api.resume(f.input), /archived Squire Pi session/);
	assert.equal(f.calls.includes("reload"), false);
});

test("reload returning a different runtime session is re-archived, not deleted", async (t) => {
	const f = fixture(t);
	f.onReload(() => {
		if (f.agent.runtimeInfo) f.agent.runtimeInfo.sessionId = randomUUID();
	});
	await assert.rejects(f.api.resume(f.input), /mismatched Pi session; no task was mailed/);
	assert.deepEqual(f.calls, ["connect", "fetch", "reload", "fetch", "archive", "close"]);
});

test("every returned daemon identity field is verified after reload before task delivery", async (t) => {
	const cases: [string, (agent: PaseoAgent) => void][] = [
		[
			"id",
			(agent) => {
				agent.id = randomUUID();
			},
		],
		[
			"provider",
			(agent) => {
				agent.provider = "codex";
			},
		],
		[
			"parent",
			(agent) => {
				agent.labels["paseo.parent-agent-id"] = randomUUID();
			},
		],
		[
			"cwd",
			(agent) => {
				agent.cwd += "/other";
			},
		],
		[
			"persistence provider",
			(agent) => {
				if (agent.persistence) agent.persistence.provider = "codex";
			},
		],
		[
			"runtime provider",
			(agent) => {
				if (agent.runtimeInfo) agent.runtimeInfo.provider = "codex";
			},
		],
		[
			"path",
			(agent) => {
				if (agent.persistence) agent.persistence.nativeHandle += ".other";
			},
		],
	];
	for (const [name, change] of cases)
		await t.test(name, async (sub) => {
			const f = fixture(sub);
			f.onReload(() => change(f.agent));
			await assert.rejects(f.api.resume(f.input), /mismatched Pi session; no task was mailed/);
			assert.ok(f.calls.includes("archive"));
		});
});

test("lost reload acknowledgement re-archives; rollback failures preserve both errors", async (t) => {
	const f = fixture(t);
	f.onReload(() => {
		throw new Error("reload acknowledgement lost");
	});
	t.mock.method(DaemonClient.prototype, "archiveAgent", async () => {
		throw new Error("archive refused");
	});
	await assert.rejects(f.api.resume(f.input), /reload acknowledgement lost.*could not re-archive.*archive refused/);
	assert.equal(f.calls.at(-1), "close");
});

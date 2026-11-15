import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, type TestContext, test } from "node:test";
import type { PaseoAgent, PaseoClient } from "@getpaseo/client";
import { WindowOpenError } from "../src/host.ts";
import { readIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { nativeResumeApi } from "../src/paseo-resume-api.ts";
import { goneOutcome } from "../src/result-close.ts";
import { isV2Start } from "../src/result-types.ts";
import {
	claimTree,
	dispatchTree,
	failedTree,
	readTree,
	reserveTree,
	treeCounts,
	treeTransaction,
} from "../src/tree-registry.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	type SessionOptions,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";
import { FakePaseo } from "./paseo-fixture.ts";

beforeEach(resetRoot);
after(cleanup);

async function source(archived = true, ui?: SessionOptions["ui"]) {
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
	const api = new FakePaseo();
	const host = createPaseoHost(api, { PASEO_AGENT_ID: randomUUID() });
	const s = session({ multiplexer: host, ui });
	await s.start();
	const launched = await s.toolCall("delegate", { agent: "scout", task: "first" });
	const id = (launched.structuredContent as { id: string }).id;
	const record = s.entries.findLast((entry) => entry.data.id === id)?.data;
	assert.ok(isV2Start(record));
	const sessionId = String(record.sessionId);
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `source_${sessionId}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root })}\n`);
	s.events.emit("message:inbound", {
		envelope: {
			id: "first-reply",
			from: sessionId,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "",
			body: "first result",
		},
		path: "/mail/first.json",
		requests: [],
		handled: false,
	});
	await s.run();
	if (archived) {
		api.running.delete(id);
		api.archived.add(id);
	}
	return { api, host, s, id, sessionId, path, record };
}

test("native resume keeps agent/session identity, spends a new launch, skips launch hooks and correlates its new result", async () => {
	const f = await source();
	const before = treeCounts(readTree(f.s.parent));
	let launches = 0;
	f.s.events.on("session:launch", () => {
		launches++;
	});
	writeAgent(
		"scout",
		agentFile({ model: "beta/other-model", thinking: "high", tools: "none", skills: "false", context_files: "false" }),
	);
	const result = await f.s.toolCall("delegation_resume", { id: f.id, task: "continue" });
	const next = result.structuredContent as {
		id: string;
		resumedFrom: string;
		windowId: string;
		model: string;
		autoExit: boolean;
	};
	assert.notEqual(next.id, f.id);
	assert.equal(next.resumedFrom, f.id);
	assert.equal(next.windowId, f.id);
	assert.equal(next.model, "alpha/fast-model");
	assert.equal(next.autoExit, true);
	assert.match(result.content[0].text, /original launch settings.*current roster launch settings are not applied/);
	assert.equal(launches, 0);
	assert.equal(f.api.created.length, 1);
	assert.deepEqual(f.api.removals, []);
	assert.equal(f.api.calls.filter((call) => call === "resume").length, 1);
	assert.equal(treeCounts(readTree(f.s.parent)).lifetime, before.lifetime + 1);
	assert.equal(f.s.sendCalls.at(-1)?.to, f.sessionId);
	const record = f.s.entries.findLast((entry) => entry.data.id === next.id)?.data;
	assert.ok(isV2Start(record));
	assert.equal(record.sessionId, f.sessionId);
	assert.deepEqual(record.identity, readIdentity(f.sessionId));
	f.s.events.emit("message:inbound", {
		envelope: {
			id: "second-reply",
			from: f.sessionId,
			to: f.s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "",
			body: "second result",
		},
		path: "/mail/second.json",
		requests: [],
		handled: false,
	});
	assert.equal(f.s.sent.filter((entry) => String(entry.message.content).includes("second result")).length, 1);
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "obsolete" }), /already resumed.*newest/);
	await f.s.shutdown();
});

/** Inject the production native API into the in-memory host at its post-reservation boundary. */
function nativeFailure(t: TestContext, f: Awaited<ReturnType<typeof source>>, mode: string) {
	return t.mock.method(f.api, "resume", async (input: Parameters<FakePaseo["resume"]>[0]) => {
		let agent = {
			id: input.agentId,
			provider: "pi",
			cwd: input.cwd,
			archivedAt: mode === "before" ? null : "archived",
			model: "alpha/fast-model",
			thinkingOptionId: "low",
			labels: { "pi-squire": "1", "paseo.parent-agent-id": input.parentAgentId },
			runtimeInfo: { provider: "pi", sessionId: input.sessionId },
			persistence: { provider: "pi", sessionId: input.sessionId, nativeHandle: input.path },
		} as unknown as PaseoAgent;
		const handle = {
			current: () => agent,
			refresh: async () => ({ agent }),
			reload: async () => {
				f.api.archived.delete(f.id);
				f.api.running.add(f.id);
				if (mode === "claimed") claimTree(f.s.parent, input.sessionId, undefined);
				agent.archivedAt = null;
				if (mode === "mismatch") {
					if (agent.runtimeInfo) agent.runtimeInfo.sessionId = "wrong";
				} else if (mode === "timeout") throw new Error("Timeout waiting for message");
				else if (mode === "connection")
					throw Object.assign(new Error("connection lost"), { name: "DaemonConnectionError" });
				else throw Object.assign(new Error("reload refused"), { name: "DaemonRpcError" });
			},
			archive: async () => {
				f.api.calls.push("rollback-archive");
				if (mode === "unknown") throw new Error("archive unavailable");
				f.api.archived.add(f.id);
				f.api.running.delete(f.id);
				agent = { ...agent, archivedAt: "confirmed", status: "closed" };
			},
		};
		const client = { agents: { ref: () => handle } } as unknown as PaseoClient;
		await nativeResumeApi(
			root,
			async (run) => run(client),
			async () => true,
		).resume(input);
	});
}

test("native dispatch refusals and confirmed rollbacks refund accounting and allow a truthful retry", async (t) => {
	for (const mode of ["before", "reload", "mismatch", "claimed"])
		await t.test(mode, async (sub) => {
			resetRoot();
			const f = await source();
			const before = treeCounts(readTree(f.s.parent));
			const starts = f.s.entries.filter((entry) => isV2Start(entry.data)).length;
			const mock = nativeFailure(sub, f, mode);
			await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "failed" }));
			assert.deepEqual(treeCounts(readTree(f.s.parent)), before);
			const failed = readTree(f.s.parent).entries.find((entry) => entry.resumedFrom === f.id);
			assert.equal(failed?.phase, "not-started");
			assert.equal(failed?.createPending, false);
			assert.equal(f.s.entries.filter((entry) => isV2Start(entry.data)).length, starts);
			assert.equal(f.s.sendCalls.length, 1);
			assert.equal(f.api.archived.has(f.id), true);
			assert.equal(f.api.running.has(f.id), false);
			claimTree(f.s.parent, f.sessionId, undefined);
			assert.equal(
				readTree(f.s.parent).entries.find((entry) => entry.id === failed?.id)?.phase,
				"not-started",
				"late startup cannot resurrect the refunded entry",
			);
			assert.deepEqual(treeCounts(readTree(f.s.parent)), before);
			mock.mock.restore();
			// The fake's normal readiness now models a valid archived source again.
			const retried = await f.s.toolCall("delegation_resume", { id: f.id, task: "retry" });
			assert.equal((retried.structuredContent as { resumedFrom: string }).resumedFrom, f.id);
			assert.equal(f.s.sendCalls.length, 2);
			await f.s.shutdown();
		});
});

test("an unconfirmed native rollback stays charged and cannot be retried as if nothing opened", async (t) => {
	const f = await source();
	const before = treeCounts(readTree(f.s.parent));
	nativeFailure(t, f, "unknown");
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "failed" }), /archive unavailable/);
	assert.equal(treeCounts(readTree(f.s.parent)).lifetime, before.lifetime + 1);
	assert.equal(readTree(f.s.parent).entries.find((entry) => entry.resumedFrom === f.id)?.phase, "dispatched");
	await assert.rejects(
		f.s.toolCall("delegation_resume", { id: f.id, task: "retry" }),
		/already resumed; resume its newest delegation/,
	);
	assert.equal(f.s.sendCalls.length, 1);
	await f.s.shutdown();
});

test("ambiguous native reloads archive but keep accounting charged and refuse retry", async (t) => {
	for (const mode of ["timeout", "connection"])
		await t.test(mode, async (sub) => {
			resetRoot();
			const f = await source();
			const before = treeCounts(readTree(f.s.parent));
			const starts = f.s.entries.filter((entry) => isV2Start(entry.data)).length;
			nativeFailure(sub, f, mode);
			await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "failed" }), (error: unknown) => {
				assert.ok(error instanceof WindowOpenError);
				assert.equal(error.certainty, "unknown");
				assert.equal(error.nativeResumeRollback, undefined);
				assert.match(error.message, /reload outcome is unknown.*reservation slot stays held/);
				return true;
			});
			const counts = treeCounts(readTree(f.s.parent));
			assert.deepEqual(counts, { concurrent: before.concurrent + 1, lifetime: before.lifetime + 1 });
			assert.equal(readTree(f.s.parent).entries.find((entry) => entry.resumedFrom === f.id)?.phase, "dispatched");
			assert.ok(f.api.calls.includes("rollback-archive"));
			assert.ok(f.api.archived.has(f.id));
			assert.equal(f.api.running.has(f.id), false);
			assert.equal(f.s.entries.filter((entry) => isV2Start(entry.data)).length, starts);
			await assert.rejects(
				f.s.toolCall("delegation_resume", { id: f.id, task: "retry" }),
				/already resumed; resume its newest delegation/,
			);
			assert.deepEqual(treeCounts(readTree(f.s.parent)), counts);
			assert.equal(f.s.sendCalls.length, 1);
			await f.s.shutdown();
		});
});

test("native closed rollback proof cannot refund published outcomes or mismatched identities", async (t) => {
	for (const mode of ["requestId", "launch", "finished", "agent", "source-agent", "session"])
		await t.test(mode, async () => {
			resetRoot();
			const f = await source();
			assert.ok(f.record.identity);
			const token = reserveTree({
				id: randomUUID(),
				sessionId: f.sessionId,
				identity: f.record.identity,
				resumedFrom: f.id,
			});
			dispatchTree(token);
			claimTree(f.s.parent, f.sessionId, undefined);
			treeTransaction(f.s.parent, (state) => {
				const entry = state.entries.find((item) => item.id === token.id);
				assert.ok(entry);
				if (mode === "requestId") entry.requestId = "task-request";
				if (mode === "launch") entry.launch = { ...f.record, id: token.id, resumedFrom: f.id };
				if (mode === "finished") entry.finished = true;
				if (mode === "agent") entry.locator = f.record.locator;
			});
			const before = readTree(f.s.parent);
			const counts = treeCounts(before);
			assert.equal(before.entries.find((entry) => entry.id === token.id)?.phase, "started");
			failedTree(token, true, {
				kind: "native-resume-closed",
				sessionId: mode === "session" ? randomUUID() : f.sessionId,
				agentId: mode === "agent" || mode === "source-agent" ? randomUUID() : f.id,
			});
			assert.deepEqual(readTree(f.s.parent), before, "invalid proof must not change the started entry");
			assert.deepEqual(treeCounts(readTree(f.s.parent)), counts);
			await f.s.shutdown();
		});
});

test("started terminal successors are never refunded by native rollback proof", async () => {
	writeAgent("scout", agentFile({}));
	const s = session();
	await s.start();
	const launched = await s.toolCall("delegate", { agent: "scout", task: "first" });
	const id = (launched.structuredContent as { id: string }).id;
	const record = s.entries.findLast((entry) => entry.data.id === id)?.data;
	assert.ok(isV2Start(record) && record.identity);
	s.events.emit("message:inbound", {
		envelope: {
			id: "done",
			from: id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "",
			body: "done",
		},
		path: "/mail/done",
		requests: [],
		handled: false,
	});
	await s.run();
	s.tmux.windows.clear();
	const token = reserveTree({ id: randomUUID(), sessionId: id, identity: record.identity, resumedFrom: id });
	dispatchTree(token);
	claimTree(s.parent, id, undefined);
	const counts = treeCounts(readTree(s.parent));
	assert.equal(readTree(s.parent).entries.find((entry) => entry.id === token.id)?.phase, "started");
	failedTree(token, true, { kind: "native-resume-closed", sessionId: id, agentId: id });
	assert.deepEqual(treeCounts(readTree(s.parent)), counts);
	failedTree(token, true);
	assert.equal(readTree(s.parent).entries.find((entry) => entry.id === token.id)?.phase, "started");
	await s.shutdown();
});

test("picker offers archived native sources and uses the same frozen-config resume path", async (t) => {
	const f = await source(true, { editor: ["picker follow-up"] });
	await f.s.command("delegate-resume");
	assert.equal(f.s.selects.at(-1)?.options.length, 1);
	assert.equal(f.api.calls.includes("resume"), false, "listing is read-only");
	t.mock.method(f.s.context.ui, "select", async (_title: string, options: string[]) => options[0]);
	await f.s.command("delegate-resume");
	assert.equal(f.api.calls.filter((call) => call === "resume").length, 1);
	assert.equal(f.s.sendCalls.at(-1)?.body, "picker follow-up");
	await f.s.shutdown();
});

test("every explicit native resume override is refused before reservation, reload or task mail", async () => {
	const f = await source();
	const before = readTree(f.s.parent);
	const mailed = f.s.sendCalls.length;
	for (const [key, value] of [
		["model", "alpha/fast-model"],
		["thinking", "low"],
		["auto_exit", true],
		["routing", {}],
	] as const) {
		await assert.rejects(
			f.s.toolCall("delegation_resume", { id: f.id, task: "again", [key]: value }),
			/original launch settings; overrides are refused/,
		);
	}
	assert.deepEqual(readTree(f.s.parent), before);
	assert.equal(f.s.sendCalls.length, mailed);
	assert.equal(f.api.calls.includes("resume"), false);
	await f.s.shutdown();
});

test("nonarchived, moved/missing-file and held-owner sources refuse before any reservation, reload or mail", async () => {
	for (const mode of ["running", "moved", "header", "owner"]) {
		resetRoot();
		const f = await source(mode !== "running");
		if (mode === "running")
			assert.match(
				goneOutcome(f.record, undefined, f.host).content,
				/If this Paseo agent is archived \(not deleted\).*mail an open agent instead/,
			);
		if (mode === "moved") renameSync(f.path, `${f.path}.moved`);
		if (mode === "header") writeFileSync(f.path, JSON.stringify({ type: "session", id: "wrong", cwd: root }));
		const owner = mode === "owner" ? session({ parent: f.sessionId, multiplexer: f.host }) : undefined;
		await owner?.start();
		const before = readTree(f.s.parent);
		const mailed = f.s.sendCalls.length;
		await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "again" }));
		await f.s.command("delegate-resume");
		assert.equal(f.s.selects.length, 0);
		assert.deepEqual(readTree(f.s.parent), before);
		assert.equal(f.s.sendCalls.length, mailed);
		assert.equal(f.api.calls.includes("resume"), false);
		await owner?.shutdown();
		await f.s.shutdown();
	}
});

test("native resume preserves tree caps and refuses persisted routed context", async () => {
	const f = await source();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDelegatesPerRoot: 1 }));
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "again" }), /maxDelegatesPerRoot/);
	assert.equal(f.api.calls.includes("resume"), false);
	writeFileSync(join(agentDir, "squire", "settings.json"), "{}");
	appendFileSync(
		f.path,
		`${JSON.stringify({ type: "custom", id: "route", parentId: null, customType: "delegate-routing-attempt", data: {} })}\n`,
	);
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "again" }), /routing_profile removed/);
	assert.equal(f.api.calls.includes("resume"), false);
	assert.equal(f.s.sendCalls.length, 1);
	await f.s.shutdown();
});

test("mail failure after native reload re-archives the original agent, never deletes it", async () => {
	const f = await source();
	f.s.events.on("message:send", (value) => {
		(value as { error?: string }).error = "mail unavailable";
	});
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "again" }), /mail unavailable/);
	assert.equal(f.api.archived.has(f.id), true);
	assert.equal(f.api.running.has(f.id), false);
	assert.deepEqual(f.api.removals, []);
	assert.equal(readTree(f.s.parent).entries.find((entry) => entry.resumedFrom === f.id)?.phase, "started");
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "retry" }), /already resumed/);
	await f.s.shutdown();
});

test("native rollback bookkeeping is handle-scoped and repeated rollback can never hard-delete the source", async (t) => {
	const f = await source();
	assert.ok(f.host.resumeSession);
	const opened = await f.host.resumeSession({
		locator: f.record.locator ?? {},
		sessionId: f.sessionId,
		path: f.path,
		cwd: root,
	});
	const failedArchive = t.mock.method(f.api, "archive", async () => {
		throw new Error("archive failed");
	});
	await assert.rejects(f.host.closeTaskless(opened), /archive failed/);
	assert.deepEqual(f.api.removals, []);
	failedArchive.mock.restore();
	await f.host.closeTaskless(opened);
	assert.equal(f.api.archived.has(f.id), true);
	assert.deepEqual(f.api.removals, []);
	await f.s.shutdown();
});

test("explicit close deletes a native source; status and recovery advice never promise it can resume", async () => {
	const f = await source();
	await f.s.toolCall("delegation_close", { id: f.id });
	const status = await f.s.toolCall("delegation_status", { id: f.id });
	assert.equal((status.structuredContent as { delegations: { canResume: boolean }[] }).delegations[0].canResume, false);
	await assert.rejects(f.s.toolCall("delegation_resume", { id: f.id, task: "again" }), /deleted and cannot be resumed/);
	assert.equal(f.api.calls.includes("resume"), false);
	await f.s.shutdown();
});

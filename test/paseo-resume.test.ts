import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { readIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { goneOutcome } from "../src/result-close.ts";
import { isV2Start } from "../src/result-types.ts";
import { readTree, treeCounts } from "../src/tree-registry.ts";
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

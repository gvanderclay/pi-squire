import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { ROUTING_ATTEMPT } from "../src/routing-provenance.ts";
import type { RoutingRecord, RoutingRequest } from "../src/routing-types.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { frozenRoute, MODEL_A, MODEL_B, MODELS, policy } from "./routing-fixtures.ts";

const publicRequest: RoutingRequest = { category: "bounded", data: "public", safePublicContext: true };
const privateRequest: RoutingRequest = { category: "bounded", data: "private" };
type Started = { id: string; model: string; routing: RoutingRecord; notices: string[] };
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeAgent("role", agentFile({ routing_profile: "worker" }));
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(policy()));
});
after(cleanup);

function appendAttempt(path: string, route: RoutingRecord, parentId: string | null = null): string {
	const marker = `marker-${route.launchId}`;
	const answer = `answer-${route.launchId}`;
	const rows = [
		{ type: "custom", id: marker, parentId, customType: ROUTING_ATTEMPT, data: route },
		{
			type: "message",
			id: answer,
			parentId: marker,
			message: {
				role: "assistant",
				provider: route.selected.slice(0, route.selected.indexOf("/")),
				model: route.selected.slice(route.selected.indexOf("/") + 1),
				thinkingLevel: "high",
			},
		},
	];
	appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	return answer;
}
async function source(routing: RoutingRequest = publicRequest) {
	const s = session({ extraModels: MODELS });
	const result = await s.toolCall("delegate", { agent: "role", task: "first task", routing });
	const first = result.structuredContent as Started;
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `source_${first.id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: first.id, cwd: root })}\n`);
	const leaf = appendAttempt(path, first.routing);
	return { s, first, path, leaf };
}
async function resumeSource(d: Awaited<ReturnType<typeof source>>, routing: RoutingRequest) {
	d.s.tmux.windows.clear();
	const result = await d.s.toolCall("delegation_resume", { id: d.first.id, task: "next task", routing });
	const resumed = result.structuredContent as Started;
	appendAttempt(d.path, resumed.routing, d.leaf);
	return resumed;
}

test("public A -> private resume B -> public fork A refuses against the actual shared source before mail/open", async () => {
	const d = await source();
	const resumed = await resumeSource(d, privateRequest);
	assert.equal(resumed.routing.request.data, "private");
	const before = { mail: d.s.sendCalls.length, windows: d.s.tmux.opened.length };
	await assert.rejects(
		d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest }),
		/inherited session context/,
	);
	assert.deepEqual({ mail: d.s.sendCalls.length, windows: d.s.tmux.opened.length }, before);
});

test("source history still binds routing after the parent abandons its resumed record", async () => {
	const d = await source();
	const originalEntries = [...d.s.entries];
	await resumeSource(d, privateRequest);
	await d.s.shutdown();
	const restored = session({ extraModels: MODELS, parent: d.s.parent, entries: originalEntries });
	const before = readFileSync(d.path, "utf8");
	await assert.rejects(
		restored.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest }),
		/inherited session context/,
	);
	assert.equal(restored.sendCalls.length, 0);
	assert.equal(restored.tmux.opened.length, 0);
	assert.equal(readFileSync(d.path, "utf8"), before);
});

test("attested public resume and forks of the same shared session remain usable", async () => {
	const d = await source();
	const resumed = await resumeSource(d, publicRequest);
	assert.equal(resumed.routing.request.data, "public");
	for (const id of [d.first.id, resumed.id]) {
		const result = await d.s.toolCall("delegation_fork", { id, task: "public fork", routing: publicRequest });
		assert.equal((result.structuredContent as Started).routing.request.safePublicContext, true);
	}
	assert.equal(d.s.tmux.opened.length, 4);
});

test("unknown pre-marker messages cannot become public through a later public attempt marker", async () => {
	const d = await source();
	const rows = readFileSync(d.path, "utf8").trimEnd().split("\n");
	const marker = JSON.parse(rows[1]);
	marker.parentId = "unknown-context";
	rows.splice(
		1,
		1,
		JSON.stringify({
			type: "message",
			id: "unknown-context",
			parentId: null,
			message: { role: "user", content: "unknown" },
		}),
		JSON.stringify(marker),
	);
	writeFileSync(d.path, `${rows.join("\n")}\n`);
	for (const name of ["delegation_fork", "delegation_resume"]) {
		d.s.tmux.windows.clear();
		await assert.rejects(
			d.s.toolCall(name, { id: d.first.id, task: "public copy", routing: publicRequest }),
			/inherited session context/,
		);
	}
	assert.equal(d.s.sendCalls.length, 1);
	assert.equal(d.s.tmux.opened.length, 1);
});

test("legacy A -> routed B -> unbound fork A refuses persisted routing rather than inheriting a stale attempt", async () => {
	writeAgent("role", agentFile({}));
	const s = session({ extraModels: MODELS });
	const result = await s.toolCall("delegate", { agent: "role", task: "legacy" });
	const first = result.structuredContent as Started;
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `source_${first.id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: first.id, cwd: root })}\n`);
	writeAgent("role", agentFile({ routing_profile: "worker" }));
	s.tmux.windows.clear();
	const next = await s.toolCall("delegation_resume", { id: first.id, task: "routed private", routing: privateRequest });
	appendAttempt(path, (next.structuredContent as Started).routing);
	writeAgent("role", agentFile({}));
	const before = { mail: s.sendCalls.length, windows: s.tmux.opened.length };
	await assert.rejects(
		s.toolCall("delegation_fork", { id: first.id, task: "legacy again" }),
		/routing_profile removed/,
	);
	assert.deepEqual({ mail: s.sendCalls.length, windows: s.tmux.opened.length }, before);
});

test("source changes during hooks cannot change the checked public snapshot handed to Pi", async () => {
	const d = await source();
	const privateRoute = { ...frozenRoute(), role: "role", launchId: "late-private-attempt" };
	d.s.events.on("session:launch", () => appendAttempt(d.path, privateRoute, d.leaf));
	const forked = await d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest });
	assert.equal((forked.structuredContent as Started).routing.request.data, "public");
	assert.ok(!(forked.structuredContent as Started).notices.some((notice) => notice.includes("new cache")));
	const argv = d.s.tmux.opened[1].argv;
	const snapshot = argv[argv.indexOf("--fork") + 1];
	assert.notEqual(snapshot, d.path);
	assert.ok(!readFileSync(snapshot, "utf8").includes("late-private-attempt"));
	assert.ok(readFileSync(d.path, "utf8").includes("late-private-attempt"));
	assert.equal(d.s.sendCalls.length, 2);
	assert.equal(d.s.tmux.opened.length, 2);
});

test("inactive routed history binds the role, but only active ancestry determines public inheritance", async () => {
	const d = await source();
	const privateRoute = { ...frozenRoute(), role: "role", launchId: "abandoned-private-attempt" };
	appendAttempt(d.path, privateRoute, d.leaf);
	// Pi's last entry selects an active sibling of that private attempt.
	appendFileSync(
		d.path,
		`${JSON.stringify({ type: "session_info", id: "public-leaf", parentId: d.leaf, name: "public" })}\n`,
	);
	const forked = await d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest });
	assert.equal((forked.structuredContent as Started).routing.request.data, "public");
	writeAgent("role", agentFile({}));
	await assert.rejects(
		d.s.toolCall("delegation_fork", { id: d.first.id, task: "drop routing" }),
		/routing_profile removed/,
	);
});

test("public branch summaries cannot import private or unknown abandoned context", async () => {
	const d = await source();
	const privateRoute = { ...frozenRoute(), role: "role", launchId: "abandoned-private-attempt" };
	const privateLeaf = appendAttempt(d.path, privateRoute, d.leaf);
	appendFileSync(
		d.path,
		`${JSON.stringify({
			type: "branch_summary",
			id: "private-summary",
			parentId: d.leaf,
			fromId: privateLeaf,
			summary: "private content",
		})}\n`,
	);
	await assert.rejects(
		d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest }),
		/inherited session context/,
	);
	assert.equal(d.s.sendCalls.length, 1);
	assert.equal(d.s.tmux.opened.length, 1);
});

test("a public branch summary whose abandoned source is also attested stays usable", async () => {
	const d = await source();
	const publicRoute = { ...d.first.routing, launchId: "abandoned-public-attempt" };
	const publicLeaf = appendAttempt(d.path, publicRoute, d.leaf);
	appendFileSync(
		d.path,
		`${JSON.stringify({
			type: "branch_summary",
			id: "public-summary",
			parentId: d.leaf,
			fromId: publicLeaf,
			summary: "public content",
		})}\n`,
	);
	const forked = await d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest });
	assert.equal((forked.structuredContent as Started).routing.request.data, "public");
});

test("a public record cannot attest a source with no attempt marker, while private work is still usable", async () => {
	const d = await source();
	writeFileSync(d.path, `${JSON.stringify({ type: "session", version: 3, id: d.first.id, cwd: root })}\n`);
	await assert.rejects(
		d.s.toolCall("delegation_fork", { id: d.first.id, task: "public fork", routing: publicRequest }),
		/inherited session context/,
	);
	const privateFork = await d.s.toolCall("delegation_fork", {
		id: d.first.id,
		task: "private fork",
		routing: privateRequest,
	});
	assert.equal((privateFork.structuredContent as Started).routing.request.data, "private");
});

test("the picker does not cache one source's routing refusal as another legacy session's model failure", async () => {
	writeAgent("role", agentFile({}));
	const s = session({ extraModels: MODELS, ui: { select: [undefined] } });
	const bad = (await s.toolCall("delegate", { agent: "role", task: "old source" })).structuredContent as Started;
	const good = (await s.toolCall("delegate", { agent: "role", task: "plain source" })).structuredContent as Started;
	mkdirSync(sessionDir, { recursive: true });
	for (const { id } of [bad, good]) {
		const path = join(sessionDir, `source_${id}.jsonl`);
		writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
	}
	appendFileSync(
		join(sessionDir, `source_${bad.id}.jsonl`),
		`${JSON.stringify({
			type: "custom",
			id: "persisted-route",
			parentId: null,
			customType: ROUTING_ATTEMPT,
			data: { ...frozenRoute(), role: "role" },
		})}\n`,
	);
	s.tmux.windows.clear();
	await s.command("delegate-resume", "");
	assert.equal(s.selects.at(-1)?.options.length, 1);
	assert.ok(s.selects.at(-1)?.options[0].includes(good.id.slice(0, 8)));
});

test("resume and fork notices name the admitted tied peer and call policy exclusions exclusions", async () => {
	const d = await source(privateRequest);
	assert.equal(d.first.model, MODEL_A);
	const result = await d.s.toolCall("delegation_fork", { id: d.first.id, task: "fork", routing: privateRequest });
	const forked = result.structuredContent as Started;
	assert.equal(forked.model, MODEL_B);
	assert.match(result.content[0].text, new RegExp(`Selected ${MODEL_B}; excluded`));
	assert.doesNotMatch(result.content[0].text, /Used fallback/);
	assert.ok(forked.notices.some((notice) => notice.startsWith(`${MODEL_B} differs from the source's ${MODEL_A}:`)));
	const same = await d.s.toolCall("delegation_fork", { id: d.first.id, task: "fork again", routing: privateRequest });
	assert.equal((same.structuredContent as Started).model, MODEL_A);
	assert.ok(!(same.structuredContent as Started).notices.some((notice) => notice.includes("new cache")));
	d.s.tmux.windows.clear();
	const resumed = await d.s.toolCall("delegation_resume", { id: d.first.id, task: "resume", routing: privateRequest });
	assert.equal((resumed.structuredContent as Started).model, MODEL_B);
	assert.match(resumed.content[0].text, new RegExp(`Selected ${MODEL_B}; excluded`));
	assert.doesNotMatch(resumed.content[0].text, /Used fallback/);
});

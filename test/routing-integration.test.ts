import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { clearMarks, recordLimit, recordProactive } from "../src/limits.ts";
import { ROUTING_ENV } from "../src/routing-launch.ts";
import { type ProvenanceEntry, ROUTING_ATTEMPT, routingEvidence } from "../src/routing-provenance.ts";
import type { RoutingRecord, RoutingRequest } from "../src/routing-types.ts";
import { FakeUsage, win } from "./fake-usage.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { frozenRoute, MODEL_A, MODEL_B, MODEL_D, MODELS, policy } from "./routing-fixtures.ts";

beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "pi-squire-limits.json"), "[]");
});
after(cleanup);
const request: RoutingRequest = { category: "standard", data: "private" };
function configure(profile = "worker") {
	writeAgent("role", agentFile({ routing_profile: profile, tools: "read,bash" }));
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(policy()));
}
const routed = async (s: ReturnType<typeof session>, options: Record<string, unknown> = {}) =>
	(await s.toolCall("delegate", { agent: "role", task: "inspect this fixture", routing: request, ...options }))
		.structuredContent as {
		id: string;
		model: string;
		routing: RoutingRecord;
		thinking: string;
		windowId: string;
		requestId: string;
	};
function sessionFile(id: string, route: RoutingRecord, models = [MODEL_A]): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `2026_${id}.jsonl`);
	const entries: object[] = [
		{ type: "session", version: 3, id, cwd: root },
		{ type: "custom", id: "marker", parentId: null, customType: ROUTING_ATTEMPT, data: route },
	];
	models.forEach((model, index) => {
		entries.push({
			type: "message",
			id: `answer-${index}`,
			parentId: index ? `answer-${index - 1}` : "marker",
			message: {
				role: "assistant",
				provider: model.slice(0, model.indexOf("/")),
				model: model.slice(model.indexOf("/") + 1),
				thinkingLevel: "high",
			},
		});
	});
	writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
	return path;
}

test("unbound roles ignore optional policy files; bound roles require valid policy and fresh metadata", async () => {
	writeAgent("legacy", agentFile({}));
	writeAgent("role", agentFile({ routing_profile: "worker" }));
	const s = session({ extraModels: MODELS });
	await s.toolCall("delegate", { agent: "legacy", task: "old" });
	await assert.rejects(routed(s), /required routing policy/);
	configure();
	await assert.rejects(s.toolCall("delegate", { agent: "role", task: "missing" }), /category and data required/);
	writeFileSync(join(agentDir, "squire", "routing.json"), '{"version":2}');
	await assert.rejects(routed(s), /version/);
	writeAgent("bad", agentFile({ routing_profile: "[]" }));
	await assert.rejects(s.toolCall("delegate", { agent: "bad", task: "bad" }), /disabled.*routing_profile/);
	assert.equal(s.tmux.opened.length, 1);
});

test("routed availability never treats an unattested CLI account as Pi quota, and reactive provider marks cannot be shadowed", async () => {
	configure();
	const p = policy();
	const anthropic = "anthropic/route-a";
	p.models[anthropic] = p.models[MODEL_A];
	delete p.models[MODEL_A];
	for (const profile of Object.values(p.profiles))
		for (const route of Object.values(profile.routes))
			for (const candidate of route.candidates) if (candidate.model === MODEL_A) candidate.model = anthropic;
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(p));
	const usage = new FakeUsage();
	usage.claude = {
		ok: true,
		fiveHour: win("5h", 100, Date.now() + 100000),
		sevenDay: win("7d", 10),
		scoped: null,
		fetchedAt: Date.now(),
	};
	const s = session({ usage, oauth: [anthropic], extraModels: [...MODELS, { ...MODELS[0], provider: "anthropic" }] });
	assert.equal((await routed(s, { model: anthropic })).model, anthropic);
	recordProactive(anthropic, "different CLI account", Date.now() + 100000);
	assert.equal((await routed(s, { model: anthropic })).model, anthropic);
	assert.equal(usage.claudeReads, 0);
	recordLimit(
		{ find: () => ({}) },
		{ provider: "anthropic", model: "route-a", message: "429 quota exceeded", delegation: "reactive-source" },
	);
	await assert.rejects(routed(s, { model: anthropic }), /usage-limited/);
	assert.equal(usage.claudeReads, 0);
	clearMarks("all");
	p.usage = { maxAgeMs: 1000, applicableProviders: ["anthropic"] };
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(p));
	await assert.rejects(routed(s, { model: anthropic }), /usage-limited/);
	assert.ok(usage.claudeReads > 0);
});

test("runtime substitutions use frozen CLI-mark applicability too", async () => {
	const route = frozenRoute();
	const anthropic = "anthropic/route-a";
	route.models[anthropic] = route.models[MODEL_A];
	delete route.models[MODEL_A];
	route.candidates[0].model = anthropic;
	route.selected = MODEL_B;
	recordProactive(anthropic, "different CLI account", Date.now() + 100000);
	process.env[ROUTING_ENV] = JSON.stringify(route);
	const child = session({
		parentEnv: "root-parent",
		extraModels: [...MODELS, { ...MODELS[0], provider: "anthropic" }],
	});
	await child.start();
	await child.run("error", { provider: "beta", model: "route-b", errorMessage: "endpoint unavailable" });
	assert.deepEqual(child.modelSets, [anthropic]);
	route.usageProviders = ["anthropic"];
	process.env[ROUTING_ENV] = JSON.stringify(route);
	const attested = session({
		parentEnv: "root-parent",
		extraModels: [...MODELS, { ...MODELS[0], provider: "anthropic" }],
	});
	await attested.start();
	await attested.run("error", { provider: "beta", model: "route-b", errorMessage: "endpoint unavailable" });
	assert.deepEqual(attested.modelSets, []);
});

test("shared tool/command/UI paths record immutable physical candidates and per-candidate effort", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	const first = await routed(s);
	assert.equal(first.model, MODEL_A);
	assert.equal(first.thinking, "high");
	const secondJSON = JSON.stringify(JSON.stringify(request));
	await s.delegate(`role --routing ${secondJSON} check a public repository without reading private context`);
	assert.equal(s.tmux.opened[1].argv[s.tmux.opened[1].argv.indexOf("--model") + 1], MODEL_B);
	const route: RoutingRecord = JSON.parse(s.tmux.opened[1].env[ROUTING_ENV]);
	assert.equal(route.candidates[0].thinking, "max");
	assert.equal(s.tmux.opened[1].env.PI_DELEGATE_FALLBACK, undefined);
	const form = session({
		extraModels: MODELS,
		ui: { select: ["role — role"], editor: ["ui task", JSON.stringify(request)], input: [""], custom: [{}] },
	});
	await form.command("delegate");
	assert.equal(form.tmux.opened.length, 1);
	assert.equal(form.editors.at(-1)?.title.startsWith("Routing JSON"), true);
	assert.equal(JSON.parse(form.tmux.opened[0].env[ROUTING_ENV]).request.data, "private");
});

test("routing schemas load only on opt-in roster changes without reactivating hidden resume/fork tools", async () => {
	writeAgent("legacy", agentFile({}));
	const s = session({ extraModels: MODELS });
	await s.start();
	for (const name of ["delegate", "delegation_resume", "delegation_fork"])
		assert.ok(!JSON.stringify(s.tool(name).parameters).includes('"routing"'));
	s.pi.setActiveTools(s.pi.getActiveTools().filter((name) => !["delegation_resume", "delegation_fork"].includes(name)));
	configure();
	await s.prepare();
	for (const name of ["delegate", "delegation_resume", "delegation_fork"])
		assert.ok(JSON.stringify(s.tool(name).parameters).includes('"routing"'));
	assert.ok(!s.pi.getActiveTools().includes("delegation_resume"));
	assert.ok(!s.pi.getActiveTools().includes("delegation_fork"));
});

test("explicit model stays single-candidate, hard constraints/marks/virtual models refuse before dispatch", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	const explicit = await routed(s, { model: MODEL_B, thinking: "low" });
	assert.deepEqual(
		explicit.routing.candidates.map((c) => [c.model, c.thinking]),
		[[MODEL_B, "low"]],
	);
	recordLimit(
		{ find: () => ({}) },
		{ provider: "alpha", model: "route-a", message: "429 quota exceeded", delegation: "source" },
	);
	await assert.rejects(routed(s, { model: MODEL_A }), /usage-limited/);
	const next = await routed(s);
	assert.equal(next.model, MODEL_B);
	await assert.rejects(
		routed(s, { model: MODEL_B, routing: { ...request, requirements: { input: ["image"] } } }),
		/incompatible input/,
	);
	const virtual = session({ extraModels: [{ ...MODELS[1], api: "pi-virtual" }] });
	await assert.rejects(routed(virtual, { model: MODEL_B }), /virtual\/opaque/);
});

test("a model the user names in /delegate or the form launches a bound role outside its routing profile", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	// The model calling the tool still needs routing metadata, even with a model.
	await assert.rejects(
		s.toolCall("delegate", { agent: "role", task: "missing", model: MODEL_D }),
		/category and data required/,
	);
	// The command with a model and no --routing: not a standard candidate, public-only, no route or fallbacks.
	await s.delegate(`role --model ${MODEL_D} --thinking low inspect this fixture`);
	assert.deepEqual(s.errors, []);
	const unrouted = s.tmux.opened[0];
	assert.equal(unrouted.argv[unrouted.argv.indexOf("--model") + 1], MODEL_D);
	assert.equal(unrouted.env[ROUTING_ENV], undefined);
	assert.equal(unrouted.env.PI_DELEGATE_FALLBACK, undefined);
	assert.ok(s.notes.at(-1)?.includes(`role runs on ${MODEL_D}, the model you chose, outside routing profile worker`));
	// The command without a model still routes; with --routing too, the model stays a policy candidate.
	await s.delegate("role inspect this fixture");
	assert.match(s.errors.at(-1) ?? "", /category and data required/);
	const json = JSON.stringify(JSON.stringify(request));
	await s.delegate(`role --model ${MODEL_D} --routing ${json} inspect this fixture`);
	assert.match(s.errors.at(-1) ?? "", /no qualified route/);
	await s.delegate(`role --model ${MODEL_B} --routing ${json} inspect this fixture`);
	assert.equal(JSON.parse(s.tmux.opened[1].env[ROUTING_ENV]).selected, MODEL_B);
	assert.equal(s.tmux.opened.length, 2);
	// The form asks for routing JSON only when the model is left to the policy.
	const form = session({
		extraModels: MODELS,
		ui: { select: ["role — role"], editor: ["ui task"], input: [""], custom: [{ model: MODEL_D }] },
	});
	await form.command("delegate");
	assert.deepEqual(form.errors, []);
	assert.equal(form.tmux.opened.length, 1);
	assert.ok(!form.editors.some((editor) => editor.title.startsWith("Routing JSON")));
	assert.equal(form.tmux.opened[0].env[ROUTING_ENV], undefined);
});

test("hook mutation is checked BEFORE mail-before-open delivery and does not consume a tie turn", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	const dispose = s.events.on("session:launch", (payload) => {
		(payload as { args: string[] }).args.push("--model", MODEL_B);
	});
	await assert.rejects(routed(s), /changed routed model/);
	assert.equal(s.sendCalls.length, 0);
	assert.equal(s.tmux.opened.length, 0);
	await dispose();
	assert.equal((await routed(s)).routing.tieTurn, 0);
	assert.equal((await routed(s)).model, MODEL_B);
});

test("all author families on parent active ancestry are excluded, not parent selection or endpoint provider", async () => {
	configure("reviewer");
	const branch: ProvenanceEntry[] = [
		{
			type: "message",
			id: "lead",
			parentId: null,
			message: { role: "assistant", provider: "alpha", model: "route-a" },
		},
	];
	const s = session({ extraModels: MODELS, parentModel: MODEL_B, branch });
	const review = await routed(s, { routing: { ...request, review: { authors: ["self"] } } });
	assert.equal(review.model, MODEL_B);
	assert.deepEqual(review.routing.excludedFamilies, ["anthropic"]);
	await assert.rejects(
		routed(s, { routing: { ...request, review: { authors: ["anthropic"] } } }),
		/unknown author source/,
	);
	branch.push({
		type: "message",
		id: "substitution",
		parentId: "lead",
		message: { role: "assistant", provider: "beta", model: "route-b" },
	});
	await assert.rejects(routed(s, { routing: { ...request, review: { authors: ["self"] } } }), /no qualified route/);
});

test("resume and fork revalidate policy/metadata, retain private inherited context, and carry effort", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	const started = await routed(s);
	const record = s.entries.find((entry) => entry.data.id === started.id)!.data;
	const route = record.routing as RoutingRecord;
	sessionFile(started.id, route);
	const window = s.tmux.opened[0];
	s.tmux.windows.clear();
	for (const name of ["delegation_resume", "delegation_fork"]) {
		await assert.rejects(s.toolCall(name, { id: started.id, task: "follow up" }), /category and data required/);
		await assert.rejects(
			s.toolCall(name, {
				id: started.id,
				task: "follow up",
				routing: { category: "bounded", data: "public", safePublicContext: true },
			}),
			/inherited session context/,
		);
	}
	const forked = (
		await s.toolCall("delegation_fork", { id: started.id, task: "branch", model: MODEL_B, routing: request })
	).structuredContent as { routing: RoutingRecord; model: string };
	assert.equal(forked.routing.candidates[0].thinking, "max");
	assert.equal(forked.model, MODEL_B);
	const resumed = (await s.toolCall("delegation_resume", { id: started.id, task: "continue", routing: request }))
		.structuredContent as { routing: RoutingRecord };
	assert.equal(resumed.routing.request.data, "private");
	assert.equal(s.tmux.opened.length, 3);
	assert.ok(window.argv.includes("--session-id"));
});

test("routed runtime fallback is constrained, per-candidate, durable on reload and refuses policy evasion", async () => {
	const route = frozenRoute();
	process.env[ROUTING_ENV] = JSON.stringify(route);
	const child = session({
		parentEnv: "root-parent",
		autoExitEnv: "1",
		extraModels: MODELS,
		fallbackEnv: "alpha/fast-model",
	});
	await child.start();
	await child.run("error", { provider: "alpha", model: "route-a", errorMessage: "endpoint unavailable" });
	assert.deepEqual(child.modelSets, [MODEL_B]);
	assert.equal(child.pi.getThinkingLevel(), "max");
	await child.fire("session_start", { reason: "reload" });
	await child.run("error", { provider: "beta", model: "route-b", errorMessage: "endpoint unavailable" });
	assert.deepEqual(child.modelSets, [MODEL_B]);
	assert.equal(child.entries.filter((entry) => entry.customType === ROUTING_ATTEMPT).length, 1);
	delete process.env[ROUTING_ENV];
	const saved = child.entries;
	const reopened = session({ parentEnv: "root-parent", extraModels: MODELS, entries: saved });
	await reopened.start();
	await reopened.run("error", {
		provider: "alpha",
		model: "route-a",
		errorMessage: "unavailable due to policy refusal",
	});
	assert.deepEqual(reopened.modelSets, []);
});

test("a multi-turn routed result and status collapse each served-model run to one entry", async () => {
	configure();
	const s = session({ extraModels: MODELS });
	const started = await routed(s);
	const record = s.entries.find((entry) => entry.data.id === started.id)!.data as {
		routing: RoutingRecord;
		requestId: string;
	};
	const path = sessionFile(started.id, record.routing, [
		...Array.from({ length: 100 }, () => MODEL_A),
		MODEL_B,
		MODEL_B,
	]);
	assert.equal(routingEvidence(record.routing, path).complete, true);
	s.events.emit("message:inbound", {
		envelope: {
			id: "reply-done",
			from: started.id,
			to: s.parent,
			in_reply_to: [record.requestId],
			status: "done",
			ts: "",
			body: "the answer",
		},
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	});
	const result = s.sent.find((message) => /^\[delegate\] Result from/.test(String(message.message.content)));
	assert.ok(result, "a result message was sent");
	const servedLine = String(result.message.content)
		.split("\n")
		.find((line) => line.startsWith("Actual served models/efforts:"));
	assert.equal(servedLine, `Actual served models/efforts: ${MODEL_A}:high ×100, ${MODEL_B}:high ×2.`);
	assert.ok(servedLine.length < 120, servedLine);
	const status = await s.toolCall("delegation_status", { id: started.id });
	const statusLine = status.content[0].text.split("\n").find((line) => line.includes("served this attempt:"));
	assert.equal(
		statusLine?.trim(),
		`served this attempt: ${MODEL_A}:high ×100, ${MODEL_B}:high ×2; independent family history: not-required`,
	);
});
test("full review attempt evidence catches intermediate same-family substitutions, not inherited fork history", () => {
	const route = frozenRoute();
	route.independentReview = true;
	route.request.review = { authors: ["self"] };
	route.authors = [{ source: "self", sessionId: "parent", leafId: "lead", models: [MODEL_A], families: ["anthropic"] }];
	route.excludedFamilies = ["anthropic"];
	route.candidates = route.candidates.filter((c) => c.model === MODEL_B);
	route.selected = MODEL_B;
	const path = sessionFile("review", route, [MODEL_B, MODEL_A, MODEL_B]);
	assert.equal(routingEvidence(route, path).independent, "unverified");
	assert.match(routingEvidence(route, path).reasons.join(), /outside the frozen route/);
	const valid = sessionFile("valid-review", route, [MODEL_B]);
	assert.equal(routingEvidence(route, valid).independent, "verified");
	const before = readFileSync(valid, "utf8");
	writeFileSync(
		valid,
		before
			.replace('"parentId":null,"customType"', '"parentId":"inherited","customType"')
			.replace(
				"\n",
				'\n{"type":"message","id":"inherited","parentId":null,"message":{"role":"assistant","provider":"alpha","model":"route-a","thinkingLevel":"high"}}\n',
			),
	);
	assert.equal(routingEvidence(route, valid).independent, "verified");
	assert.equal(routingEvidence(route, undefined).independent, "unverified");
});

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { StartConfiguration } from "../src/host.ts";
import { readIdentity } from "../src/identity.ts";
import { createPaseoHost } from "../src/paseo.ts";
import type { StartedRecorded } from "../src/results.ts";
import { ROUTING_ENV } from "../src/routing-launch.ts";
import { ROUTING_ATTEMPT, readActiveBranch } from "../src/routing-provenance.ts";
import type { RoutingRecord, RoutingRequest } from "../src/routing-types.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	memorySession,
	resetRoot,
	root,
	session,
	sessionDir,
	writeAgent,
} from "./harness.ts";
import { MemoryHost, type MemoryVariant } from "./memory-host.ts";
import { FakePaseo } from "./paseo-fixture.ts";
import { MODEL_A, MODEL_B, MODEL_D, MODELS, policy } from "./routing-fixtures.ts";

const publicRequest: RoutingRequest = { category: "bounded", data: "public", safePublicContext: true };
const privateRequest: RoutingRequest = { category: "bounded", data: "private" };
type Started = { id: string; model: string; routing: RoutingRecord };
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeAgent("role", agentFile({ routing_profile: "worker", auto_exit: "true" }));
	writeFileSync(join(agentDir, "squire", "routing.json"), JSON.stringify(policy()));
});
after(cleanup);

function sourceFile(id: string, route: RoutingRecord): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `source_${id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, cwd: root })}\n`);
	appendAttempt(path, route, null);
	return path;
}
function appendAttempt(path: string, route: RoutingRecord, parentId: string | null): string {
	const id = `marker-${route.launchId}`;
	appendFileSync(
		path,
		`${JSON.stringify({ type: "custom", id, parentId, customType: ROUTING_ATTEMPT, data: route })}\n`,
	);
	return id;
}
function pauseNextAdmission(host: MemoryHost) {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const unavailable = host.unavailable.bind(host);
	let pause = true;
	host.unavailable = ((check?: true) => {
		if (check && pause) {
			pause = false;
			entered.resolve();
			return release.promise.then(() => undefined);
		}
		return check ? unavailable(true) : unavailable();
	}) as MemoryHost["unavailable"];
	return { entered: entered.promise, release: () => release.resolve() };
}

async function preparationRace(variant: MemoryVariant): Promise<void> {
	const host = new MemoryHost(variant);
	const s = memorySession({ host, extraModels: MODELS });
	const initial = await s.toolCall("delegate", { agent: "role", task: "public", routing: publicRequest });
	const first = initial.structuredContent as Started;
	const path = sourceFile(first.id, first.routing);
	const paused = pauseNextAdmission(host);
	const fork = s.toolCall("delegation_fork", { id: first.id, task: "public fork", routing: publicRequest });
	await paused.entered;
	host.exit(host.record(host.started[0]));
	const resumed = await s.toolCall("delegation_resume", {
		id: first.id,
		task: "private work",
		routing: privateRequest,
	});
	appendAttempt(path, (resumed.structuredContent as Started).routing, `marker-${first.id}`);
	const refused = assert.rejects(fork, /inherited session context/);
	paused.release();
	await refused;
	assert.equal(host.started.length, 2, "only the original and private resume opened");
	assert.equal(s.sendCalls.length, 2, "the public fork mailed no task");
	await s.shutdown();
}

test("a paused-preparation public fork rechecks a private resume before mail-before-open", async () => {
	await preparationRace("terminal");
});
test("a paused-preparation public fork rechecks a private resume on an after-open host", async () => {
	await preparationRace("pane-free");
});

async function copiedSnapshot(variant: MemoryVariant): Promise<void> {
	const host = new MemoryHost(variant);
	const s = memorySession({ host, extraModels: MODELS });
	const first = (await s.toolCall("delegate", { agent: "role", task: "public", routing: publicRequest }))
		.structuredContent as Started;
	const original = sourceFile(first.id, first.routing);
	const forked = (await s.toolCall("delegation_fork", { id: first.id, task: "public fork", routing: publicRequest }))
		.structuredContent as Started;
	const argv = host.started[1].argv;
	const snapshot = argv[argv.indexOf("--fork") + 1];
	assert.notEqual(snapshot, original, "Pi must not evaluate the mutable original after mail/open");
	const checked = readFileSync(snapshot, "utf8");
	host.exit(host.record(host.started[0]));
	const resumed = await s.toolCall("delegation_resume", {
		id: first.id,
		task: "private work",
		routing: privateRequest,
	});
	appendAttempt(original, (resumed.structuredContent as Started).routing, `marker-${first.id}`);
	assert.notEqual(readFileSync(original, "utf8"), checked);
	assert.equal(readFileSync(snapshot, "utf8"), checked);
	// Exercise the installed copy primitive after mail/open and the private mutation.
	const copied = SessionManager.forkFrom(snapshot, root, sessionDir, { id: forked.id });
	const branch = readActiveBranch(copied.getSessionFile() ?? "");
	assert.deepEqual(
		branch.entries
			.filter((entry) => entry.customType === ROUTING_ATTEMPT)
			.map((entry) => (entry.data as RoutingRecord).request.data),
		["public"],
	);
	await s.shutdown();
}

test("mail-before-open forks copy the checked snapshot even if private work arrives before Pi evaluates --fork", async () => {
	await copiedSnapshot("terminal");
});
test("after-open forks also copy the checked snapshot instead of the mutable original", async () => {
	await copiedSnapshot("pane-free");
});

test("Paseo receives the admitted route and sends mail only to its assigned session after create", async () => {
	const api = new FakePaseo();
	const host = createPaseoHost(api, { PASEO_AGENT_ID: "coordinator" });
	const s = session({ multiplexer: host, extraModels: MODELS });
	const create = api.create.bind(api);
	api.create = async (input) => {
		assert.equal(s.sendCalls.length, api.created.length, "no task for this agent before create");
		return create(input);
	};
	const request: RoutingRequest = { category: "standard", data: "private" };
	const first = await s.toolCall("delegate", { agent: "role", task: "first", routing: request });
	const second = await s.toolCall("delegate", { agent: "role", task: "second", routing: request });
	assert.equal((first.structuredContent as Started).model, MODEL_A);
	assert.equal((second.structuredContent as Started).model, MODEL_B);
	for (const [index, created] of api.created.entries()) {
		const route: RoutingRecord = JSON.parse(created.env[ROUTING_ENV]);
		assert.equal(created.model, route.selected);
		assert.equal(created.thinking, route.candidates[0].effectiveThinking);
		assert.equal(created.cwd, root);
		assert.equal(created.env.PI_DELEGATE_AUTO_EXIT, "0");
		assert.equal(s.sendCalls[index].to, `paseo-session-${created.agentId}`);
		const record = s.entries.find((entry) => entry.data.id === created.agentId)?.data as StartedRecorded;
		assert.equal(record.sessionId, s.sendCalls[index].to);
		assert.equal(record.routing?.launchId, record.id, "attempt identity is not the host-assigned session identity");
		assert.ok(readIdentity(record.sessionId ?? ""));
	}
	const dispose = s.events.on("session:launch", (payload) =>
		(payload as { args: string[] }).args.push("--model", MODEL_D),
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "role", task: "mutated", routing: request }),
		/changed routed model/,
	);
	assert.equal(api.created.length, 2);
	assert.equal(s.sendCalls.length, 2);
	await dispose();
	await s.shutdown();
});

test("assigned-session configuration validates the admitted cwd/model before task mail and rolls back a refusal", async () => {
	const host = new MemoryHost("pane-free");
	host.assignSessionId = "assigned-session";
	const s = memorySession({ host, extraModels: MODELS });
	host.configureStart = async (_opened, configuration: StartConfiguration) => {
		assert.equal(configuration.sessionId, "assigned-session");
		assert.equal(configuration.cwd, root);
		assert.equal(configuration.model, MODEL_A);
		assert.equal(s.sendCalls.length, 0);
		throw new Error("host refused actual cwd/model validation");
	};
	await assert.rejects(
		s.toolCall("delegate", { agent: "role", task: "task", routing: { category: "standard", data: "private" } }),
		/host refused actual cwd\/model validation/,
	);
	assert.equal(s.sendCalls.length, 0);
	assert.equal(host.closed.length, 1);
	await s.shutdown();
});

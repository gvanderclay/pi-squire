import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { readIdentity } from "../src/identity.ts";
import type { Delegation } from "../src/results.ts";
import { placementProject } from "../src/window-placement.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	type SessionOptions,
	writeAgent,
	writeDelegationPrompt,
	writeProjectAgent,
} from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
const settings = (maxDepth: number): void => {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth }));
};
function instance(options: SessionOptions = {}): Session {
	const created = mailSession(options);
	active.push(created);
	return created;
}
beforeEach(() => {
	resetRoot();
	settings(2);
	writeAgent(
		"coordinator",
		agentFile({ allow_nested_delegation: "[worker]", tools: "read", model: "alpha/fast-model" }),
	);
	writeAgent("worker", agentFile({ model: "alpha/fast-model", auto_exit: "false" }));
});
afterEach(async () => {
	for (const session of active.splice(0)) await session.shutdown();
});
after(() => cleanup());

async function launch(parent: Session, agent: string): Promise<{ child: Session; record: Delegation }> {
	await parent.toolCall("delegate", { agent, task: `task for ${agent}` });
	const record = parent.entries.findLast(({ data }) => data.agent === agent && typeof data.requestId === "string")
		?.data as Delegation;
	const child = instance({ parent: record.sessionId ?? record.id });
	await child.start();
	scan(child);
	return { child, record };
}
async function tree(): Promise<{ rootSession: Session; coordinator: Session; coordinatorRecord: Delegation }> {
	const rootSession = instance();
	await rootSession.start();
	const { child: coordinator, record: coordinatorRecord } = await launch(rootSession, "coordinator");
	return { rootSession, coordinator, coordinatorRecord };
}
const finals = (session: Session): ReturnType<typeof envelopes> =>
	[...envelopes(session.parent, "new"), ...envelopes(session.parent, "cur")].filter(
		(mail) => mail.in_reply_to.length > 0,
	);
const answer = {
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "coordinator report" }] }],
};

test("allowed depth-2 launch grants four tools with explicit tools and persists full read-only identity", async () => {
	const { rootSession, coordinator } = await tree();
	assert.ok(coordinator.pi.getActiveTools().includes("delegate"));
	const opened = rootSession.tmux.opened[0];
	const tools = opened.argv[opened.argv.indexOf("--tools") + 1].split(",");
	for (const name of ["delegate", "delegation_status", "delegation_close", "delegation_resume"])
		assert.ok(tools.includes(name));
	assert.match(
		(await coordinator.prepare()).systemPromptOptions.sections.squire_delegate_task,
		/after your children finish/,
	);
	let metadata: unknown;
	coordinator.events.on("session:launch", (data: unknown) => {
		const payload = data as {
			parent: string;
			root: string;
			depth: number;
			chain: string[];
			args: string[];
			env: Record<string, string>;
		};
		metadata = { parent: payload.parent, root: payload.root, depth: payload.depth, chain: payload.chain };
		assert.throws(() => {
			payload.depth = 0;
		}, TypeError);
		assert.throws(() => payload.chain.push("fake"), TypeError);
		payload.args.push("--custom");
		payload.env.CUSTOM = "ok";
	});
	const { child: worker } = await launch(coordinator, "worker");
	assert.deepEqual(metadata, {
		parent: coordinator.parent,
		root: rootSession.parent,
		depth: 2,
		chain: ["coordinator", "worker"],
	});
	assert.deepEqual(readIdentity(worker.parent), {
		...(metadata as object),
		rootPlacement: placementProject(root).companion,
		agent: "worker",
		autoExit: false,
	});
	assert.equal(coordinator.tmux.opened[0].env.PI_DELEGATE_CHAIN, "coordinator,worker");
	assert.equal(coordinator.tmux.opened[0].env.PI_DELEGATE_ROOT, rootSession.parent);
	assert.equal(coordinator.tmux.opened[0].env.CUSTOM, "ok");
	assert.ok(!worker.pi.getActiveTools().includes("delegate"));
	await assert.rejects(worker.toolCall("delegate", { agent: "worker", task: "bypass" }), /depth 2.*maxDepth is 2/);
});

test("two workers finish out of order; open completed windows do not hold task, raw results stay at direct parent", async () => {
	const { rootSession, coordinator } = await tree();
	const first = await launch(coordinator, "worker");
	const second = await launch(coordinator, "worker");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 0);
	await second.child.run();
	scan(coordinator);
	await coordinator.run();
	assert.equal(finals(rootSession).length, 0);
	assert.equal(second.child.shutdowns(), 0, "auto_exit false is finished, not pending");
	await first.child.run();
	scan(coordinator);
	assert.equal(finals(rootSession).length, 0, "arrival alone is not processing");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
	assert.equal(finals(rootSession)[0].from, coordinator.parent);
	assert.equal(finals(rootSession)[0].status, "done");
	assert.equal(coordinator.shutdowns(), 1);
	assert.equal(coordinator.sent.filter(({ message }) => message.customType === "delegate").length, 2);
});

test("rolling fan-out starts a new worker in the result-processing run without an early final", async () => {
	const { rootSession, coordinator } = await tree();
	const first = await launch(coordinator, "worker");
	await first.child.run();
	scan(coordinator);
	await coordinator.fire("agent_start");
	await coordinator.fire("context", { messages: [] });
	const second = await launch(coordinator, "worker");
	await coordinator.fire("agent_end", answer);
	await coordinator.fire("agent_settled");
	assert.equal(finals(rootSession).length, 0);
	await second.child.run();
	scan(coordinator);
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
});

test("a result arriving during final settlement requires another processing request before completion", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await coordinator.fire("agent_start");
	await coordinator.fire("context", { messages: [] });
	await coordinator.fire("agent_end", answer);
	await coordinator.fire("agent_before_settle", { entries: [], continue: false });
	await worker.child.run();
	scan(coordinator); // the last request is already over, inside final settlement
	await coordinator.fire("agent_settled");
	assert.equal(finals(rootSession).length, 0);
	assert.equal(coordinator.shutdowns(), 0);
	const gate = await coordinator.fire("agent_before_settle", { entries: [], continue: false });
	assert.ok(gate.some((value: unknown) => (value as { continue?: boolean })?.continue));
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
});

test("pending child facts and identity restore with no launch env or transcript; late outcomes are replayed", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await coordinator.shutdown();
	const reopened = instance({ parent: coordinator.parent });
	await reopened.start();
	await reopened.run();
	assert.equal(finals(rootSession).length, 0, "durable children restored without transcript entries");
	assert.ok(reopened.pi.getActiveTools().includes("delegate"));
	await worker.child.run();
	scan(reopened);
	await reopened.shutdown();
	const again = instance({ parent: coordinator.parent });
	await again.start();
	await nextTurn();
	assert.ok(again.sent.some(({ message }) => String(message.content).includes("answer")));
	await again.run();
	assert.equal(finals(rootSession).length, 1);
	assert.equal(finals(rootSession)[0].from, coordinator.parent);
});

test("a worker held across a stop blocks coordinator until a later successful worker run", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await worker.child.run("aborted");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 0);
	await worker.child.run("error");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 0);
	await worker.child.run();
	scan(coordinator);
	assert.match(String(coordinator.sent.at(-1)?.message.content), /user stopped an earlier run/);
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
});

test("coordinator exhausts fallback while children run, stays open, and later recovers successfully", async () => {
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]", fallback: "beta/other-model" }));
	const rootSession = instance();
	await rootSession.start();
	await rootSession.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const id = rootSession.entries[0].data.id as string;
	const coordinator = instance({ parent: id, fallbackEnv: "beta/other-model" });
	await coordinator.start();
	scan(coordinator);
	const worker = await launch(coordinator, "worker");
	await coordinator.run("error", { errorMessage: "service unavailable", provider: "alpha", model: "fast-model" });
	assert.deepEqual(coordinator.modelSets, ["beta/other-model"]);
	await coordinator.run("error", { errorMessage: "fallback unavailable", provider: "beta", model: "other-model" });
	assert.equal(finals(rootSession).length, 0);
	assert.equal(coordinator.shutdowns(), 0);
	await worker.child.run();
	scan(coordinator);
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
	assert.equal(finals(rootSession)[0].status, "done");
	assert.equal(coordinator.shutdowns(), 1);
});

test("confirmed vanished worker releases barrier with missing outcome; unknown window state does not", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	coordinator.tmux.failList = "server cannot be reached";
	t.mock.timers.tick(5000);
	await nextTurn();
	await coordinator.run();
	assert.equal(finals(rootSession).length, 0);
	assert.ok(!coordinator.sent.some(({ message }) => String(message.content).includes("closed without a result")));
	coordinator.tmux.failList = undefined;
	coordinator.tmux.windows.clear();
	t.mock.timers.tick(5000);
	await nextTurn();
	assert.ok(coordinator.sent.some(({ message }) => String(message.content).includes("closed without a result")));
	assert.equal(finals(rootSession).length, 0);
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
	assert.equal(finals(rootSession)[0].from, coordinator.parent);
	assert.equal(worker.child.shutdowns(), 0, "test simulates confirmed disappearance, never kills a real session");
});

test("admission enforces default depth and current allowlist across tools and commands before mail or windows", async () => {
	const { coordinator } = await tree();
	writeAgent("other", agentFile({}));
	await assert.rejects(
		coordinator.toolCall("delegate", { agent: "other", task: "bypass" }),
		/permitted agents: worker/,
	);
	await coordinator.delegate("other bypass");
	assert.match(coordinator.errors.join("\n"), /permitted agents: worker/);
	assert.equal(coordinator.tmux.opened.length, 0);
	rmSync(join(agentDir, "squire", "settings.json")); // default maxDepth is 1
	await assert.rejects(coordinator.toolCall("delegate", { agent: "worker", task: "bypass" }), /maxDepth is 1/);
	assert.equal(envelopes(coordinator.parent, "sent").length, 0);
});

test("current trusted project coordinator shadows global definition and retains parent delegation guidance", async () => {
	writeAgent("coordinator", agentFile({}));
	writeProjectAgent(root, "coordinator", agentFile({ allow_nested_delegation: "true", tools: "read" }));
	writeDelegationPrompt("Use your children for self-contained work.");
	const rootSession = instance({ projectTrusted: true });
	await rootSession.start();
	await rootSession.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const coordinator = instance({ parent: rootSession.entries[0].data.id as string, projectTrusted: true });
	await coordinator.start();
	const prepared = await coordinator.prepare();
	assert.equal(
		prepared.systemPromptOptions.sections.squire_parent_delegation,
		"Use your children for self-contained work.",
	);
	assert.match(prepared.systemPromptOptions.sections.squire_delegate_task, /intermediate runs send no task report/);
	await launch(coordinator, "worker");
	assert.ok(coordinator.statuses.some(({ key, text }) => key === "delegate-self" && text?.includes("coordinator")));
	assert.ok(coordinator.statuses.some(({ key, text }) => key === "delegate" && text?.includes("1 delegate")));
});

test("unresolved nested directory trust canceled at root opens no unattended UI; decided trust keeps explicit flags", async () => {
	const { coordinator } = await tree();
	const target = join(root, "untrusted");
	mkdirSync(join(target, ".pi"), { recursive: true });
	writeFileSync(join(target, ".pi", "settings.json"), "{}");
	await assert.rejects(
		coordinator.toolCall("delegate", { agent: "worker", task: "go", cwd: target }),
		/trust question.*cancelled/i,
	);
	assert.equal(coordinator.selects.length, 0);
	assert.equal(coordinator.tmux.opened.length, 0);
	await coordinator.toolCall("delegate", { agent: "worker", task: "go" });
	assert.ok(coordinator.tmux.opened[0].argv.includes("--no-approve"));
});

test("removing a current parent grant blocks resume before an exited window can be killed", async () => {
	const { coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	coordinator.tmux.exit(worker.record.windowId);
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[coordinator]" }));
	await assert.rejects(
		coordinator.toolCall("delegation_resume", { id: worker.record.id, task: "again" }),
		/permitted agents: coordinator/,
	);
	await coordinator.command("delegate-resume", `${worker.record.id} again`);
	assert.match(coordinator.errors.join("\n"), /permitted agents: coordinator/);
	assert.equal(coordinator.tmux.killed.length, 0);
	assert.equal(coordinator.tmux.opened.length, 1);
	assert.equal(envelopes(coordinator.parent, "sent").length, 1);
});

test("allowed nested resume preserves original root/depth and uses the current child's grant", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await worker.child.shutdown();
	const dir = coordinator.context.sessionManager.getSessionDir();
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `worker_${worker.child.parent}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id: worker.child.parent, timestamp: "", cwd: root })}\n`,
	);
	coordinator.tmux.windows.delete(worker.record.windowId);
	settings(3);
	writeAgent("worker", agentFile({ allow_nested_delegation: "[worker]", tools: "read", auto_exit: "false" }));
	await coordinator.toolCall("delegation_resume", { id: worker.record.id, task: "again" });
	const resumed = coordinator.entries.findLast(({ data }) => data.resumedFrom === worker.record.id)
		?.data as unknown as Delegation;
	assert.deepEqual(resumed.identity, {
		parent: coordinator.parent,
		root: rootSession.parent,
		rootPlacement: placementProject(root).companion,
		depth: 2,
		agent: "worker",
		chain: ["coordinator", "worker"],
		autoExit: false,
	});
	const reopened = instance({ parent: worker.child.parent });
	await reopened.start();
	scan(reopened);
	assert.ok(reopened.pi.getActiveTools().includes("delegate"));
	const leaf = await launch(reopened, "worker");
	assert.equal(readIdentity(leaf.child.parent)?.depth, 3);
	assert.deepEqual(readIdentity(leaf.child.parent)?.chain, ["coordinator", "worker", "worker"]);
	assert.ok(!leaf.child.pi.getActiveTools().includes("delegate"));
});

test("listing delegation tools alone warns and cannot opt into nesting", async () => {
	writeAgent("coordinator", agentFile({ tools: "read,delegate,delegation_resume" }));
	const { rootSession, coordinator } = await tree();
	assert.match(rootSession.warnings.join("\n"), /lists delegation tools without allow_nested_delegation/);
	assert.ok(!coordinator.pi.getActiveTools().includes("delegate"));
	const argv = rootSession.tmux.opened[0].argv;
	assert.ok(!argv[argv.indexOf("--tools") + 1].split(",").includes("delegate"));
	await assert.rejects(coordinator.toolCall("delegate", { agent: "worker", task: "bypass" }), /permitted agents: none/);
});

test("a stop in the coordinator holds its own task while workers finish", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await coordinator.run("aborted");
	await worker.child.run();
	scan(coordinator);
	await coordinator.run("error");
	assert.equal(finals(rootSession).length, 0, "failure does not answer a held task");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
	assert.match(finals(rootSession)[0].body, /user stopped an earlier run/);
});

test("an unsuccessful final coordinator run reports that failure, not an earlier intermediate one", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await coordinator.run("error", { errorMessage: "intermediate failure" });
	assert.equal(finals(rootSession).length, 0);
	await worker.child.run();
	scan(coordinator);
	await coordinator.run("error", { errorMessage: "final failure" });
	assert.equal(finals(rootSession).length, 1);
	assert.equal(finals(rootSession)[0].status, "failed");
	assert.match(finals(rootSession)[0].body, /final failure/);
	assert.doesNotMatch(finals(rootSession)[0].body, /intermediate failure/);
});

test("every launching coordinator keeps its own throttled quota reader and shared reactive fallback marks", async () => {
	writeAgent("worker", agentFile({ model: "opencode-go/paid" }));
	const extraModels = [{ provider: "opencode-go", id: "paid", cost: { input: 1, output: 1 } }];
	const { rootSession } = await tree();
	// Use a new root delegation so the launching coordinator's model registry
	// has the scripted Go model; no production quota endpoint is contacted.
	await rootSession.toolCall("delegate", { agent: "coordinator", task: "quota checks" });
	const id = rootSession.entries.at(-1)?.data.id as string;
	const coordinator = instance({ parent: id, extraModels });
	await coordinator.start();
	await coordinator.toolCall("delegate", { agent: "worker", task: "first" });
	await coordinator.toolCall("delegate", { agent: "worker", task: "second" });
	assert.equal(coordinator.usage.calls.length, 1, "proactive checks stay locally throttled");
	const record = coordinator.entries[0].data as unknown as Delegation;
	const worker = instance({ parent: record.id, extraModels });
	await worker.start();
	scan(worker);
	await worker.run("error", { errorMessage: "429 rate limit exceeded", provider: "opencode-go", model: "paid" });
	await assert.rejects(
		coordinator.toolCall("delegate", { agent: "worker", task: "third" }),
		/usage.limit|marked|rate limit/i,
	);
});

test("a result delivered after agent_end but before before-settle gets a runnable continuation entry", async () => {
	const { rootSession, coordinator } = await tree();
	const worker = await launch(coordinator, "worker");
	await coordinator.fire("context", { messages: [] });
	await coordinator.fire("agent_end", answer);
	await worker.child.run();
	scan(coordinator);
	const gate = await coordinator.fire("agent_before_settle", { entries: [], continue: false });
	const continued = gate.find((value: unknown) => (value as { continue?: boolean })?.continue) as {
		entries: unknown[];
	};
	assert.ok(continued);
	assert.equal(continued.entries.length, 1, "Pi requires runnable non-assistant context for a continuation");
	await coordinator.run();
	assert.equal(finals(rootSession).length, 1);
});

test("unreadable durable child state blocks settlement rather than treating unknown children as finished", async () => {
	const { rootSession, coordinator } = await tree();
	await launch(coordinator, "worker");
	await coordinator.shutdown();
	const file = join(agentDir, "squire", "child-tasks", `${encodeURIComponent(coordinator.parent)}.json`);
	writeFileSync(file, "null");
	const reopened = instance({ parent: coordinator.parent });
	await reopened.start();
	await reopened.run();
	assert.equal(finals(rootSession).length, 0);
	assert.equal(reopened.shutdowns(), 0);
	assert.match(reopened.errors.join("\n"), /could not restore child tasks.*completion is blocked/);
	assert.equal(readFileSync(file, "utf8"), "null", "bad durable state is not overwritten with an empty tree");
});

test("a changed allowlist while launch prerequisites await is rechecked before task mail", async () => {
	const { coordinator } = await tree();
	const gate = Promise.withResolvers<void>();
	const originalVersion = coordinator.tmux.version.bind(coordinator.tmux);
	coordinator.tmux.version = async () => {
		await gate.promise;
		return originalVersion();
	};
	const launching = coordinator.toolCall("delegate", { agent: "worker", task: "delayed" });
	await nextTurn();
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[coordinator]" }));
	gate.resolve();
	await assert.rejects(launching, /permitted agents: coordinator/);
	assert.equal(coordinator.tmux.opened.length, 0);
	assert.equal(envelopes(coordinator.parent, "sent").length, 0);
});

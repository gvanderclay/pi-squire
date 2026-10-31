// Independent squire + released-mail runtimes, real loopback control, fake
// lifecycle/tmux. Cross-process kill/restart guarantees are tested separately.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { requestRootTrust } from "../src/trust-wire.ts";
import {
	agentDir,
	agentFile,
	cleanup,
	resetRoot,
	root,
	type SessionOptions,
	sessionDir,
	writeAgent,
} from "./harness.ts";
import { envelopes, mailSession, nextTurn, scan } from "./mail-harness.ts";

type Session = ReturnType<typeof mailSession>;
const active: Session[] = [];
beforeEach(() => {
	resetRoot();
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(join(agentDir, "squire", "settings.json"), JSON.stringify({ maxDepth: 2 }));
	writeAgent("coordinator", agentFile({ allow_nested_delegation: "[worker]" }));
	writeAgent("worker", agentFile({}));
});
afterEach(async () => {
	for (const session of active.splice(0).reverse()) await session.shutdown();
});
after(() => cleanup());

async function tree(options: SessionOptions = {}): Promise<{ parent: Session; child: Session }> {
	const parent = mailSession(options);
	active.push(parent);
	await parent.start();
	await parent.toolCall("delegate", { agent: "coordinator", task: "coordinate" });
	const record = parent.entries[0].data;
	const child = mailSession({ parent: record.id as string });
	active.push(child);
	await child.start();
	scan(child);
	return { parent, child };
}
function target(name: string): string {
	const path = join(root, name);
	mkdirSync(join(path, ".pi"), { recursive: true });
	writeFileSync(join(path, ".pi", "settings.json"), "{}");
	return realpathSync(path);
}
async function until(check: () => boolean): Promise<void> {
	for (let count = 0; count < 200 && !check(); count++) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(check(), "fixture reached expected control state");
}
const launch = (child: Session, cwd: string, signal?: AbortSignal) =>
	child.toolCall("delegate", { agent: "worker", task: "work", cwd }, signal);
const flags = (session: Session): string[] =>
	session.tmux.opened.at(-1)!.argv.filter((arg) => arg === "--approve" || arg === "--no-approve");

for (const choice of [
	"Trust",
	"Trust (this session only)",
	"Do not trust",
	"Do not trust (this session only)",
	"parent",
]) {
	test(`nested ${choice} is decided at root, keeps exact scope and explicit flag, and never enters task mail`, async () => {
		const cwd = target(`choice-${choice.replaceAll(" ", "-")}`);
		const label = choice === "parent" ? `Trust parent folder (${dirname(cwd)})` : choice;
		const { parent, child } = await tree({ ui: { select: [label] }, projectTrusted: true });
		const originalRootMail = envelopes(parent.parent, "new").length + envelopes(parent.parent, "cur").length;
		const originalPrompts = [...parent.userMessages];
		await launch(child, cwd);
		assert.equal(parent.selects.length, 1);
		assert.ok(parent.selects[0].timeout! > 590000 && parent.selects[0].timeout! <= 600000);
		assert.match(parent.selects[0].title, /Agent chain: coordinator → worker/);
		assert.ok(parent.selects[0].title.includes(cwd));
		assert.ok(parent.selects[0].title.includes(child.parent));
		assert.equal(child.selects.length, 0);
		assert.deepEqual(flags(child), [choice.startsWith("Do not") ? "--no-approve" : "--approve"]);
		const store = new ProjectTrustStore(agentDir);
		const expected = choice.includes("this session") ? null : !choice.startsWith("Do not");
		assert.equal(store.get(cwd), expected);
		if (choice === "parent") assert.equal(store.getEntry(cwd)?.path, dirname(cwd));
		assert.deepEqual(parent.userMessages, originalPrompts);
		assert.equal(envelopes(parent.parent, "new").length + envelopes(parent.parent, "cur").length, originalRootMail);
		assert.equal(envelopes(child.parent, "sent").length, 1, "only the worker task was sent");
		const workerId = child.entries[0].data.id as string;
		const worker = mailSession({ parent: workerId });
		active.push(worker);
		await worker.start();
		scan(worker);
		await worker.run();
		scan(child);
		assert.equal(
			parent.sent.filter(({ message }) => message.customType === "delegate").length,
			0,
			"no raw worker/trust result at root",
		);
	});
}

test("already-resolved and resource-free nested launches need no root; unresolved trust refuses immediately", async () => {
	const { parent, child } = await tree();
	await parent.shutdown();
	const cwd = target("absent-root");
	const start = Date.now();
	await assert.rejects(launch(child, cwd), /root .*not running.*trust service/);
	assert.ok(Date.now() - start < 1000);
	assert.equal(child.tmux.opened.length, 0);
	assert.equal(envelopes(child.parent, "sent").length, 0);
	for (const decision of [true, false]) {
		new ProjectTrustStore(agentDir).setMany([{ path: cwd, decision }]);
		await launch(child, cwd);
		assert.deepEqual(flags(child), [decision ? "--approve" : "--no-approve"]);
	}
	const resourceFree = join(root, "empty");
	mkdirSync(resourceFree);
	await launch(child, resourceFree);
	assert.deepEqual(flags(child), ["--no-approve"]);
	await child.toolCall("delegate", { agent: "worker", task: "inherited" });
	assert.equal(child.selects.length, 0);
});

test("root with no dialog UI or marked unattended is not an approval source", async () => {
	for (const unattended of [false, true]) {
		if (unattended) process.env.PI_UNATTENDED = "1";
		const { parent, child } = await tree({ hasUI: unattended });
		delete process.env.PI_UNATTENDED;
		await assert.rejects(launch(child, target(`unavailable-${unattended}`)), /root .*not running.*trust service/);
		assert.equal(parent.selects.length, 0);
		assert.equal(child.selects.length, 0);
	}
});

test("root validation refusals retain correlation and reach the requester without opening UI", async () => {
	const { parent, child } = await tree();
	const cwd = target("invalid-request");
	const question = { directory: cwd, key: cwd, requester: "unknown-requester", chain: ["coordinator", "worker"] };
	await assert.rejects(requestRootTrust(agentDir, parent.parent, question), {
		message: "project trust requester does not belong to this root; nothing was launched",
	});
	await assert.rejects(
		requestRootTrust(agentDir, parent.parent, { ...question, requester: child.parent }, undefined, Date.now() + 601000),
		{
			message: "invalid or expired project trust request; nothing was launched",
		},
	);
	assert.equal(parent.selects.length, 0);
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	assert.equal(child.tmux.opened.length, 0);
});

test("top-level no-UI trust refusal names the key and how to establish trust", async () => {
	const { parent } = await tree({ hasUI: false });
	const cwd = target("no-ui-guidance");
	await assert.rejects(parent.toolCall("delegate", { agent: "worker", task: "local", cwd }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.ok(error.message.includes(`open Pi in ${cwd}, answer its trust question, then delegate again`));
		return true;
	});
	assert.equal(parent.selects.length, 0);
	assert.equal(parent.tmux.opened.length, 1, "only the original coordinator started");
});

test("busy root serializes concurrent remote and local prompts without model settlement", async () => {
	let firstAnswer!: (answer: string) => void;
	let secondAnswer!: (answer: string) => void;
	const first = new Promise<string>((resolve) => {
		firstAnswer = resolve;
	});
	const second = new Promise<string>((resolve) => {
		secondAnswer = resolve;
	});
	const { parent, child } = await tree({ ui: { select: [first, second, "Do not trust"] } });
	const unrelatedRun = new AbortController();
	Object.defineProperty(parent.context, "signal", { get: () => unrelatedRun.signal });
	parent.context.isIdle = () => false;
	await parent.fire("agent_start");
	const firstLaunch = launch(child, target("remote-first"));
	await until(() => parent.selects.length === 1);
	const secondLaunch = parent.toolCall("delegate", { agent: "worker", task: "local", cwd: target("local-second") });
	const thirdLaunch = launch(child, target("remote-third"));
	await nextTurn();
	assert.equal(parent.selects.length, 1);
	assert.equal(parent.context.isIdle(), false);
	firstAnswer("Trust (this session only)");
	await firstLaunch;
	await until(() => parent.selects.length === 2);
	secondAnswer("Do not trust (this session only)");
	await secondLaunch;
	await thirdLaunch;
	assert.equal(parent.selects.length, 3);
	assert.deepEqual(flags(child), ["--no-approve"]);
	assert.equal(parent.userMessages.length, 0);
});

test("an unrelated root run's abort does not cancel a remote trust question", async () => {
	let answer!: (value: string) => void;
	const pending = new Promise<string>((resolve) => {
		answer = resolve;
	});
	const { parent, child } = await tree({ ui: { select: [pending] } });
	const unrelated = new AbortController();
	Object.defineProperty(parent.context, "signal", { get: () => unrelated.signal });
	const launched = launch(child, target("unrelated-root-stop"));
	await until(() => parent.selects.length === 1);
	unrelated.abort();
	assert.equal(parent.selects[0].signal!.aborted, false);
	answer("Trust (this session only)");
	await launched;
	assert.equal(child.tmux.opened.length, 1);
});

test("endpoint storage failure leaves the root's local trust UI working and nested trust fails closed", async () => {
	writeFileSync(join(agentDir, "squire", "trust"), "not a directory");
	const { parent, child } = await tree({ ui: { select: ["Trust"] } });
	assert.match(parent.errors.join("\n"), /could not start root project trust control/);
	await parent.toolCall("delegate", { agent: "worker", task: "local", cwd: target("local-without-endpoint") });
	assert.equal(parent.selects.length, 1);
	await assert.rejects(
		launch(child, target("nested-without-endpoint")),
		/could not read root .*trust service endpoint/,
	);
	assert.equal(child.tmux.opened.length, 0);
});

test("a saved answer is re-read when a concurrent same-target request reaches the root queue", async () => {
	let answer!: (value: string) => void;
	const pending = new Promise<string>((resolve) => {
		answer = resolve;
	});
	const { parent, child } = await tree({ ui: { select: [pending] } });
	const cwd = target("same-target");
	const first = launch(child, cwd);
	await until(() => parent.selects.length === 1);
	const second = launch(child, cwd);
	await nextTurn();
	answer("Trust");
	await Promise.all([first, second]);
	assert.equal(parent.selects.length, 1);
	assert.equal(child.tmux.opened.length, 2);
});

test("active and queued cancellation dismiss root UI and late approval cannot save or launch", async () => {
	let answer!: (value: string) => void;
	const ignoredAbort = new Promise<string>((resolve) => {
		answer = resolve;
	});
	const { parent, child } = await tree();
	// Deliberately broken UI returns its old answer even after signal dismissal.
	const seen: AbortSignal[] = [];
	parent.context.ui.select = async (_title, _options, opts) => {
		seen.push(opts!.signal!);
		return ignoredAbort;
	};
	const firstCwd = target("cancel-active");
	const secondCwd = target("cancel-queued");
	const firstAbort = new AbortController();
	const secondAbort = new AbortController();
	const first = assert.rejects(launch(child, firstCwd, firstAbort.signal), /abort/);
	await until(() => seen.length === 1);
	const second = assert.rejects(launch(child, secondCwd, secondAbort.signal), /abort/);
	secondAbort.abort();
	await second;
	firstAbort.abort();
	await first;
	await until(() => seen[0].aborted);
	answer("Trust");
	await nextTurn();
	await nextTurn();
	assert.equal(seen.length, 1, "canceled queued request was never prompted");
	assert.equal(new ProjectTrustStore(agentDir).get(firstCwd), null);
	assert.equal(new ProjectTrustStore(agentDir).get(secondCwd), null);
	assert.equal(child.tmux.opened.length, 0);
	assert.equal(envelopes(child.parent, "sent").length, 0);
});

test("root shutdown and same-session restart do not revive a pending launch or stale approval", async () => {
	let answer!: (value: string) => void;
	const pending = new Promise<string>((resolve) => {
		answer = resolve;
	});
	const { parent, child } = await tree({ ui: { select: [pending, "Trust"] } });
	const cwd = target("root-restart");
	const refused = assert.rejects(launch(child, cwd), /disappeared|stopped|replaced/);
	await until(() => parent.selects.length === 1);
	await parent.shutdown();
	await refused;
	await parent.start();
	answer("Trust");
	await nextTurn();
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	assert.equal(child.tmux.opened.length, 0);
	await launch(child, cwd);
	assert.equal(parent.selects.length, 2);
	assert.equal(child.tmux.opened.length, 1);
});

test("requester restart cancels its pending work; late root choice is not durable", async () => {
	let answer!: (value: string) => void;
	const pending = new Promise<string>((resolve) => {
		answer = resolve;
	});
	const { parent, child } = await tree({ ui: { select: [pending] } });
	const cwd = target("requester-restart");
	const refused = assert.rejects(launch(child, cwd), /stopped|replaced/);
	await until(() => parent.selects.length === 1);
	await child.shutdown();
	await refused;
	await child.start();
	answer("Trust");
	await nextTurn();
	assert.equal(new ProjectTrustStore(agentDir).get(cwd), null);
	assert.equal(child.tmux.opened.length, 0);
});

test("managed unrelated-source approval is keyed to source and resume trust is routed again", async () => {
	const source = target("source");
	for (const args of [
		["init", "-q"],
		["add", ".pi/settings.json"],
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
	])
		assert.equal(spawnSync("git", args, { cwd: source }).status, 0);
	const { parent, child } = await tree({ ui: { select: ["Trust (this session only)", "Do not trust"] } });
	await child.toolCall("delegate", { agent: "worker", task: "go", worktree: "routed", worktree_source: source });
	const record = child.entries.find((entry) => entry.data.kind !== "workspace-attempt")!.data as {
		id: string;
		windowId: string;
		cwd: string;
	};
	assert.match(parent.selects[0].title, /Main repository:/);
	assert.ok(parent.selects[0].title.includes(source));
	assert.ok(parent.selects[0].title.includes(record.cwd));
	assert.equal(new ProjectTrustStore(agentDir).get(source), null);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `worker_${record.id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id: record.id, cwd: record.cwd, timestamp: "" })}\n`,
	);
	child.tmux.windows.delete(record.windowId);
	await child.toolCall("delegation_resume", { id: record.id, task: "again" });
	assert.equal(parent.selects.length, 2);
	assert.deepEqual(flags(child), ["--no-approve"]);
	assert.equal(new ProjectTrustStore(agentDir).get(source), false);
});

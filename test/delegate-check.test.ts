import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";

type Session = ReturnType<typeof session>;
type Start = { id: string; cwd: string; windowId: string };
type Check = {
	status: string;
	runs: { command: string; cwd: string; exitCode: number | null; signal: string | null; ms: number }[];
	tail?: string[];
};
const approval = { nestedTools: ["delegate_check"] };
const task = { agent: "scout", task: "inspect this" };
const marker = "printf ran > check-marker";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
});
after(cleanup);

async function delegate(s: Session, params: Record<string, unknown> = {}): Promise<Start> {
	return (await s.toolCall("delegate", { ...task, ...params })).structuredContent as Start;
}

function reply(s: Session, from: string, index = 0, body = "child answer", status = "done") {
	const request = s.sendCalls[index].envelope?.id;
	assert.equal(typeof request, "string");
	const payload = {
		envelope: { id: `reply-${request}`, from, to: s.parent, in_reply_to: [request], status, ts: "", body },
		path: "/mail/cur/reply.json",
		requests: [],
		handled: false,
	};
	s.events.emit("message:inbound", payload);
	assert.equal(payload.handled, true);
	return request;
}

function result(s: Session) {
	return s.sent.find((item) => (item.message as { details?: { kind?: string } }).details?.kind === "result")?.message as
		| { content: string; details: { check?: Check } }
		| undefined;
}

async function until<T>(read: () => T | undefined | false): Promise<T> {
	const deadline = performance.now() + 5000;
	for (;;) {
		const found = read();
		if (found) return found;
		assert.ok(performance.now() < deadline, "timed out waiting for the check or result");
		await setImmediate();
	}
}

function workspace() {
	return realpathSync(mkdtempSync(join(root, "check-")));
}

function repository() {
	const source = workspace();
	const git = (...args: string[]) => execFileSync("git", args, { cwd: source });
	git("init", "-q", "-b", "main");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "base");
	return source;
}

test("lead commands are approved in order and run in the explicit child cwd", async () => {
	const cwd = workspace();
	const approvals: unknown[] = [];
	const s = session({
		...approval,
		beforeSquire: (pi) =>
			pi.on("tool_call", (event) => {
				approvals.push(event.input);
			}),
	});
	const commands = [`  ${marker}`, 'test "$(cat check-marker)" = ran && test "$CI:$FORCE_COLOR" = 1:0'];
	const start = await delegate(s, { cwd, check: commands });
	assert.deepEqual(
		approvals,
		commands.map((command) => ({ command, cwd, delegation: start.id })),
	);
	assert.equal(s.tool("delegate_check").exposure, "deferred");
	assert.ok(!s.pi.getActiveTools().includes("delegate_check"));
	assert.ok(!existsSync(join(cwd, "check-marker")), "approval never runs the command");
	reply(s, start.id);
	assert.equal(result(s), undefined, "delivery waits for checks");
	const message = await until(() => result(s));
	assert.match(message.content, /check \(run by Squire\): pass/);
	assert.match(message.content, /child answer/);
	assert.equal(message.details.check?.status, "pass");
	assert.deepEqual(
		message.details.check?.runs.map(({ ms, ...run }) => (assert.ok(ms >= 0), run)),
		commands.map((command) => ({ command, cwd, exitCode: 0, signal: null })),
	);
	assert.equal(readFileSync(join(cwd, "check-marker"), "utf8"), "ran");
});

test("managed worktree check runs at its created root, not the lead cwd", async () => {
	const source = repository();
	const s = session({
		...approval,
		cwd: source,
		beforeSquire: (pi) =>
			pi.on("tool_call", (event) => {
				const cwd = "cwd" in event.input ? event.input.cwd : undefined;
				assert.equal(typeof cwd, "string");
				assert.ok(existsSync(join(String(cwd), ".git")));
			}),
	});
	const start = await delegate(s, { worktree: "checked", check: [marker] });
	reply(s, start.id);
	const message = await until(() => result(s));
	assert.equal(message.details.check?.status, "pass");
	assert.equal(message.details.check.runs[0].cwd, start.cwd);
	assert.equal(readFileSync(join(start.cwd, "check-marker"), "utf8"), "ran");
	assert.ok(!existsSync(join(source, "check-marker")));
});

test("a failing check reports a de-noised tail and stops the check sequence", async () => {
	const actual = workspace();
	const cwd = join(workspace(), "alias");
	symlinkSync(actual, cwd, "dir");
	const s = session({ ...approval, cwd });
	const command = String.raw`printf '\033[31mFAIL case 1\033[0m\n    at dep (%s/node_modules/x/index.js:1:2)\n    at run (%s/src/run.js:17:2)\nFAIL case 2\ntrailing noise\n' "$(pwd -P)" "$(pwd -P)" >&2; exit 2`;
	const start = await delegate(s, { check: [command, marker] });
	reply(s, start.id);
	const message = await until(() => result(s));
	assert.match(message.content, /check \(run by Squire\): fail/);
	assert.match(message.content, /exit 2 \(\d+\.\d s\)/);
	assert.deepEqual(message.details.check?.tail, ["FAIL case 1 (×2)", "at run (src/run.js:17:2)"]);
	assert.equal(message.details.check?.runs.length, 1);
	assert.equal(message.details.check?.runs[0].exitCode, 2);
	assert.ok(!existsSync(join(cwd, "check-marker")));
});

test("a marker-free tail keeps the last 20 lines from the bounded output and clips long lines", async () => {
	const s = session(approval);
	const command = String.raw`printf 'FAIL outdated\n'; awk 'BEGIN {for(i=0;i<1100000;i++)printf "x"; print ""; for(i=1;i<=21;i++)print i; printf "%0250d\n", 0}'; exit 1`;
	const start = await delegate(s, { check: [command] });
	reply(s, start.id);
	const message = await until(() => result(s));
	assert.deepEqual(message.details.check?.tail, [
		...Array.from({ length: 19 }, (_, i) => String(i + 3)),
		`${"0".repeat(199)}…`,
	]);
});

test("a vanished cwd reports a start error without losing the child answer", async () => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: [marker] });
	rmdirSync(cwd);
	reply(s, start.id);
	const message = await until(() => result(s));
	assert.match(message.content, /check \(run by Squire\): error[\s\S]*could not start in [^\n]+: ENOENT/);
	assert.match(message.content, /child answer/);
	assert.equal(message.details.check?.runs[0].exitCode, null);
});

test("a timed-out check reports an error without losing the child answer", async (t) => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: [`${marker}; sleep 60`] });
	t.mock.timers.enable({ apis: ["setTimeout"] });
	reply(s, start.id);
	await until(() => existsSync(join(cwd, "check-marker")));
	t.mock.timers.tick(300_000);
	const message = await until(() => result(s));
	assert.match(message.content, /check \(run by Squire\): error[\s\S]*timed out/);
	assert.match(message.content, /child answer/);
	assert.equal(message.details.check?.runs[0].signal, "SIGKILL");
});

test("a tool_call refusal stops launch and rolls back a managed worktree and branch", async () => {
	const cwd = repository();
	let checkedCwd: string | undefined;
	const s = session({
		...approval,
		cwd,
		beforeSquire: (pi) =>
			pi.on("tool_call", (event) => {
				if (event.toolName !== "delegate_check") return;
				checkedCwd = String(event.input.cwd);
				return { block: true, reason: "shell policy refused this command" };
			}),
	});
	await assert.rejects(
		delegate(s, { check: ["printf refused"], worktree: "refused" }),
		/printf refused.*shell policy refused this command.*rolled-back/,
	);
	assert.ok(checkedCwd);
	assert.ok(!existsSync(checkedCwd));
	assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/refused"], { cwd }).status, 1);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
});

test("a check is refused if nested execution or the approval tool is unavailable", async () => {
	for (const [options, reason] of [
		[{}, /executeTool/],
		[{ nestedTools: [] }, /delegate_check.*not callable/],
	] as const) {
		const s = session(options);
		await assert.rejects(delegate(s, { check: [marker] }), reason);
		assert.deepEqual(s.tmux.opened, []);
		assert.deepEqual(s.sendCalls, []);
	}
});

test("invalid check lists are refused before opening a child", async () => {
	const s = session(approval);
	for (const check of [[], [""], [" \n "], [null], "true", Array(6).fill("true")])
		await assert.rejects(delegate(s, { check }), /check.*1 to 5.*non-empty/);
	assert.deepEqual(s.tmux.opened, []);
});

test("a failed or stopped reply is delivered without running the approved check", async (t) => {
	for (const status of ["failed", "stopped"]) {
		await t.test(status, async () => {
			resetRoot();
			writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model", thinking: "low" }));
			const cwd = workspace();
			const s = session(approval);
			const start = await delegate(s, { cwd, check: [marker] });
			reply(s, start.id, 0, "child answer", status);
			const message = await until(() => result(s));
			assert.match(message.content, new RegExp(`^\\[delegate\\] .* · ${status}$`, "m"));
			assert.match(message.content, /child answer/);
			assert.doesNotMatch(message.content, /check \(run by Squire\)/);
			assert.equal(message.details.check, undefined);
			assert.ok(!existsSync(join(cwd, "check-marker")), "the approved command never ran");
		});
	}
});

test("a late result after explicit close is delivered without running a check", async () => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: [marker] });
	await s.toolCall("delegation_close", { id: start.id });
	reply(s, start.id);
	const message = await until(() => result(s));
	assert.match(message.content, /child answer/);
	assert.equal(message.details.check, undefined);
	assert.ok(!existsSync(join(cwd, "check-marker")));
});

test("a late reply after a gone outcome updates the result without running a check", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: [marker] });
	s.tmux.windows.delete(start.windowId);
	t.mock.timers.tick(5_000);
	await until(() => s.sent.some((item) => String(item.message.content).includes("closed without a result")));
	reply(s, start.id);
	assert.equal(result(s)?.details.check, undefined);
	assert.match(result(s)?.content ?? "", /child answer/);
	assert.ok(!existsSync(join(cwd, "check-marker")));
});

test("close kills a running check group and still delivers the claimed child answer", async () => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: ['sleep 60 & printf %s "$!" > check-pid; wait', marker] });
	reply(s, start.id);
	const path = join(cwd, "check-pid");
	const pid = await until(() => (existsSync(path) ? Number(readFileSync(path, "utf8")) : undefined));
	assert.equal(result(s), undefined);
	await s.toolCall("delegation_close", { id: start.id });
	const message = await until(() => result(s));
	assert.match(message.content, /child answer/);
	assert.equal(message.details.check?.runs[0].signal, "SIGKILL");
	await until(() => {
		const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
		return ps.status === 1 || ps.stdout.trim().startsWith("Z");
	});
	assert.ok(!existsSync(join(cwd, "check-marker")));
});

test("a restored lead uses the original approval, without nested execution at result time", async () => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, { cwd, check: [marker] });
	await s.shutdown();
	const restored = session({ parent: s.parent, entries: s.entries });
	await restored.start();
	restored.sendCalls.push(...s.sendCalls);
	reply(restored, start.id);
	assert.equal((await until(() => result(restored))).details.check?.status, "pass");
	assert.equal(readFileSync(join(cwd, "check-marker"), "utf8"), "ran");
});

test("an already-claimed result and its approval survive an interrupted check", async () => {
	const cwd = workspace();
	const s = session(approval);
	const start = await delegate(s, {
		cwd,
		check: ["if test -f checking; then printf resumed > check-marker; else touch checking; sleep 60; fi"],
	});
	reply(s, start.id);
	await until(() => existsSync(join(cwd, "checking")));
	await s.shutdown();
	assert.equal(result(s), undefined);
	const restored = session({ parent: s.parent, entries: s.entries });
	await restored.start();
	assert.equal((await until(() => result(restored))).details.check?.status, "pass");
	assert.equal(readFileSync(join(cwd, "check-marker"), "utf8"), "resumed");
});

test("a result without check keeps its exact text and synchronous delivery", async () => {
	const cwd = workspace();
	const s = session();
	const start = await delegate(s, { cwd });
	const request = reply(s, start.id);
	const message = result(s);
	assert.equal(message?.details.check, undefined);
	assert.equal(
		message?.content,
		[
			`[delegate] scout ${start.id} · done`,
			`[delegate] The task ${request} has no copy in sent/; only its id is known.`,
			`cwd: ${cwd} (not a Git checkout)`,
			"",
			"child answer",
		].join("\n"),
	);
});

test("resume approves and runs the new task's check in the resumed directory", async () => {
	const cwd = workspace();
	const s = session({ ...approval, cwd });
	const start = await delegate(s);
	reply(s, start.id);
	s.sent.splice(0);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `20261026T000000_${start.id}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: start.id,
			timestamp: "2026-10-26T00:00:00.000Z",
			cwd,
		})}\n`,
	);
	s.tmux.windows.delete(start.windowId);
	await s.toolCall("delegation_resume", { id: start.id, task: "follow-up", check: [marker] });
	reply(s, start.id, 1);
	const message = await until(() => result(s));
	assert.equal(message.details.check?.status, "pass");
	assert.equal(message.details.check.runs[0].cwd, cwd);
	assert.equal(readFileSync(join(cwd, "check-marker"), "utf8"), "ran");
});

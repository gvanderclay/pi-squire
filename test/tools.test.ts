// The model-facing tools: `delegate`, which starts without a dialog,
// `delegation_status` and `delegation_close`. These tests drive the extension
// only through its registration function: a temporary agent directory, a fake
// Pi session with a scripted `ctx.ui`, the fake tmux, `message:send` stubbed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { readChildRecords } from "../src/child-tasks.ts";
import { inspectGit } from "../src/git.ts";
import { windowLocator } from "../src/tmux.ts";
import { placementProject } from "../src/window-placement.ts";

import {
	agentDir,
	agentFile,
	cleanup,
	DEFAULT_TOOLS,
	delegationPromptPath,
	resetRoot,
	root,
	rosterDir,
	session,
	sessionDir,
	writeAgent,
	writeDelegationPrompt,
	writeLegacyAgent,
} from "./harness.ts";

const companion = placementProject(root).companion;

beforeEach(() => resetRoot());
after(() => cleanup());

const SCOUT = agentFile(
	{ description: "Looks things up", model: "alpha/fast-model", thinking: "low" },
	"You look things up.",
);
const RESEARCHER = agentFile(
	{ description: "Digs deeper", model: "alpha/deep-model", thinking: "high" },
	"You dig deeper.",
);
const SCOUT_EDITED = { description: "Looks things up differently", model: "alpha/fast-model", thinking: "low" };

// ---------------------------------------------------------------------------
// The tool description

test("the delegate tool description lists the roster and its defaults", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	const description = s.tool("delegate").description;
	assert.match(description, /scout/);
	assert.match(description, /Looks things up/);
	assert.match(description, /alpha\/fast-model/);
	assert.match(description, /thinking low/);
	assert.match(description, /researcher — Digs deeper \(default alpha\/deep-model, thinking high\)/);
	assert.match(description, /delegation_status/);
});

test("a roster written after registration shows up in the description at session start", async () => {
	const s = session();
	writeAgent("scout", SCOUT);
	await s.start();
	assert.match(s.tool("delegate").description, /scout/);
});

test("with an empty roster the description says how to add an agent", async () => {
	const s = session();
	assert.ok(
		s.tool("delegate").description.includes(join(agentDir, "agents", "<name>.md")),
		s.tool("delegate").description,
	);
});

test("an agent defined only under the legacy agents directory is neither listed nor launched", async () => {
	writeLegacyAgent("scout", SCOUT);
	const s = session();
	await s.start();
	assert.doesNotMatch(s.tool("delegate").description, /scout|Looks things up/);
	assert.equal(await s.completions(""), null);
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "do it" }), /no agents are defined/);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
});

test("inside a leaf delegate delegation tools are inactive", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ parentEnv: "some-parent" });
	await s.start();
	assert.ok(!s.pi.getActiveTools().includes("delegate"));
});

// ---------------------------------------------------------------------------
// Parent delegation context

const PARENT_SECTION = "squire_parent_delegation";
const GUIDE = `# Delegation

Use a delegate for broad exploration, and read a file directly when you need to decide.

- Keep the main context focused.
- Evaluate the findings before relying on them.
`;

test("the delegate tool explains self-contained tasks, automatic results, and substantive follow-ups", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	const description = s.tool("delegate").description;
	assert.match(description, /sees only the task and its agent prompt/);
	assert.match(description, /result arrives later as a message that starts your next turn/);
	assert.match(description, /do not poll delegation_status or mail it just to wait/);
});

test("run preparation puts the exact prompt document in the owned section and nothing else", async () => {
	writeDelegationPrompt(GUIDE);
	const s = session();
	await s.start();
	const event = await s.prepare({
		systemPrompt: "base prompt",
		sections: { other: "keep this", [PARENT_SECTION]: "stale guidance" },
		toolSnippets: { read: "Read a file" },
		toolGuidelines: { read: ["Keep this guideline"] },
		promptGuidelines: ["Keep this rule"],
		appendSystemPrompt: "Keep this append",
	});
	const options = event.systemPromptOptions;
	assert.equal(options.sections[PARENT_SECTION], GUIDE);
	assert.equal(options.sections.other, "keep this");
	assert.deepEqual(options.toolSnippets, { read: "Read a file" });
	assert.deepEqual(options.toolGuidelines, { read: ["Keep this guideline"] });
	assert.deepEqual(options.promptGuidelines, ["Keep this rule"]);
	assert.equal(options.appendSystemPrompt, "Keep this append");
	assert.deepEqual(options.selectedTools, [...DEFAULT_TOOLS, "delegate"]);
	assert.deepEqual(options.hiddenTools, []);
	assert.deepEqual(s.sent, [], "guidance is not a conversation message");
	assert.deepEqual(s.userMessages, [], "guidance is not a user message");
	assert.deepEqual(s.preparedMessages, [], "guidance is not a returned before_agent_start message");
	assert.ok(!s.tool("delegate").description.includes(GUIDE), "guidance stays out of the tool description");
	assert.equal(event.systemPrompt, "base prompt", "the whole prompt is not replaced");
});

test("no prompt file, or a whitespace-only one, adds no policy and removes stale guidance", async () => {
	const s = session();
	await s.start();
	let event = await s.prepare({ sections: { [PARENT_SECTION]: "stale" } });
	assert.deepEqual(event.systemPromptOptions.sections, {});
	writeDelegationPrompt("  \n\t\n");
	event = await s.prepare({ sections: { [PARENT_SECTION]: "stale" } });
	assert.deepEqual(event.systemPromptOptions.sections, {});
	assert.deepEqual(s.warnings, []);
});

test("editing the prompt replaces the section at the next preparation, and deleting it removes the section", async () => {
	writeDelegationPrompt(GUIDE);
	const s = session();
	await s.start();
	assert.equal((await s.prepare()).systemPromptOptions.sections[PARENT_SECTION], GUIDE);
	writeDelegationPrompt("# Revised\n\nNew guidance.\n");
	assert.equal((await s.prepare()).systemPromptOptions.sections[PARENT_SECTION], "# Revised\n\nNew guidance.\n");
	rmSync(delegationPromptPath);
	const removed = await s.prepare({ sections: { [PARENT_SECTION]: "stale" } });
	assert.equal(PARENT_SECTION in removed.systemPromptOptions.sections, false);
});

test("an unreadable prompt warns with its path, removes stale guidance, and leaves delegation usable", async () => {
	writeAgent("scout", SCOUT);
	writeDelegationPrompt(GUIDE);
	const s = session();
	await s.start();
	assert.equal((await s.prepare()).systemPromptOptions.sections[PARENT_SECTION], GUIDE);
	rmSync(delegationPromptPath);
	mkdirSync(delegationPromptPath);
	const event = await s.prepare({ sections: { [PARENT_SECTION]: "stale" } });
	assert.equal(PARENT_SECTION in event.systemPromptOptions.sections, false);
	assert.equal(s.warnings.length, 1);
	assert.ok(s.warnings[0].startsWith("delegate: could not read "), s.warnings[0]);
	assert.ok(s.warnings[0].includes(delegationPromptPath), s.warnings[0]);
	await assert.doesNotReject(s.toolCall("delegate", { agent: "scout", task: "do it" }));
	assert.equal(s.tmux.opened.length, 1);
});

test("a prompt read error is reported and clears guidance even when delegation is inactive or hidden", async () => {
	writeAgent("scout", SCOUT);
	writeDelegationPrompt(GUIDE);
	const s = session();
	await s.start();
	assert.equal((await s.prepare()).systemPromptOptions.sections[PARENT_SECTION], GUIDE);
	writeAgent("researcher", RESEARCHER);
	rmSync(delegationPromptPath);
	mkdirSync(delegationPromptPath);
	const before = s.registrations.length;

	const hidden = await s.prepare({
		selectedTools: [...DEFAULT_TOOLS, "delegate"],
		hiddenTools: ["delegate"],
		sections: { other: "keep", [PARENT_SECTION]: "stale" },
	});
	assert.deepEqual(hidden.systemPromptOptions.sections, { other: "keep" });
	assert.deepEqual(hidden.systemPromptOptions.selectedTools, [...DEFAULT_TOOLS, "delegate"]);
	assert.deepEqual(hidden.systemPromptOptions.hiddenTools, ["delegate"]);
	assert.equal(s.registrations.length, before, "a hidden tool is not re-registered");
	assert.equal(s.warnings.length, 1);
	assert.ok(s.warnings[0].includes(delegationPromptPath), s.warnings[0]);

	const inactive = await s.prepare({
		selectedTools: DEFAULT_TOOLS,
		sections: { other: "keep", [PARENT_SECTION]: "stale" },
	});
	assert.deepEqual(inactive.systemPromptOptions.sections, { other: "keep" });
	assert.deepEqual(inactive.systemPromptOptions.selectedTools, DEFAULT_TOOLS);
	assert.equal(s.registrations.length, before, "an inactive tool is not re-registered");
	assert.equal(s.warnings.length, 2);
	assert.ok(s.warnings[1].includes(delegationPromptPath), s.warnings[1]);
	await assert.doesNotReject(s.toolCall("delegate", { agent: "scout", task: "do it" }));
	assert.equal(s.tmux.opened.length, 1);
});

test("inactive or hidden delegation removes only the owned section and preserves selection", async () => {
	writeDelegationPrompt(GUIDE);
	const s = session();
	await s.start();
	const hidden = await s.prepare({
		selectedTools: [...DEFAULT_TOOLS, "delegate"],
		hiddenTools: ["delegate"],
		sections: { other: "keep", [PARENT_SECTION]: "stale" },
	});
	assert.deepEqual(hidden.systemPromptOptions.sections, { other: "keep" });
	assert.deepEqual(hidden.systemPromptOptions.selectedTools, [...DEFAULT_TOOLS, "delegate"]);
	assert.deepEqual(hidden.systemPromptOptions.hiddenTools, ["delegate"]);

	const inactive = await s.prepare({
		selectedTools: DEFAULT_TOOLS,
		sections: { other: "keep", [PARENT_SECTION]: "stale" },
	});
	assert.deepEqual(inactive.systemPromptOptions.sections, { other: "keep" });
	assert.deepEqual(inactive.systemPromptOptions.selectedTools, DEFAULT_TOOLS);
});

test("a hidden tool's changed roster is not re-registered until it is active again", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const before = s.registrations.length;
	writeAgent("researcher", RESEARCHER);
	await s.prepare({ hiddenTools: ["delegate"] });
	assert.equal(s.registrations.length, before, "re-registering a hidden tool could reactivate it");
	assert.doesNotMatch(s.tool("delegate").description, /researcher/);
	await s.prepare();
	assert.equal(s.registrations.length, before + 1);
	assert.match(s.tool("delegate").description, /researcher/);
});

test("roster edits, additions and removals reach the current run preparation without churn", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const before = s.registrations.length;
	const unchanged = await s.prepare();
	assert.equal(s.registrations.length, before, "unchanged metadata does not re-register");
	assert.match(s.tool("delegate").description, /scout — Looks things up/);
	assert.equal(unchanged.systemPromptOptions.sections[PARENT_SECTION], undefined);

	writeAgent("researcher", RESEARCHER);
	const added = await s.prepare({ messageType: "custom" });
	assert.equal(s.registrations.length, before + 1, "a custom-result preparation refreshes too");
	assert.match(s.tool("delegate").description, /researcher — Digs deeper/);
	assert.equal(added.systemPromptOptions.sections[PARENT_SECTION], undefined);

	writeAgent("scout", agentFile({ ...SCOUT_EDITED }));
	rmSync(join(rosterDir, "researcher.md"), { force: true });
	const changed = await s.prepare();
	assert.equal(s.registrations.length, before + 2);
	assert.match(s.tool("delegate").description, /scout — Looks things up differently/);
	assert.doesNotMatch(s.tool("delegate").description, /researcher/);
	assert.equal(changed.messageType, "user");
});

test("call-time validation reads a newly added agent before the description is refreshed", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	writeAgent("researcher", RESEARCHER);
	assert.doesNotMatch(s.tool("delegate").description, /researcher/);
	await s.toolCall("delegate", { agent: "researcher", task: "dig" });
	assert.equal(s.tmux.opened.length, 1);
	await s.prepare();
	assert.match(s.tool("delegate").description, /researcher/);
});

test("inside a leaf delegate run preparation removes parent guidance and restores task guidance", async () => {
	writeDelegationPrompt(GUIDE);
	const s = session({ parentEnv: "some-parent" });
	await s.start();
	const event = await s.prepare({ sections: { [PARENT_SECTION]: "keep" } });
	assert.equal(event.systemPromptOptions.sections[PARENT_SECTION], undefined);
	assert.match(
		event.systemPromptOptions.sections.squire_delegate_task,
		/Your final message reaches the session that started you automatically/,
	);
	assert.doesNotMatch(event.systemPromptOptions.sections.squire_delegate_task, /children finish|intermediate runs/);
	assert.ok(!s.pi.getActiveTools().includes("delegate"));
});

// ---------------------------------------------------------------------------
// The delegate tool: refusals

test("an invalid agent, model or thinking level is refused with close matches and starts nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "nobody", task: "do it" }), /nobody.*scout/s);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it", model: "alpha/fast-modle" }),
		/close matches: alpha\/fast-model/,
	);
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it", thinking: "hihg" }),
		/close matches: high/,
	);
	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("a model without credentials is refused by the delegate tool and starts nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ noCredentials: ["beta/other-model"] });
	await s.start();
	await assert.rejects(
		s.toolCall("delegate", { agent: "scout", task: "do it", model: "beta/other-model" }),
		/no credentials for model "beta\/other-model".*provider "beta"/,
	);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
});

test("outside tmux the delegate tool refuses and starts nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	s.tmux.inside = false;
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "do it" }), /tmux/);
	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.entries, []);
});

// ---------------------------------------------------------------------------
// The delegate tool: starting

test("a call starts the delegation with the agent's defaults and returns its id, with no dialog", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "find the answer" });

	assert.deepEqual(s.selects, []);
	assert.deepEqual(s.editors, []);
	assert.deepEqual(s.customs, []);
	const id = s.entries[0].data.id as string;
	assert.equal(result.content[0].type, "text");
	assert.ok(result.content[0].text.includes(id), result.content[0].text);
	assert.ok(result.content[0].text.includes(`scout-${id.slice(0, 8)}`), result.content[0].text);
	assert.equal(s.sendCalls[0].body, "find the answer");
	assert.equal(s.tmux.opened[0].name, `scout-${id.slice(0, 8)}`);
	assert.equal(s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(s.tmux.opened[0].argv[s.tmux.opened[0].argv.indexOf("--thinking") + 1], "low");
	assert.deepEqual(s.entries[0], {
		customType: "delegate-start-v2",
		data: {
			id,
			identity: {
				parent: s.parent,
				root: s.parent,
				rootPlacement: placementProject(root).companion,
				depth: 1,
				agent: "scout",
				chain: ["scout"],
				autoExit: true,
			},
			agent: "scout",
			model: "alpha/fast-model",
			thinking: "low",
			name: `scout-${id.slice(0, 8)}`,
			locator: windowLocator({ id: s.tmux.opened[0].windowId, name: `scout-${id.slice(0, 8)}` }),
			requestId: (s.sendCalls[0].envelope as { id: string }).id,
			autoExit: true,
			cwd: root,
			sessionDir,
			// The harness root is a temporary directory outside any Git checkout.
			workspace: { mode: "inherited", cwd: root, git: { kind: "non-git" } },
		},
	});
	assert.equal(
		s.notes.at(-1),
		`delegate: scout ${id} started in window scout-${id.slice(0, 8)} in session ${companion}`,
	);
});

test('null or "null" for an optional field means unset, so the agent\'s defaults apply', async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	for (const none of [null, "null"]) {
		await s.toolCall("delegate", {
			agent: "scout",
			task: "find it",
			model: none,
			thinking: none,
			label: none,
			auto_exit: null,
		});
		const { argv, name } = s.tmux.opened[s.tmux.opened.length - 1];
		assert.equal(argv[argv.indexOf("--model") + 1], "alpha/fast-model");
		assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
		assert.doesNotMatch(name, /null/);
	}
});

test("a label names the session and the window, shows in the reply and in delegation_status", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "find it", label: "roster" });
	const { argv, name, windowId } = s.tmux.opened[0];
	assert.equal(name, "scout-roster");
	assert.equal(argv[argv.indexOf("--name") + 1], "scout-roster");
	assert.ok(result.content[0].text.includes(`in window scout-roster in session ${companion}.`), result.content[0].text);
	const statusResult = await s.toolCall("delegation_status", {});
	const status = statusResult.content[0].text;
	assert.ok(status.includes("name: scout-roster\n"), status);
	const [detail] = (statusResult.details as { delegations: { name: string }[] }).delegations;
	assert.equal(detail.name, "scout-roster");
	assert.ok(status.includes(`window: scout-roster (${windowId})`), status);
});

test("a bad label is refused and opens no window", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "find it", label: "has space" }), /label/);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.sendCalls, []);
});

test("model and thinking overrides shape the launched argv", async () => {
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	await s.toolCall("delegate", {
		agent: "researcher",
		task: "dig",
		model: "alpha/fast-model",
		thinking: "xhigh",
	});
	const { argv } = s.tmux.opened[0];
	assert.equal(argv[argv.indexOf("--model") + 1], "alpha/fast-model");
	assert.equal(argv[argv.indexOf("--thinking") + 1], "xhigh");
	assert.equal(s.entries[0].data.model, "alpha/fast-model");
	assert.equal(s.entries[0].data.thinking, "xhigh");
});

test("without a UI the delegate tool still starts the delegation", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ hasUI: false });
	await s.start();
	const result = await s.toolCall("delegate", { agent: "scout", task: "do it" });
	assert.match(result.content[0].text, /Started delegation/);
	assert.equal(s.tmux.opened.length, 1);
	assert.deepEqual(s.selects, []);
});

test("two concurrent delegate calls each start a delegation and return their own result", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	const [one, two] = await Promise.all([
		s.toolCall("delegate", { agent: "scout", task: "answer one" }),
		s.toolCall("delegate", { agent: "researcher", task: "answer two" }),
	]);

	assert.deepEqual(s.selects, []);
	assert.equal(s.tmux.opened.length, 2);
	assert.equal(s.entries.length, 2);
	const byAgent = new Map(s.entries.map((entry) => [entry.data.agent as string, entry.data.id as string]));
	const first = one.details as { outcome: string; id: string };
	const second = two.details as { outcome: string; id: string };
	assert.equal(first.outcome, "started");
	assert.equal(second.outcome, "started");
	assert.equal(first.id, byAgent.get("scout"));
	assert.equal(second.id, byAgent.get("researcher"));
	assert.notEqual(first.id, second.id);
	assert.ok(one.content[0].text.includes(byAgent.get("scout")!), one.content[0].text);
	assert.ok(two.content[0].text.includes(byAgent.get("researcher")!), two.content[0].text);
	assert.deepEqual(s.sendCalls.map((call) => call.body).sort(), ["answer one", "answer two"]);
});

// ---------------------------------------------------------------------------
// delegation_status and delegation_close

/** One recorded delegation, as 04 writes it. */
type Delegation = { id: string; agent: string; model: string; requestId: string };

/** A reply to `delegation`'s task, shaped like `mailbox`'s envelope. */
function reply(parent: string, delegation: Delegation, status = "done", replyId = `reply-${delegation.agent}`) {
	return {
		envelope: {
			id: replyId,
			from: delegation.id,
			to: parent,
			in_reply_to: [delegation.requestId],
			status,
			ts: "2026-09-29T00:00:00.000Z",
			body: "The answer.",
		},
		path: `/mailbox/${parent}/cur/000000000000002-${replyId}.json`,
		requests: [],
		handled: false,
	};
}

/** One recorded delegation as a durable start entry, for status-selection tests. */
function recordedDelegation(parent: string, index: number, options: { running?: boolean; cwd?: string } = {}) {
	const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
	const windowId = `@${100 + index}`;
	const windowName = `scout-${id.slice(0, 8)}`;
	return {
		customType: "delegate",
		data: {
			id,
			agent: "scout",
			model: "alpha/fast-model",
			thinking: "low",
			autoExit: true,
			windowId,
			windowName,
			requestId: `request-${index}`,
			...(options.running ? {} : { settledAt: index + 1 }),
			...(options.cwd === undefined
				? {}
				: { cwd: options.cwd, workspace: { mode: "existing", cwd: options.cwd, git: { kind: "non-git" } } }),
			...(options.running
				? {}
				: {
						result: {
							status: "done",
							replyId: `reply-${index}`,
							envelopePath: `/mailbox/${parent}/cur/000000000000002-reply-${index}.json`,
						},
					}),
		},
	};
}

test("delegation_status with no delegations says so", async () => {
	const s = session();
	await s.start();
	const result = await s.toolCall("delegation_status", {});
	assert.equal(result.content[0].text, "No delegations are recorded in this session.");
});

test("delegation_status reports running, done and closed through the window and the records", async () => {
	writeAgent("scout", SCOUT);
	writeAgent("researcher", RESEARCHER);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "answer one" });
	await s.toolCall("delegate", { agent: "researcher", task: "answer two" });
	const [first, second] = s.entries.map((entry) => entry.data as Delegation);
	const [w1, w2] = s.tmux.opened;

	const running = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.match(running, /^2 delegations:/);
	assert.ok(running.includes(`${first.id} scout (alpha/fast-model, thinking low)`), running);
	assert.ok(running.includes(`name: scout-${first.id.slice(0, 8)}`), running);
	assert.ok(running.includes(`name: researcher-${second.id.slice(0, 8)}`), running);
	assert.ok(running.includes(`window: scout-${first.id.slice(0, 8)} (${w1.windowId})`), running);
	assert.equal(running.match(/state: running — the window is open and no result has arrived/g)?.length, 2);

	s.events.emit("message:inbound", reply(s.parent, first));
	s.tmux.windows.delete(w2.windowId);
	const mixed = (await s.toolCall("delegation_status", {})).content[0].text;
	assert.ok(mixed.includes(`${first.id} scout`), mixed);
	assert.match(mixed, /state: done — result status: done/);
	assert.ok(mixed.includes(`envelope: /mailbox/${s.parent}/cur/000000000000002-reply-scout.json`), mixed);
	assert.ok(!mixed.includes(`window: researcher-${second.id.slice(0, 8)} (${w2.windowId})`), mixed);
	assert.match(mixed, /state: closed — the window is gone/);

	const filtered = (await s.toolCall("delegation_status", { id: second.id })).content[0].text;
	assert.match(filtered, /^1 delegation:/);
	assert.ok(filtered.includes(second.id), filtered);
	assert.ok(!filtered.includes(first.id), filtered);
});

test("delegation_status defaults to running plus the 5 newest settled records", async () => {
	const s = session();
	const entries = Array.from({ length: 10 }, (_, index) =>
		recordedDelegation(s.parent, index, { running: index >= 8 }),
	);
	for (const entry of entries) {
		const { windowId, windowName, result } = entry.data as {
			windowId: string;
			windowName: string;
			result?: unknown;
		};
		if (result === undefined) s.tmux.addWindow(windowId, windowName);
	}
	s.entries.push(...entries);
	await s.start();
	const delegations = entries.map((entry) => entry.data as Delegation);

	const result = await s.toolCall("delegation_status", {});
	const text = result.content[0].text;
	const details = result.structuredContent as { delegations: { id: string; state: string }[] };
	assert.match(text, /^10 delegations \(2 running, 3 older omitted; pass all or an id for those\):/);
	assert.deepEqual(
		details.delegations.map((item) => item.id),
		delegations.slice(3).map((item) => item.id),
	);
	assert.equal(text.match(/^ {2}state: /gm)?.length, 7);
	assert.equal(details.delegations.length, 7);
	for (const omitted of delegations.slice(0, 3)) assert.equal(text.includes(omitted.id), false, text);

	const all = await s.toolCall("delegation_status", { all: true });
	const allText = all.content[0].text;
	assert.match(allText, /^10 delegations:/);
	assert.equal((all.structuredContent as { delegations: unknown[] }).delegations.length, 10);
	for (const delegation of delegations) assert.ok(allText.includes(delegation.id), allText);

	const omitted = await s.toolCall("delegation_status", { id: delegations[0].id });
	assert.match(omitted.content[0].text, /^1 delegation:/);
	assert.ok(omitted.content[0].text.includes(delegations[0].id), omitted.content[0].text);
	assert.equal((omitted.structuredContent as { delegations: unknown[] }).delegations.length, 1);
});

test("delegation_status compact current-format Git rows stay under 2560 bytes", async (t) => {
	const cwd = join(root, "Users", "me", "src", "project");
	mkdirSync(cwd, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	git("init", "-b", "main");
	git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial");
	const workspace = { mode: "existing" as const, cwd, git: inspectGit(cwd) };
	const s = session({ parent: "55555555-5555-4555-8555-555555555555", cwd });
	for (let index = 0; index < 5; index += 1) {
		const entry = recordedDelegation(s.parent, index);
		const id = entry.data.id;
		s.entries.push({
			customType: "delegate-start-v2",
			data: {
				...entry.data,
				locator: windowLocator({ id: entry.data.windowId, name: entry.data.windowName }),
				identity: {
					parent: s.parent,
					root: s.parent,
					rootPlacement: companion,
					depth: 1,
					agent: "scout",
					chain: ["scout"],
					autoExit: true,
				},
				cwd,
				workspace,
				sessionPath: `/Users/me/.pi/agent/sessions/--Users-me-src-project--/2026-11-13T12-00-00_${id}.jsonl`,
				result: {
					...entry.data.result,
					envelopePath: `/Users/me/.local/state/pi-session-mail/${s.parent}/cur/001794617841555-${id}.json`,
				},
			},
		});
	}
	await s.start();
	const result = await s.toolCall("delegation_status", {});
	const text = result.content[0].text;
	const size = Buffer.byteLength(text, "utf8");
	t.diagnostic(`representative default status: ${size} UTF-8 bytes`);
	assert.ok(size < 2560, `default status text is ${size} bytes\n${text}`);
	const rows = (
		result.structuredContent as {
			delegations: { id: string; workspaceSnapshot: { kind: string; workingState: string } }[];
		}
	).delegations;
	assert.equal(rows.length, 5);
	for (const block of text.split("\n\n").slice(1, -1)) assert.equal(block.split("\n").length, 5, block);
	for (const row of rows) {
		assert.equal(row.workspaceSnapshot.kind, "git");
		assert.equal(row.workspaceSnapshot.workingState, "clean");
		const full = await s.toolCall("delegation_status", { id: row.id });
		assert.deepEqual((full.structuredContent as { delegations: unknown[] }).delegations[0], row);
		assert.match(full.content[0].text, /identity: session/);
		assert.ok(full.content[0].text.split("\n").length > 5);
	}
	assert.match(text, /Pass id for a delegation’s full block/);
	assert.ok(s.tool("delegation_status").description.length <= 352);
});

test("compact settled blocks keep every resume and fork relationship", async () => {
	const s = session();
	const first = recordedDelegation(s.parent, 0);
	const next = recordedDelegation(s.parent, 1);
	s.entries.push(
		{ ...first, data: { ...first.data, resumedFrom: "previous-launch", forkedFrom: "fork-source" } },
		{ ...next, data: { ...next.data, resumedFrom: first.data.id } },
	);
	await s.start();
	const text = (await s.toolCall("delegation_status", {})).content[0].text;
	const blocks = text.split("\n\n").slice(1, -1);
	assert.equal(blocks[0].split("\n").length, 8);
	assert.match(blocks[0], / {2}resumed from previous-launch\n/);
	assert.match(blocks[0], / {2}forked from fork-source\n/);
	assert.ok(blocks[0].includes(`  resumed as ${next.data.id}\n`));
	assert.equal(blocks[1].split("\n").length, 6);
	assert.ok(blocks[1].includes(`  resumed from ${first.data.id}\n`));
});

test("delegation_status includes the first launch when it settles last, including after restore", async (t) => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const launched: Delegation[] = [];
	for (let index = 0; index < 7; index += 1) {
		await s.toolCall("delegate", { agent: "scout", task: "work" });
		launched.push(s.entries.at(-1)!.data as Delegation);
	}
	let now = Date.now();
	t.mock.method(Date, "now", () => now);
	for (const delegation of [...launched.slice(1), launched[0]]) {
		now += 1000;
		s.events.emit("message:inbound", reply(s.parent, delegation, "done", `reply-${delegation.id}`));
	}
	const expected = [launched[0], ...launched.slice(3)].map((record) => record.id);
	const ids = async (value: ReturnType<typeof session>) =>
		(
			(await value.toolCall("delegation_status", {})).structuredContent as { delegations: { id: string }[] }
		).delegations.map((record) => record.id);
	assert.deepEqual(await ids(s), expected);
	const stored = readChildRecords(s.parent);
	assert.ok(stored.every((record) => "settledAt" in record && typeof record.settledAt === "number"));
	await s.shutdown();
	const local = session({ parent: s.parent, tmux: s.tmux });
	await local.start();
	assert.deepEqual(await ids(local), expected);
	await local.shutdown();
	rmSync(join(agentDir, "squire", "child-tasks", `${s.parent}.json`));
	const transcript = session({ parent: s.parent, tmux: s.tmux, entries: structuredClone(s.entries) });
	await transcript.start();
	assert.deepEqual(await ids(transcript), expected);
});

test("legacy settled records rank oldest with stable relative order", async () => {
	const s = session();
	const entries = Array.from({ length: 7 }, (_, index) => recordedDelegation(s.parent, index));
	for (const entry of entries) delete (entry.data as { settledAt?: number }).settledAt;
	entries[6].data.settledAt = 100;
	s.entries.push(...entries);
	await s.start();
	const rows = ((await s.toolCall("delegation_status", {})).structuredContent as { delegations: { id: string }[] })
		.delegations;
	assert.deepEqual(
		rows.map((record) => record.id),
		[...entries.slice(0, 4), entries[6]].map((entry) => entry.data.id),
	);
});

for (const source of ["local", "transcript"] as const) {
	for (const invalid of ["yesterday", null, -1]) {
		test(`malformed ${source} settledAt ${JSON.stringify(invalid)} blocks restoration`, async () => {
			writeAgent("scout", SCOUT);
			const s = session();
			await s.start();
			await s.toolCall("delegate", { agent: "scout", task: "work" });
			const entry = s.entries[0];
			await s.shutdown();
			const path = join(agentDir, "squire", "child-tasks", `${s.parent}.json`);
			const entries = structuredClone(s.entries);
			if (source === "local") {
				const saved = JSON.parse(readFileSync(path, "utf8"));
				saved.state.records[0].settledAt = invalid;
				writeFileSync(path, JSON.stringify(saved));
			} else {
				rmSync(path);
				entries.push({ customType: "delegate", data: { id: entry.data.id, closed: true, settledAt: invalid } });
			}
			const reopened = session({ parent: s.parent, entries, tmux: s.tmux });
			await reopened.start();
			assert.ok(
				reopened.errors.some((error) => error.includes("invalid delegation settledAt")),
				reopened.errors.join("\n"),
			);
			await assert.rejects(reopened.toolCall("delegate", { agent: "scout", task: "new work" }), /restoration failed/);
			await reopened.shutdown();
		});
	}
}

test("gone and late result facts persist their settlement time", async (t) => {
	writeAgent("scout", SCOUT);
	t.mock.timers.enable({ apis: ["setInterval"] });
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "work" });
	const record = s.entries[0].data as Delegation;
	s.tmux.windows.clear();
	t.mock.timers.tick(5000);
	for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
	const gone = s.entries.find((entry) => entry.data.gone === true);
	assert.equal(typeof gone?.data.settledAt, "number");
	assert.equal((readChildRecords(s.parent)[0] as { settledAt?: number }).settledAt, gone?.data.settledAt);
	const later = Number(gone?.data.settledAt) + 1000;
	t.mock.method(Date, "now", () => later);
	s.events.emit("message:inbound", reply(s.parent, record));
	assert.equal(s.entries.at(-1)?.data.settledAt, later);
	assert.equal((readChildRecords(s.parent)[0] as { settledAt?: number }).settledAt, later);
	assert.match((await s.toolCall("delegation_status", {})).content[0].text, /state: done/);
	await s.shutdown();
});

test("delegation_status shows when a running delegate's session file was last written", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "one" });
	await s.toolCall("delegate", { agent: "scout", task: "two" });
	await s.toolCall("delegate", { agent: "scout", task: "three" });
	const [a, b, c] = s.entries.map((entry) => entry.data as Delegation);
	mkdirSync(sessionDir, { recursive: true });
	const touch = (d: Delegation, agoMs: number) => {
		const when = new Date(Date.now() - agoMs);
		const file = join(sessionDir, `x_${d.id}.jsonl`);
		writeFileSync(file, "");
		utimesSync(file, when, when);
		return when;
	};
	const twelve = touch(a, 12.5 * 60_000);
	touch(b, 125.5 * 60_000);
	const status = async (id: string) => s.toolCall("delegation_status", { id });
	const first = await status(a.id);
	assert.match(first.content[0].text, /state: running[^\n]* \(last active 12 min ago\)\n/);
	const detail = (first.details as { delegations: Record<string, unknown>[] }).delegations[0];
	assert.equal(detail.lastActiveAt, twelve.toISOString());
	assert.match((await status(b.id)).content[0].text, /\(last active 2 h 5 min ago\)/);
	touch(c, 1000);
	assert.match((await status(c.id)).content[0].text, /\(last active just now\)/);

	s.events.emit("message:inbound", reply(s.parent, a));
	const done = await status(a.id);
	assert.ok(!done.content[0].text.includes("last active"), done.content[0].text);
	assert.ok(!("lastActiveAt" in (done.details as { delegations: object[] }).delegations[0]));
});

test("delegation_status shows no last-active text for a running delegate without a session file", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "one" });
	const res = await s.toolCall("delegation_status", {});
	assert.ok(!res.content[0].text.includes("last active"), res.content[0].text);
	assert.ok(!("lastActiveAt" in (res.details as { delegations: object[] }).delegations[0]));
});

test("the tools declare all four annotations and stay direct", async () => {
	const s = session();
	const hints = (name: string) => s.tool(name).annotations;
	const closedWorld = { openWorldHint: false };
	assert.deepEqual(hints("delegate"), {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	});
	assert.deepEqual(hints("delegation_status"), {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		...closedWorld,
	});
	assert.deepEqual(hints("delegation_close"), {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		...closedWorld,
	});
	for (const name of ["delegate", "delegation_status", "delegation_close"]) {
		assert.equal((s.tool(name) as { exposure?: string }).exposure, undefined);
	}
});

test("structured results carry each delegation's state and subtree close members", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	const started = await s.toolCall("delegate", { agent: "scout", task: "one" });
	const { id } = started.structuredContent as { id: string };
	assert.equal(started.structuredContent, started.details);
	const states = async () =>
		(
			(await s.toolCall("delegation_status", {})).structuredContent as { delegations: { state: string }[] }
		).delegations.map((d) => d.state);
	assert.deepEqual(await states(), ["running"]);
	const { windowId, name: windowName } = s.tmux.opened[0];
	const closed = await s.toolCall("delegation_close", { id });
	assert.deepEqual(closed.structuredContent, {
		id,
		windowId,
		windowName,
		closed: true,
		complete: true,
		alreadyClosed: false,
		killed: true,
		members: [{ id, sessionId: id, windowId, windowName, closed: true, killed: true, outcome: "killed" }],
	});
	assert.deepEqual((await s.toolCall("delegation_close", { id })).structuredContent, {
		id,
		windowId,
		windowName,
		closed: true,
		complete: true,
		alreadyClosed: true,
		killed: false,
		members: [{ id, sessionId: id, windowId, windowName, closed: true, killed: false, outcome: "already-closed" }],
	});
	assert.deepEqual(await states(), ["closed"]);
});

test("legacy cwd is unknown and unopened sessions have no fabricated filename", async () => {
	const id = "0b5e1c2a-legacy-record";
	const s = session({
		entries: [
			{
				customType: "delegate",
				data: {
					id,
					agent: "scout",
					model: "alpha/fast-model",
					thinking: "low",
					windowId: "@7",
					windowName: "scout-0b5e1c2a",
					requestId: "legacy-request",
				},
			},
		],
	});
	await s.start();
	const status = await s.toolCall("delegation_status", { id });
	const item = (status.structuredContent as { delegations: Record<string, unknown>[] }).delegations[0];
	assert.equal(item.id, id);
	assert.equal(item.cwd, undefined);
	assert.match(status.content[0].text, /cwd:.*(?:unknown|not recorded)/i);
	assert.ok(!status.content[0].text.includes(`cwd: ${process.cwd()}`), status.content[0].text);
	assert.equal(item.sessionPath, undefined);
});

test("a recorded cwd is shown in delegation_status text and details", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const status = await s.toolCall("delegation_status", {});
	const item = (status.structuredContent as { delegations: Record<string, unknown>[] }).delegations[0];
	assert.equal(item.cwd, root);
	assert.equal(item.sessionDir, sessionDir);
	assert.ok(status.content[0].text.includes(`cwd: ${root}`), status.content[0].text);
});

test("nonabsolute session storage fails before mail and window", async () => {
	writeAgent("scout", SCOUT);
	const s = session({ sessionDir: "relative/sessions" });
	await s.start();
	await assert.rejects(s.toolCall("delegate", { agent: "scout", task: "inspect" }), /session.*absolute/i);
	assert.deepEqual(s.sendCalls, []);
	assert.deepEqual(s.tmux.opened, []);
	assert.deepEqual(s.entries, []);
});

test("delegation_status refuses an unknown id with the ones that exist", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	await assert.rejects(
		s.toolCall("delegation_status", { id: "nope" }),
		new RegExp(`no delegation "nope"; known: ${id}`),
	);
});

test("delegation_close kills the window and records the close without a message or wake", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	const { windowId } = s.tmux.opened[0];

	const closed = await s.toolCall("delegation_close", { id });
	assert.deepEqual(s.tmux.killed, [windowId]);
	assert.deepEqual(s.entries.at(-1), {
		customType: "delegate",
		data: { id, closed: true, settledAt: s.entries.at(-1)?.data.settledAt },
	});
	assert.equal(typeof s.entries.at(-1)?.data.settledAt, "number");
	assert.match(
		closed.content[0].text,
		new RegExp(`Closed delegation subtree ${id}.*\\n- ${id}: killed scout-${id.slice(0, 8)} \\(${windowId}\\)`),
	);
	assert.deepEqual(s.statuses.at(-1), { key: "delegate", text: undefined });
	assert.deepEqual(s.sent, [], "the tool result is the only close message");
	await s.fire("context", { messages: [] });
	await s.fire("agent_before_settle", { entries: [], continue: false });
	await s.fire("agent_settled");
	assert.deepEqual(s.sent, [], "later close imports do not wake the model");

	const again = await s.toolCall("delegation_close", { id });
	assert.match(again.content[0].text, /already-closed/);
	assert.deepEqual(s.tmux.killed, [windowId]);

	const status = (await s.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: closed — delegation_close recorded it/);
});

test("delegation_close kills the window of a delegation whose result already arrived", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const delegation = s.entries[0].data as Delegation;
	const { windowId } = s.tmux.opened[0];
	s.events.emit("message:inbound", reply(s.parent, delegation));
	assert.equal(s.tmux.windows.has(windowId), true);

	await s.toolCall("delegation_close", { id: delegation.id });
	assert.deepEqual(s.tmux.killed, [windowId]);
	assert.equal(s.tmux.windows.has(windowId), false);
});

test("delegation_close kills a matching window whose program has exited", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	const { windowId } = s.tmux.opened[0];
	s.tmux.exit(windowId);

	await s.toolCall("delegation_close", { id });
	assert.deepEqual(s.tmux.killed, [windowId]);
});

test("delegation_close kills nothing when the recorded id belongs to another window", async () => {
	writeAgent("scout", SCOUT);
	const first = session();
	await first.start();
	await first.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = first.entries[0].data.id as string;
	await first.shutdown();
	const resumed = session({ parent: first.parent, entries: first.entries });
	resumed.tmux.addWindow(first.tmux.opened[0].windowId, "vim");
	await resumed.start();

	const status = (await resumed.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: closed — the window is gone/);
	const result = await resumed.toolCall("delegation_close", { id });
	assert.match(result.content[0].text, /: absent/);
	assert.deepEqual(resumed.tmux.killed, []);
	assert.deepEqual(resumed.entries.at(-1), {
		customType: "delegate",
		data: { id, closed: true, settledAt: resumed.entries.at(-1)?.data.settledAt },
	});
	assert.equal(typeof resumed.entries.at(-1)?.data.settledAt, "number");
});

test("delegation_close and delegation_status each ask tmux once", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "one" });
	await s.toolCall("delegate", { agent: "scout", task: "two" });
	const id = s.entries[0].data.id as string;
	let before = s.tmux.listCalls;
	await s.toolCall("delegation_status", {});
	assert.equal(s.tmux.listCalls - before, 1);
	before = s.tmux.listCalls;
	await s.toolCall("delegation_close", { id });
	assert.equal(s.tmux.listCalls - before, 1);
});

test("a failed window list shows unknown and delegation_close refuses to guess", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	s.tmux.failList = "no server";
	const status = (await s.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: unknown/);
	const closed = await s.toolCall("delegation_close", { id });
	assert.equal((closed as { isError?: boolean }).isError, true);
	assert.equal((closed.structuredContent as { complete: boolean }).complete, false);
	assert.match(closed.content[0].text, /no server/);
	assert.deepEqual(s.tmux.killed, []);
});

test("delegation_close records a close when the window is already gone", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = s.entries[0].data.id as string;
	s.tmux.windows.delete(s.tmux.opened[0].windowId);

	const result = await s.toolCall("delegation_close", { id });
	assert.match(result.content[0].text, /: absent scout-/);
	assert.deepEqual(s.tmux.killed, []);
	assert.deepEqual(s.entries.at(-1), {
		customType: "delegate",
		data: { id, closed: true, settledAt: s.entries.at(-1)?.data.settledAt },
	});
	assert.equal(typeof s.entries.at(-1)?.data.settledAt, "number");
});

test("delegation_close refuses an unknown id and kills nothing", async () => {
	writeAgent("scout", SCOUT);
	const s = session();
	await s.start();
	await s.toolCall("delegate", { agent: "scout", task: "do it" });
	await assert.rejects(s.toolCall("delegation_close", { id: "nope" }), /no delegation "nope".*descendant tree/);
	assert.deepEqual(s.tmux.killed, []);
	assert.equal(s.entries.length, 1);
});

test("a resumed parent still reports a recorded close as closed", async () => {
	writeAgent("scout", SCOUT);
	const first = session();
	await first.start();
	await first.toolCall("delegate", { agent: "scout", task: "do it" });
	const id = first.entries[0].data.id as string;
	await first.toolCall("delegation_close", { id });
	const saved = structuredClone(first.entries);

	await first.shutdown();
	const resumed = session({ parent: first.parent, entries: saved });
	await resumed.start();
	assert.deepEqual(resumed.statuses, [], "a closed delegation is not counted as running");
	const status = (await resumed.toolCall("delegation_status", { id })).content[0].text;
	assert.match(status, /state: closed — delegation_close recorded it/);
	const again = await resumed.toolCall("delegation_close", { id });
	assert.match(again.content[0].text, /already-closed/);
});

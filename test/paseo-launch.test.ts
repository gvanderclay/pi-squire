// The Paseo launch parser branch by branch, and the adapter answers that need
// no conformance case: refusing before create, never asking the API for a
// coordinator Paseo did not start, and ignoring presentation ids.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { WindowOpenError, type WindowSpec } from "../src/host.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { PASEO_TOOLS_ENV, PASEO_TRUST_ENV } from "../src/paseo-child.ts";
import { paseoLaunch } from "../src/paseo-launch.ts";
import { paseoLocator } from "../src/paseo-locator.ts";
import { FakePaseo } from "./paseo-fixture.ts";

const DIRS: string[] = [];
after(() => {
	for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	mkdirSync(".scratch/tmp", { recursive: true });
	const dir = mkdtempSync(join(process.cwd(), ".scratch/tmp/paseo-launch-"));
	DIRS.push(dir);
	return dir;
}

const DIR = scratch();
const PROMPT = join(DIR, "prompt.md");
writeFileSync(PROMPT, "the delegate's instructions");
const AGENT = randomUUID();
const PARENT_AGENT = randomUUID();
const NOT_HOSTED = "this session is not hosted by Paseo";

/** What one launch always carries; a test adds, replaces or omits an entry. */
const FIELDS: Record<string, string | true> = {
	"--session-id": AGENT,
	"--name": "worker",
	"--approve": true,
	"--session-dir": DIR,
	"--model": "provider/model",
	"--thinking": "low",
	"--append-system-prompt": PROMPT,
};

function flags(overrides: Record<string, string | true> = {}, omit: string[] = []): string[] {
	const fields: Record<string, string | true> = { ...FIELDS, ...overrides };
	for (const flag of omit) delete fields[flag];
	return Object.entries(fields).flatMap(([flag, value]) => (value === true ? [flag] : [flag, value]));
}

const spec = (
	argv: readonly string[],
	env: Record<string, string> = { PI_CODING_AGENT_DIR: "/parent" },
): WindowSpec => ({
	name: "worker",
	cwd: process.cwd(),
	argv: [process.execPath, "pi", ...argv],
	env,
});

const refusal = (argv: readonly string[]): WindowOpenError => {
	try {
		paseoLaunch(spec(argv));
	} catch (error) {
		assert.ok(error instanceof WindowOpenError, String(error));
		return error;
	}
	throw new Error(`expected a refusal for ${argv.join(" ")}`);
};

const hostedEnv = (): Record<string, string | undefined> => ({ PASEO_AGENT_ID: PARENT_AGENT });

function hostFor(api: FakePaseo, env: Record<string, string | undefined> = hostedEnv()) {
	return createPaseoHost(api, env);
}

// ---- The argv parser ----

test("a launch argv becomes agent fields and environment variables", () => {
	const launch = paseoLaunch(spec(flags({ "--tools": "read,todo_*" })));
	assert.deepEqual(launch, {
		agentId: AGENT,
		title: "worker",
		model: "provider/model",
		thinking: "low",
		promptFile: PROMPT,
		env: {
			PI_CODING_AGENT_DIR: "/parent",
			PI_CODING_AGENT_SESSION_DIR: DIR,
			[PASEO_TOOLS_ENV]: "read,todo_*",
			[PASEO_TRUST_ENV]: "yes",
		},
	});
});

test("--no-approve is the trust environment's no answer", () => {
	const launch = paseoLaunch(spec(flags({ "--no-approve": true }, ["--approve"])));
	assert.equal(launch.env[PASEO_TRUST_ENV], "no");
});

test("--no-tools is an empty tool list", () => {
	const launch = paseoLaunch(spec(flags({ "--no-tools": true })));
	assert.equal(launch.env[PASEO_TOOLS_ENV], "");
});

test("a launch with neither tools flag sets no tool list", () => {
	const launch = paseoLaunch(spec(flags()));
	assert.equal(PASEO_TOOLS_ENV in launch.env, false);
	assert.equal(PASEO_TRUST_ENV in launch.env, true);
});

test("the last tools or trust flag given wins", () => {
	const noTools = paseoLaunch(spec([...flags(), "--tools", "read", "--no-tools"]));
	assert.equal(noTools.env[PASEO_TOOLS_ENV], "");
	const tools = paseoLaunch(spec(["--no-tools", ...flags({ "--tools": "read" })]));
	assert.equal(tools.env[PASEO_TOOLS_ENV], "read");
	const no = paseoLaunch(spec([...flags(), "--no-approve"]));
	assert.equal(no.env[PASEO_TRUST_ENV], "no");
	const yes = paseoLaunch(spec([...flags({ "--no-approve": true }, ["--approve"]), "--approve"]));
	assert.equal(yes.env[PASEO_TRUST_ENV], "yes");
});

test("the spec's own environment is copied, never changed", () => {
	const env = { PI_CODING_AGENT_DIR: "/parent" };
	paseoLaunch(spec(flags({ "--tools": "read" }), env));
	assert.deepEqual(env, { PI_CODING_AGENT_DIR: "/parent" });
});

test("the leading Pi command and its script are no delegate arguments", () => {
	const launch = paseoLaunch({ ...spec(flags()), argv: ["node", "/usr/local/bin/pi.js", ...flags()] });
	assert.equal(launch.agentId, AGENT);
});

test("a missing required field is refused as not opened", () => {
	for (const flag of ["--session-id", "--model", "--thinking", "--append-system-prompt"]) {
		const error = refusal(flags({}, [flag]));
		assert.equal(error.certainty, "not-opened", flag);
		assert.match(error.message, new RegExp(flag), flag);
	}
});

test("resume and fork are refused as not opened, before anything can start", () => {
	for (const flag of ["--fork", "--session"]) {
		const error = refusal([...flags(), flag, "/sessions/parent.jsonl"]);
		assert.equal(error.certainty, "not-opened", flag);
		assert.equal(error.message, "Paseo cannot resume or fork a delegate yet");
	}
});

test("any other flag or stray argument is refused by name", () => {
	const unknown = refusal([...flags(), "--resume"]);
	assert.equal(unknown.certainty, "not-opened");
	assert.match(unknown.message, /--resume/);
	const stray = refusal([...flags(), "leftover"]);
	assert.equal(stray.certainty, "not-opened");
	assert.match(stray.message, /leftover/);
	const valueless = refusal(["--session-id", AGENT, "--model"]);
	assert.equal(valueless.certainty, "not-opened");
	assert.match(valueless.message, /--model needs a value/);
});

test("a flag whose value is another flag is refused by name", () => {
	const error = refusal(["--session-id", AGENT, "--model", "--thinking", "low"]);
	assert.equal(error.certainty, "not-opened");
	assert.match(error.message, /--model needs a value/);
});

// ---- The host ----

test("a coordinator Paseo did not start never calls the API", async () => {
	const api = new FakePaseo();
	api.failAll = true;
	const host = hostFor(api, {});
	assert.equal(host.unavailable(), NOT_HOSTED);
	assert.equal(await host.unavailable(true), NOT_HOSTED);
	const locator = { adapter: "paseo", version: 1, kind: "window", agent: AGENT, name: "worker" };
	const asked = await host.states();
	assert.equal(asked.answered, false);
	assert.equal(asked.state({ locator }), "unknown");
	await assert.rejects(asked.close({ locator }), /not hosted by Paseo/);
	await assert.rejects(host.states(true), /not hosted by Paseo/);
	assert.deepEqual(api.calls, [], "the router's poll must not load the SDK or contact the daemon");
});

test("the environment object is read at each call, not when the host is made", async () => {
	const api = new FakePaseo();
	const env: Record<string, string | undefined> = {};
	const host = hostFor(api, env);
	assert.equal(host.unavailable(), NOT_HOSTED);
	env.PASEO_AGENT_ID = AGENT;
	assert.equal(host.unavailable(), undefined);
	await host.states();
	assert.equal(api.calls.filter((call) => call === "live").length, 1);
	delete env.PASEO_AGENT_ID;
	assert.equal(host.unavailable(), NOT_HOSTED);
});

test("openWindow creates the agent from the fields the launch asks for", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const window = spec(flags({ "--tools": "read" }));
	const opened = await host.openWindow(window, "current", "delegates");
	assert.deepEqual(api.created, [
		{
			agentId: AGENT,
			parentAgentId: PARENT_AGENT,
			title: "worker",
			cwd: window.cwd,
			model: "provider/model",
			thinking: "low",
			systemPrompt: "the delegate's instructions",
			env: {
				PI_CODING_AGENT_DIR: "/parent",
				PI_CODING_AGENT_SESSION_DIR: DIR,
				[PASEO_TOOLS_ENV]: "read",
				[PASEO_TRUST_ENV]: "yes",
			},
		},
	]);
	assert.deepEqual(opened, {
		id: AGENT,
		session: undefined,
		sessionId: `paseo-session-${AGENT}`,
		locator: { adapter: "paseo", version: 1, kind: "window", agent: AGENT, name: "worker" },
	});
	assert.ok(paseoLocator(opened.locator));
});

test("a launch links to the call-time Paseo parent, not the Pi session or root", async () => {
	const api = new FakePaseo();
	const env = hostedEnv();
	const host = hostFor(api, env);
	const first = spec(flags(), { PI_DELEGATE_PARENT: "pi-parent-session", PI_DELEGATE_ROOT: "pi-root-session" });
	await host.openWindow(first, "current", "");
	const nextParent = randomUUID();
	env.PASEO_AGENT_ID = nextParent;
	const second = { ...first, cwd: "/another/worktree", argv: spec(flags({ "--session-id": randomUUID() })).argv };
	await host.openWindow(second, "current", "");
	assert.deepEqual(
		api.created.map((input) => input.parentAgentId),
		[PARENT_AGENT, nextParent],
	);
	assert.deepEqual(
		api.created.map((input) => input.cwd),
		[first.cwd, second.cwd],
	);
	assert.equal(api.created[1].env.PI_DELEGATE_PARENT, "pi-parent-session", "Squire ancestry stays independent");
});

test("a launch with no Paseo parent refuses before contacting the daemon", async () => {
	const api = new FakePaseo();
	api.failAll = true;
	const host = hostFor(api, {});
	await assert.rejects(host.openWindow(spec(flags()), "current", ""), (error: unknown) => {
		assert.ok(error instanceof WindowOpenError);
		assert.equal(error.certainty, "not-opened");
		assert.match(error.message, /not hosted by Paseo/);
		return true;
	});
	assert.deepEqual(api.calls, []);
});

test("a launch Paseo cannot honour is refused before any create", async () => {
	const cases: string[][] = [
		[...flags(), "--fork", "/sessions/parent.jsonl"],
		[...flags(), "--session", "/sessions/parent.jsonl"],
		[...flags(), "--resume"],
		[...flags(), "leftover"],
	];
	for (const argv of cases) {
		const api = new FakePaseo();
		const host = hostFor(api);
		await assert.rejects(host.openWindow(spec(argv), "current", ""), (error: unknown) => {
			assert.ok(error instanceof WindowOpenError);
			assert.equal(error.certainty, "not-opened");
			return true;
		});
		assert.deepEqual(api.calls, [], argv.join(" "));
	}
});

test("an unreadable system prompt refuses as not opened before any create", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const argv = flags({ "--append-system-prompt": join(DIR, "missing-prompt.md") });
	await assert.rejects(host.openWindow(spec(argv), "current", ""), (error: unknown) => {
		assert.ok(error instanceof WindowOpenError);
		assert.equal(error.certainty, "not-opened");
		assert.match(error.message, /could not read the delegate's system prompt/);
		return true;
	});
	assert.deepEqual(api.calls, [], "nothing reached the daemon");
});

test("a create the daemon refuses is unknown certainty", async () => {
	const api = new FakePaseo();
	api.failCreate = "the daemon refused the agent";
	const host = hostFor(api);
	await assert.rejects(host.openWindow(spec(flags()), "current", ""), (error: unknown) => {
		assert.ok(error instanceof WindowOpenError);
		assert.equal(error.certainty, "unknown");
		assert.match(error.message, /the daemon refused the agent/);
		return true;
	});
});

test("one listing answers running and gone, and another agent's record is unknown", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const first = await host.openWindow(spec(flags({ "--session-id": randomUUID() })), "current", "");
	const second = await host.openWindow(spec(flags({ "--session-id": randomUUID() })), "current", "");
	api.running.delete(second.id);
	const states = await host.states();
	assert.equal(states.state(first), "running");
	assert.equal(states.state(second), "gone");
	assert.equal(states.listed(first), true);
	assert.equal(states.listed(second), false);
	assert.equal(
		states.state({ locator: { adapter: "tmux", version: 1, kind: "window", id: "@1", name: "x" } }),
		"unknown",
	);
	assert.equal(api.calls.filter((call) => call === "live").length, 1, "one listing answers every record");
});

test("a listing that fails leaves every record unknown and closes nothing", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	api.failLive = true;
	const asked = await host.states();
	assert.equal(asked.answered, false);
	assert.equal(asked.state(opened), "unknown");
	await assert.rejects(asked.close(opened), /none closed/);
	await assert.rejects(host.states(true), /could not ask Paseo for its agents/);
	assert.equal(api.running.has(opened.id), true);
	assert.deepEqual(api.removals, [], "a failed listing never deletes");
});

test("an archived agent reads gone but an explicit close still deletes its UUID", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	// The daemon archived the row: it no longer lists it, but it still holds it.
	api.running.delete(opened.id);
	api.archived.add(opened.id);
	const states = await host.states();
	assert.equal(states.state(opened), "gone");
	assert.equal(states.listed(opened), false);
	assert.equal(await states.close(opened), true, "the recorded locator, not the listing, is authority");
	assert.deepEqual(api.removals, [opened.id], "remove is asked for exactly the recorded UUID");
	assert.equal(api.archived.has(opened.id), false, "the archived row is terminally deleted");
	assert.equal(await (await host.states()).state(opened), "gone");
	assert.equal(await (await host.states()).close(opened), false, "a second close finds nothing to delete");
	assert.deepEqual(api.removals, [opened.id, opened.id], "the second close still asks the daemon");
});

test("an agent that does not exist closes false after one delete attempt", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	api.running.delete(opened.id);
	const states = await host.states();
	assert.equal(states.state(opened), "gone");
	assert.equal(await states.close(opened), false, "the daemon answers that nothing was deleted");
	assert.deepEqual(api.removals, [opened.id]);
});

test("close refuses a foreign locator and never picks an agent by a presentation id", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	const states = await host.states(true);
	const tmux = { locator: { adapter: "tmux", version: 1, kind: "window", id: "@1", name: "worker" } };
	await assert.rejects(states.close(tmux), /close refused/);
	const presentation = { windowId: opened.id, windowName: "worker" };
	assert.equal(states.state(presentation), "unknown", "a presentation id is not an agent identity");
	await assert.rejects(states.close(presentation), /close refused/);
	assert.equal(api.running.has(opened.id), true, "no agent was selected or deleted");
	assert.equal(await states.close(opened), true);
	assert.equal(api.running.has(opened.id), false);
});

test("a refused delete is reported with the agent that may still run", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	api.failRemove = true;
	await assert.rejects(
		host.closeTaskless(opened),
		new RegExp(`the delegate's Paseo agent ${opened.id} could not be closed and may still run Pi with no task`),
	);
	assert.equal(api.running.has(opened.id), true);
	api.failRemove = false;
	await host.closeTaskless(opened);
	assert.equal(api.running.has(opened.id), false);
});

test("show words the Paseo app and spends no verification", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	let verified = 0;
	const answer = await host.show({ windowId: opened.id, locator: opened.locator }, async () => {
		verified++;
		return true;
	});
	assert.deepEqual(answer, {
		text: `a Paseo delegate has no terminal; open agent ${opened.id} in the Paseo app`,
		brief: "open it in Paseo",
	});
	assert.equal(verified, 0);
});

test("peek reads the agent's recent activity without changing its state", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	const text = await host.peek({ windowId: opened.id, locator: opened.locator });
	assert.match(text, /SQUIRE-ADAPTER-SCREEN/);
	assert.equal((await host.states()).state(opened), "running");
});

test("peek refuses a record that is not a Paseo agent", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	const tmux = {
		windowId: opened.id,
		locator: { adapter: "tmux", version: 1, kind: "window", id: "@1", name: "worker" },
	};
	await assert.rejects(host.peek(tmux), /invalid or unsupported delegate window locator/);
	assert.equal(api.calls.includes("activity"), false);
});

test("ownsLocator accepts only its own agent codec", async () => {
	const api = new FakePaseo();
	const host = hostFor(api);
	const opened = await host.openWindow(spec(flags()), "current", "");
	assert.equal(host.ownsLocator(opened.locator), true);
	assert.equal(host.ownsLocator(opened.locator, { windowId: opened.id }), true);
	assert.equal(host.ownsLocator(opened.locator, { windowId: randomUUID() }), false);
	assert.equal(host.ownsLocator({ windowId: opened.id, windowName: "worker" }), false);
	assert.equal(host.ownsLocator({ adapter: "tmux", version: 1, kind: "window", id: "@1", name: "worker" }), false);
});

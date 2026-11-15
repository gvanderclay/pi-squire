import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostAdmission } from "../src/host-admission.ts";
import { createHostRouter } from "../src/multiplexer.ts";
import { FakeTmux } from "./fake-tmux.ts";

test("admission freezes the concrete host and placement once; later settings do not affect it", async () => {
	const first = new FakeTmux();
	const second = new FakeTmux();
	Object.defineProperty(second, "id", { value: "second" });
	let choice = "tmux";
	let reads = 0;
	const router = createHostRouter(
		[first, second],
		() => choice,
		() => undefined,
		"unavailable",
	);
	const admission = createHostAdmission(router, () => {
		reads++;
		return { placement: "companion", companionSuffix: "frozen" };
	});
	const admitted = await admission.admit();
	choice = "second";
	assert.equal(admitted.client, first);
	assert.equal(admitted.placement, "companion");
	assert.equal(admitted.companionSuffix, "frozen");
	assert.equal(reads, 1);
	assert.equal(Object.isFrozen(admitted), true);
	assert.equal((await admission.admit()).client, second);
});

test("availability probes leave placement and selection freezing until full admission", async () => {
	const host = new FakeTmux();
	let reads = 0;
	const gate = createHostAdmission(host, () => {
		reads++;
		throw new Error("invalid placement");
	});
	assert.equal(gate.probe(), undefined);
	assert.equal(reads, 0);
	await assert.rejects(gate.admit(), /invalid placement/);
	assert.equal(reads, 1);
});

test("unselected router refuses before reading any concrete-host facts or placement", async () => {
	const router = createHostRouter(
		[],
		() => {
			throw new Error("selection refused");
		},
		() => undefined,
		"unavailable",
	);
	const gate = createHostAdmission(router, () => {
		throw new Error("placement must not be read");
	});
	assert.match(gate.probe() ?? "", /^selection refused\. Host prerequisite: fix the host selection or availability/);
	await assert.rejects(
		gate.admit(),
		/^Error: selection refused\. Host prerequisite: fix the host selection or availability.*delegate-doctor/,
	);
});

test("host actions follow each refusal cause, preserve it verbatim first, and keep tool hints short", async () => {
	const cases: [string, RegExp][] = [
		[
			"this session is not inside tmux; start it in a tmux pane to open a delegate window",
			/install tmux >=3\.2.*tmux new-session/,
		],
		["delegate windows need tmux 3.2 or later; this is tmux 3.1", /install tmux >=3\.2/],
		[
			// The settings path holds both host words; only the cause prefix may choose the advice.
			'this session is inside neither tmux nor Herdr; start Pi in a tmux pane or a Herdr pane to open a delegate (or set "multiplexer" in /home/u/paseo-herdr/agent/squire/settings.json)',
			/install tmux >=3\.2.*tmux new-session/,
		],
		[
			'this session is inside both tmux and Herdr, so pi-squire will not guess; set "multiplexer" in /agent/squire/settings.json',
			/set "multiplexer": "tmux" or "herdr".*PI_DELEGATE_MULTIPLEXER/,
		],
		[
			'invalid multiplexer settings /agent/squire/settings.json: multiplexer must be "tmux" or "herdr", not "bad"',
			/set "multiplexer": "tmux" or "herdr"/,
		],
		[
			'invalid PI_DELEGATE_MULTIPLEXER "bad" from this delegate\'s launcher',
			/fix PI_DELEGATE_MULTIPLEXER.*valid values: tmux, herdr, paseo/,
		],
		["could not read squire settings /agent/squire/settings.json: invalid JSON", /fix the Squire settings file/],
		["invalid squire settings /agent/squire/settings.json: expected an object", /fix the Squire settings file/],
		[
			"this session is not hosted by Paseo",
			/run Pi inside a Paseo agent, or fix\/unset a stale PI_DELEGATE_MULTIPLEXER=paseo/,
		],
		["Paseo is not running: /private/paseo.pid is missing", /start the Paseo daemon, check paseo status/],
		["Paseo daemon unavailable: refused", /check paseo status and the Paseo daemon connection/],
		[
			"this session is not inside a Herdr pane (multiplexer: herdr)",
			/start Pi in a Herdr pane with a running compatible Herdr server/,
		],
		["Herdr delegation needs a running, compatible protocol 22 server", /running compatible Herdr server/],
		["Herdr session/socket identity changed; launch refused", /restart Pi there/],
		["this Pi's Herdr pane w1:p1 moved from workspace w1 to w2 since it started", /move the Herdr pane back/],
		["could not ask Herdr for the parent pane/server: failed", /running compatible Herdr server/],
		// Paths and nested errors inside a cause hold other causes' words; only the prefix counts.
		[
			"could not read squire settings /home/u/invalid multiplexer/agent/squire/settings.json: invalid JSON",
			/fix the Squire settings file/,
		],
		[
			'this session is inside neither tmux nor Herdr; start Pi in a tmux pane or a Herdr pane to open a delegate (or set "multiplexer" in /home/invalid PI_DELEGATE_MULTIPLEXER/agent/squire/settings.json)',
			/install tmux >=3\.2.*tmux new-session/,
		],
		[
			"Paseo is not running: /home/this session is not hosted by Paseo/.paseo/paseo.pid is missing",
			/start the Paseo daemon, check paseo status/,
		],
		[
			"could not ask Herdr for the parent pane/server: Error: ENOENT /tmp/Paseo is not running/herdr.sock; no tmux fallback was attempted",
			/running compatible Herdr server/,
		],
		[
			"Herdr delegation needs a running, compatible protocol 22 server (this session is not inside tmux)",
			/running compatible Herdr server/,
		],
	];
	for (const [cause, action] of cases) {
		const host = new FakeTmux();
		host.unavailable = ((check?: true) => (check ? Promise.resolve(cause) : cause)) as typeof host.unavailable;
		const gate = createHostAdmission(host, () => {
			throw new Error("placement must not be read");
		});
		const command = gate.probe() ?? "";
		assert.ok(command.startsWith(`${cause}. Host prerequisite:`), command);
		assert.match(command.slice(cause.length), action);
		// Only a host with no usable terminal tells the user to install tmux.
		if (
			/^(this session is not inside tmux|delegate windows need tmux|this session is inside neither)/.test(cause) ===
			false
		)
			assert.doesNotMatch(command, /brew install|apt install|tmux new-session/);
		await assert.rejects(gate.admit(), { message: command });
		const tool = `${cause}. Ask the user to fix the host; /delegate-doctor shows details.`;
		assert.equal(gate.probe("tool"), tool);
		await assert.rejects(gate.admit("tool"), { message: tool });
		assert.equal(host.opened.length, 0);
	}
});

test("a host without window placement never reads terminal settings", async () => {
	const host = new FakeTmux();
	Object.defineProperty(host, "usesWindowPlacement", { value: false });
	const gate = createHostAdmission(host, () => {
		throw new Error("terminal setting read");
	});
	const admitted = await gate.admit();
	assert.equal(admitted.client, host);
	assert.equal(admitted.placement, "current");
	assert.equal(admitted.companionSuffix, "delegates");
});

test("configuration hosts refuse before-open task mail for every start kind at admission", async () => {
	for (const kind of ["launch", "resume", "fork"] as const) {
		const host = Object.assign(new FakeTmux(), {
			configureStart: async () => {
				throw new Error("configuration must not run");
			},
		});
		host.taskMailTiming = (candidate) => (candidate === kind ? "before-open" : "after-open");
		const gate = createHostAdmission(host, () => {
			throw new Error("placement must not be read");
		});
		await assert.rejects(gate.admit(), {
			message: `internal delegate host error: tmux provides configureStart but mails ${kind} tasks before open; configuration requires after-open task mail`,
		});
		assert.equal(host.opened.length, 0);
	}
});

test("version refusal wins over invalid placement at full admission", async () => {
	const host = new FakeTmux();
	host.versionText = "tmux 3.1";
	const gate = createHostAdmission(host, () => {
		throw new Error("placement read too early");
	});
	assert.equal(gate.probe(), undefined);
	await assert.rejects(gate.admit(), /tmux.*3\./);
});

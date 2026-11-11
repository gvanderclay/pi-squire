// Task 6: a coordinator hosted by Paseo launches through Paseo and treats it
// as the actual host, whatever a setting, a launcher variable or a terminal
// environment says. Outside Paseo every choice keeps its previous answer, and
// the daemon is never asked, so a tmux coordinator needs no Paseo at all.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import type { DelegateHost } from "../src/host.ts";
import { chooseMultiplexer, createMultiplexer } from "../src/multiplexer.ts";
import { createPaseoHost } from "../src/paseo.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";
import { FakePaseo } from "./paseo-fixture.ts";

const settingsFile = join(agentDir, "squire", "settings.json");
function setSetting(value: unknown): void {
	mkdirSync(join(agentDir, "squire"), { recursive: true });
	writeFileSync(settingsFile, JSON.stringify(value));
}
const AGENT = "6f1d0b2e-6b7a-4f3c-9a10-3c6d5e8f7a21";
const wires: HerdrWire[] = [];
beforeEach(() => resetRoot());
after(() => {
	for (const wire of wires.splice(0)) wire.dispose();
	cleanup();
});
/** A Herdr host present or absent, without a socket. */
function herdrHost(inside: boolean): HerdrWire {
	const wire = new HerdrWire();
	wire.unavailable = !inside;
	wires.push(wire);
	return wire;
}
/** A Paseo host whose API refuses any call: reaching it is the failure. */
function paseoHost(env: Record<string, string | undefined>): { host: DelegateHost; api: FakePaseo } {
	const api = new FakePaseo();
	api.failAll = true;
	return { host: createPaseoHost(api, env), api };
}

test("a Paseo-hosted Pi launches through Paseo whatever the setting, launcher or terminals say", async () => {
	for (const setting of ["tmux", "herdr"]) {
		setSetting({ multiplexer: setting });
		for (const inTmux of [true, false])
			for (const inHerdr of [true, false])
				for (const inherited of [undefined, "tmux", "herdr"])
					assert.equal(
						chooseMultiplexer({ agentDir, inherited, inTmux, inHerdr, inPaseo: true }),
						"paseo",
						`setting ${setting}, tmux ${inTmux}, Herdr ${inHerdr}, launcher ${inherited}`,
					);
	}
	setSetting({});
	const tmux = new FakeTmux();
	tmux.inside = true;
	const { host, api } = paseoHost({ PASEO_AGENT_ID: AGENT });
	const mux = createMultiplexer(
		tmux,
		herdrHost(true).client,
		() => agentDir,
		() => "tmux",
		host,
	);
	assert.equal(mux.forLaunch?.().id, "paseo");
	assert.equal(mux.unavailable(), undefined);
	assert.deepEqual(api.calls, [], "the launch decision asked the daemon nothing");
});

test("outside Paseo every detection, setting and terminal launcher answer is unchanged", () => {
	setSetting({});
	const base = { agentDir, inherited: undefined, inPaseo: false };
	assert.equal(chooseMultiplexer({ ...base, inTmux: true, inHerdr: false }), "tmux");
	assert.equal(chooseMultiplexer({ ...base, inTmux: false, inHerdr: true }), "herdr");
	assert.throws(() => chooseMultiplexer({ ...base, inTmux: true, inHerdr: true }), /inside both tmux and Herdr/);
	assert.throws(() => chooseMultiplexer({ ...base, inTmux: false, inHerdr: false }), /inside neither tmux nor Herdr/);
	for (const forced of ["tmux", "herdr"] as const) {
		setSetting({ multiplexer: forced });
		assert.equal(
			chooseMultiplexer({
				...base,
				inherited: forced === "tmux" ? "herdr" : "tmux",
				inTmux: true,
				inHerdr: true,
			}),
			forced,
			"the setting still beats every other answer",
		);
	}
	setSetting({});
	assert.equal(chooseMultiplexer({ ...base, inherited: "tmux", inTmux: false, inHerdr: false }), "tmux");
	assert.equal(chooseMultiplexer({ ...base, inherited: "herdr", inTmux: true, inHerdr: true }), "herdr");
	assert.throws(
		() => chooseMultiplexer({ ...base, inherited: "screen", inTmux: true, inHerdr: false }),
		/invalid PI_DELEGATE_MULTIPLEXER "screen"/,
	);
	// A launcher that recorded Paseo is accepted even without the agent id: the
	// launch then refuses through Paseo instead of guessing a terminal window.
	assert.equal(chooseMultiplexer({ ...base, inherited: "paseo", inTmux: false, inHerdr: false }), "paseo");
});

test("a router outside Paseo completes an ask without touching the daemon", async () => {
	const tmux = new FakeTmux();
	tmux.inside = true;
	const { host, api } = paseoHost({});
	const mux = createMultiplexer(
		tmux,
		herdrHost(false).client,
		() => agentDir,
		() => undefined,
		host,
	);
	assert.equal((await mux.states()).answered, true);
	assert.equal(mux.forLaunch?.().id, "tmux");
	assert.equal(await mux.currentWindow?.(), undefined);
	await mux.states(true);
	assert.deepEqual(api.calls, [], "no listing, version check or create reached the daemon's API");
});

test("a Paseo-hosted Pi never adopts a terminal window for startup recovery", async () => {
	const observed = { id: "@9", name: "worker" };
	let asked = 0;
	const tmux = Object.assign(new FakeTmux(), {
		currentWindow: async () => {
			asked += 1;
			return observed;
		},
	});
	tmux.inside = true;
	const wire = herdrHost(true);
	const { host, api } = paseoHost({ PASEO_AGENT_ID: AGENT });
	const mux = createMultiplexer(
		tmux,
		wire.client,
		() => agentDir,
		() => "tmux",
		host,
	);
	assert.equal(mux.forLaunch?.().id, "paseo");
	assert.equal(await mux.currentWindow?.(), undefined, "a Paseo process has no terminal window to recover");
	assert.equal(asked, 0, "the terminal's current window was never asked for");
	assert.deepEqual(api.calls, [], "startup recovery asked the daemon nothing either");
	// The same terminal evidence outside Paseo still decides: the launcher's backend recovers.
	const outside = createMultiplexer(
		tmux,
		wire.client,
		() => agentDir,
		() => "tmux",
		paseoHost({}).host,
	);
	assert.deepEqual(await outside.currentWindow?.(), observed);
	assert.equal(asked, 1);
});

// Herdr's default session: its panes have HERDR_ENV=1, pane/workspace/socket
// context and no HERDR_SESSION, and `status server --json` reports
// `"session": null`. It must be detected and routed by socket, never by a
// guessed name, while named sessions keep `--session <name>`.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHerdrClient, type HerdrRoute, herdrInvocation } from "../src/herdr.ts";
import { herdrLocator, herdrPaneLocator } from "../src/herdr-locator.ts";
import { chooseMultiplexer } from "../src/multiplexer.ts";
import { askWindowStates } from "../src/window-state.ts";
import { agentDir, agentFile, cleanup, resetRoot, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";

const SOCKET = "/mock/.config/herdr/herdr.sock";
const wires: HerdrWire[] = [];
beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low" }));
});
after(() => {
	for (const wire of wires) wire.dispose();
	cleanup();
});
function wire(session: string | null, socket = SOCKET): HerdrWire {
	const value = new HerdrWire(session, socket);
	wires.push(value);
	return value;
}

const KEYS = ["HERDR_ENV", "HERDR_SESSION", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "TMUX"];
function withEnv<T>(env: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
	for (const key of KEYS) {
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	return body().finally(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});
}
/** The user-reported default-session pane, with HERDR_SESSION unset or empty. */
const defaultPane = (session?: string): Record<string, string | undefined> => ({
	HERDR_ENV: "1",
	HERDR_SESSION: session,
	HERDR_WORKSPACE_ID: "w4",
	HERDR_PANE_ID: "w4:p1",
	HERDR_SOCKET_PATH: SOCKET,
});

test("a default-session Herdr pane (no HERDR_SESSION) is detected and checked by socket with session null", async () => {
	for (const session of [undefined, ""]) {
		const calls: HerdrRoute[] = [];
		let reported: { session: string | null; socket: string } = { session: null, socket: SOCKET };
		const client = createHerdrClient({
			run: async (route, args) => {
				calls.push(route);
				if (args[0] === "status")
					return JSON.stringify({
						running: true,
						compatible: true,
						endpoint_compatible: true,
						protocol: 22,
						...reported,
					});
				if (args[0] === "pane" && args[1] === "get")
					return JSON.stringify({
						result: { pane: { pane_id: "w4:p1", tab_id: "w4:t1", workspace_id: "w4", terminal_id: "t" } },
					});
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		});
		await withEnv(defaultPane(session), async () => {
			assert.equal(client.unavailable(), undefined, "a default-session pane is inside Herdr");
			const inHerdr = client.unavailable() === undefined;
			assert.equal(chooseMultiplexer({ agentDir, inherited: undefined, inTmux: false, inHerdr }), "herdr");
			assert.equal(await client.unavailable(true), undefined);
			assert.ok(calls.length > 0);
			assert.ok(calls.every((route) => route.session === null && route.socket === SOCKET));
			// The server must positively be the default session on this exact socket.
			reported = { session: "default", socket: SOCKET };
			assert.match((await client.unavailable(true)) ?? "", /identity changed/);
			reported = { session: null, socket: "/other/herdr.sock" };
			assert.match((await client.unavailable(true)) ?? "", /identity changed/);
			reported = { session: null, socket: SOCKET };
		});
	}
	await withEnv({ ...defaultPane(), HERDR_SOCKET_PATH: undefined }, async () => {
		const client = createHerdrClient({ run: () => Promise.reject(new Error("must not be asked")) });
		assert.match(client.unavailable() ?? "", /not inside a Herdr pane \(needs HERDR_ENV=1.*HERDR_SOCKET_PATH\)/);
	});
});

test("default-session calls omit --session, drop HERDR_SESSION and pin the caller's socket; named keep --session", () => {
	const env = { HERDR_SESSION: "", HERDR_SOCKET_PATH: "/ambient.sock", OK: "yes" };
	const fallback = herdrInvocation({ session: null, socket: SOCKET }, ["status", "server", "--json"], env);
	assert.deepEqual(fallback.argv, ["status", "server", "--json"]);
	assert.equal("HERDR_SESSION" in fallback.env, false);
	assert.equal(fallback.env.HERDR_SOCKET_PATH, SOCKET);
	assert.equal(fallback.env.OK, "yes");
	const named = herdrInvocation({ session: "work", socket: "/s.sock" }, ["api", "snapshot"], env);
	assert.deepEqual(named.argv, ["--session", "work", "api", "snapshot"]);
	assert.deepEqual(named.env, env, "named-session routing is unchanged");
});

test("default-session locators persist session null; empty or missing sessions stay invalid", async () => {
	const h = wire(null);
	const record = await h.open("default-tab");
	const own = herdrLocator(record.locator);
	assert.ok(own);
	assert.equal(own.session, null);
	assert.equal(own.socket, SOCKET);
	assert.ok(herdrLocator(JSON.parse(JSON.stringify(own))), "survives a JSON round trip");
	assert.ok(h.calls.every((call) => call.session === null && call.socket === SOCKET));
	assert.equal(herdrLocator({ ...own, session: "" }), undefined);
	const { session: _drop, ...missing } = own;
	assert.equal(herdrLocator(missing), undefined);
	assert.ok(herdrPaneLocator({ ...own, kind: "pane", launchFile: undefined }));
	assert.equal(herdrPaneLocator({ ...own, kind: "pane", session: "" }), undefined);
	const states = await askWindowStates(h.client);
	assert.equal(states.state(record), "running");
	assert.equal(await states.close(record), true);
});

test("historical routing keeps default and named Herdr sessions apart", async () => {
	const fallback = wire(null);
	const named = wire("work", "/mock/.config/herdr/sessions/work/herdr.sock");
	const fromDefault = await fallback.open("from-default");
	const fromNamed = await named.open("from-named");
	// Each context recognizes only its own session's records, never closes the other's.
	const seenByNamed = await askWindowStates(named.client);
	assert.equal(seenByNamed.state(fromDefault), "unknown");
	assert.equal(seenByNamed.state(fromNamed), "running");
	await assert.rejects(seenByNamed.close(fromDefault), /could not verify Herdr terminal identity/);
	const seenByDefault = await askWindowStates(fallback.client);
	assert.equal(seenByDefault.state(fromNamed), "unknown");
	await assert.rejects(seenByDefault.close(fromNamed), /could not verify Herdr terminal identity/);
	// A default-session context on another socket is a different server.
	const elsewhere = wire(null, "/elsewhere/herdr.sock");
	assert.equal((await askWindowStates(elsewhere.client)).state(fromDefault), "unknown");
	const session = { path: "/sessions/x.jsonl", id: "x" };
	await assert.rejects(
		named.client.guardSession!(fromDefault, session, named.client),
		/ran in the default Herdr session \(socket \/mock\/\.config\/herdr\/herdr\.sock\), not Herdr session work/,
	);
	await assert.rejects(
		fallback.client.guardSession!(fromNamed, session, fallback.client),
		/ran in Herdr session work .*not the default Herdr session/,
	);
	await fallback.client.guardSession!(fromDefault, session, fallback.client);
});

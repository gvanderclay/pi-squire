import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { herdrLocator } from "../src/herdr-locator.ts";
import type { DelegateHost, OpenedWindow, WindowSpec } from "../src/host.ts";
import { readIdentity } from "../src/identity.ts";
import type { StartedRecorded } from "../src/results.ts";
import { readTree } from "../src/tree-registry.ts";
import type { WindowPlacement } from "../src/window-placement.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { agentFile, cleanup, resetRoot, root, session, sessionDir, writeAgent } from "./harness.ts";
import { HerdrWire } from "./herdr-adapter-fixture.ts";
import { MemoryHost } from "./memory-host.ts";

beforeEach(() => {
	resetRoot();
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
});
after(cleanup);

function sessionFile(id: string): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, `source_${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, cwd: root, timestamp: "2026-10-26T00:00:00.000Z" })}\n`,
	);
}
function lastRecord(s: ReturnType<typeof session>): StartedRecorded {
	return s.entries.findLast((entry) => entry.customType === "delegate-start-v2")?.data as StartedRecorded;
}

function instrument(client: DelegateHost, calls: string[], wire?: HerdrWire): void {
	const open = client.openWindow.bind(client);
	client.openWindow = async (
		spec: WindowSpec,
		placement: WindowPlacement,
		companion: string,
	): Promise<OpenedWindow> => {
		calls.push("open");
		assert.equal(readTree("order-parent").entries.at(-1)?.phase, "dispatched");
		const result = await open(spec, placement, companion);
		const locator = herdrLocator(result.locator);
		if (locator && wire) wire.staged.push(dirname(locator.launchFile));
		calls.push("opened");
		return result;
	};
}

async function orders(client: DelegateHost, exit: (record: StartedRecorded) => void, wire?: HerdrWire): Promise<void> {
	const calls: string[] = [];
	instrument(client, calls, wire);
	const s = session({
		parent: "order-parent",
		multiplexer: client,
		beforeSquire: (pi) => {
			const append = pi.appendEntry.bind(pi);
			pi.appendEntry = (type: string, data: unknown): void => {
				if (type === "delegate-start-v2") calls.push("record");
				append(type, data);
			};
		},
	});
	await s.start();
	s.events.on("message:send", () => calls.push("mail"));
	s.events.on("session:launch", (value: unknown) => {
		calls.push("hook");
		const payload = value as { env: Record<string, string> };
		const live = JSON.parse(payload.env.PI_SQUIRE_LIVE_LAUNCH) as { sessionId: string };
		assert.ok(readIdentity(live.sessionId));
		assert.equal(readTree(s.parent).entries.at(-1)?.phase, "reserved");
	});
	try {
		await s.toolCall("delegate", { agent: "scout", task: "first" });
		assert.deepEqual(calls.splice(0), ["mail", "hook", "open", "opened", "record"]);
		const first = lastRecord(s);
		sessionFile(first.id);
		exit(first);
		await s.toolCall("delegation_resume", { id: first.id, task: "second" });
		assert.deepEqual(calls.splice(0), ["hook", "open", "opened", "mail", "record"]);
		await s.toolCall("delegation_fork", { id: lastRecord(s).id, task: "third" });
		assert.deepEqual(calls, ["mail", "hook", "open", "opened", "record"]);
	} finally {
		await s.shutdown();
	}
}

test("tmux launch/resume/fork keep mail, identity, hook, dispatch, open and record order", async () => {
	const host = new FakeTmux();
	await orders(host, (record: StartedRecorded) => {
		const locator = record.locator as { id: string };
		host.windows.delete(locator.id);
	});
});

test("memory host launch/resume/fork keep the same order as tmux, with no tmux model", async () => {
	const host = new MemoryHost();
	await orders(host, (record: StartedRecorded) => host.exit(record));
	assert.deepEqual(
		host.started.map((start) => start.argv.includes("--session")),
		[false, true, false],
		"only the resume reopens a session file",
	);
});

test("Herdr launch/resume/fork keep mail, identity, hook, dispatch, open and record order", async () => {
	const wire = new HerdrWire();
	try {
		await orders(
			wire.client,
			(record: StartedRecorded) => {
				const locator = herdrLocator(record.locator);
				assert.ok(locator);
				writeFileSync(`${locator.launchFile}.status`, JSON.stringify({ pid: 99, exit: 1 }));
			},
			wire,
		);
	} finally {
		wire.dispose();
	}
});

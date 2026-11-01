import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { writeIdentity } from "../src/identity.ts";
import { writeState } from "../src/local-state.ts";
import { agentDir, cleanup, resetRoot } from "./harness.ts";
import { TreeProcess } from "./tree-process-harness.ts";

after(cleanup);
beforeEach(resetRoot);
type Snapshot = {
	sent: { message: { content: string } }[];
	prompts: { text: string }[];
	entries: { data: { result?: unknown } }[];
	errors: string[];
	shutdowns: number;
};
const fixture = "./fixtures/session-owner.ts";
function localRecord(parent: string, child: string, request: string): void {
	writeState(join(agentDir, "squire", "child-tasks", `${parent}.json`), {
		records: [
			{
				id: child,
				agent: "worker",
				model: "alpha/fast-model",
				thinking: "medium",
				requestId: request,
				windowId: "@1",
				windowName: "worker",
				autoExit: false,
			},
		],
		outcomes: [],
	});
}
async function gated(process: TreeProcess, session: string): Promise<Promise<Snapshot>[]> {
	await process.ready;
	const gate = new Promise<void>((resolve) =>
		process.child.on("message", (message: { gated?: boolean }) => {
			if (message.gated) resolve();
		}),
	);
	const boot = process.command<Snapshot>("boot", { session, gated: true });
	await gate;
	return [boot];
}
for (const last of [false, true])
	test(`duplicate ingress is lossless, mail last=${last}`, async () => {
		const parent = randomUUID(),
			child = randomUUID(),
			request = randomUUID();
		localRecord(parent, child, request);
		const owner = new TreeProcess(agentDir, fixture),
			loser = new TreeProcess(agentDir, fixture),
			sender = new TreeProcess(agentDir, fixture);
		try {
			await owner.command("boot", { session: parent, last });
			await sender.command("boot", { session: child, last });
			owner.child.kill("SIGSTOP");
			// In provider-first order, park startup before Squire's start handler.
			// Its factory inbound listener must stage even without a current ctx.
			let boot: Promise<Snapshot> | undefined;
			if (!last) [boot] = await gated(loser, parent);
			else await loser.command("boot", { session: parent, last });
			await sender.command("reply", { to: parent, reply: request });
			const duplicate = await loser.command<Snapshot>("scan");
			assert.equal(duplicate.sent.length, 0);
			const staged = join(agentDir, "squire", "owners", parent, "inbound");
			assert.equal(readdirSync(staged).length, 1, "claimed reply durably staged");
			if (boot) {
				await loser.command("release");
				const refused = await boot;
				assert.equal(refused.shutdowns, 1);
			}
			owner.child.kill("SIGCONT");
			// Explicit owner scan may find no new mail: drain must consume staged input.
			let observed: Snapshot | undefined;
			for (let i = 0; i < 50; i++) {
				observed = await owner.command<Snapshot>("snapshot");
				if (observed.sent.length) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal(observed?.sent.length, 1);
			assert.equal(observed?.entries.filter((entry) => entry.data.result).length, 1);
			assert.equal(readdirSync(staged).length, 0);
			await loser.command("shutdown");
			// A losing shutdown cannot remove/replace the winner's owner token.
			const saved = JSON.parse(readFileSync(join(agentDir, "squire", "owners", `${parent}.json`), "utf8"));
			assert.equal(saved.pid, owner.child.pid);
		} finally {
			owner.child.kill("SIGCONT");
			await Promise.all([owner.kill(), loser.kill(), sender.kill()]);
		}
	});
test("a paused LIVE owner-lock holder cannot prevent durable loser ingress or owner delivery", async () => {
	const parent = randomUUID(),
		child = randomUUID(),
		request = randomUUID();
	localRecord(parent, child, request);
	const owner = new TreeProcess(agentDir, fixture),
		loser = new TreeProcess(agentDir, fixture),
		sender = new TreeProcess(agentDir, fixture),
		holder = new TreeProcess(agentDir);
	try {
		await owner.command("boot", { session: parent });
		await loser.command("boot", { session: parent });
		await sender.command("boot", { session: child });
		const lockPath = join(agentDir, "squire", "owners", `${parent}.lock`);
		await holder.command("hold-ticket", { path: lockPath });
		assert.equal(readdirSync(lockPath).filter((name) => name.endsWith(".json")).length, 1);
		holder.child.kill("SIGSTOP");
		owner.child.kill("SIGSTOP");
		await sender.command("reply", { to: parent, reply: request });
		const scanned = await loser.command<Snapshot>("scan");
		assert.equal(scanned.sent.length, 0, "no plain-mail loss");
		const stage = join(agentDir, "squire", "owners", parent, "inbound");
		assert.equal(readdirSync(stage).length, 1);
		owner.child.kill("SIGCONT");
		let result: Snapshot | undefined;
		for (let i = 0; i < 50; i++) {
			result = await owner.command<Snapshot>("snapshot");
			if (result.sent.length) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(result?.entries.filter((entry) => entry.data.result).length, 1);
		assert.equal(result?.sent.length, 1, "callbacks complete while the owner lock is still held");
		assert.equal(readdirSync(stage).length, 0);
		assert.equal(
			readdirSync(lockPath).filter((name) => name.endsWith(".json")).length,
			1,
			"live contender was not evicted",
		);
	} finally {
		owner.child.kill("SIGCONT");
		holder.child.kill("SIGCONT");
		await Promise.all([owner.kill(), loser.kill(), sender.kill(), holder.kill()]);
	}
});

test("owner death after local save but before injection retains staged input and one recovered result", async () => {
	const parent = randomUUID(),
		child = randomUUID(),
		request = randomUUID();
	localRecord(parent, child, request);
	const owner = new TreeProcess(agentDir, fixture),
		sender = new TreeProcess(agentDir, fixture);
	let replacement: TreeProcess | undefined;
	try {
		await owner.command("boot", { session: parent });
		await owner.command("fail-injection");
		await sender.command("boot", { session: child });
		await sender.command("reply", { to: parent, reply: request });
		await owner.command("scan");
		const failed = await owner.command<Snapshot>("snapshot");
		assert.equal(failed.sent.length, 0);
		assert.ok(failed.errors.some((error) => error.includes("input retained")));
		const staged = join(agentDir, "squire", "owners", parent, "inbound");
		assert.equal(readdirSync(staged).length, 1);
		await owner.kill();
		replacement = new TreeProcess(agentDir, fixture);
		await replacement.command("boot", { session: parent });
		let recovered: Snapshot | undefined;
		for (let i = 0; i < 50; i++) {
			recovered = await replacement.command<Snapshot>("snapshot");
			if (recovered.sent.length) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(recovered?.sent.length, 1);
		assert.equal(readdirSync(staged).length, 0);
	} finally {
		await Promise.all([owner.kill(), sender.kill(), replacement?.kill()]);
	}
});

test("a duplicate stages a coordinator task before start; only the owner prompts", async () => {
	const parent = randomUUID(),
		child = randomUUID();
	writeIdentity(child, {
		parent,
		root: parent,
		depth: 1,
		agent: "coordinator",
		chain: ["coordinator"],
		autoExit: false,
	});
	const owner = new TreeProcess(agentDir, fixture),
		loser = new TreeProcess(agentDir, fixture),
		sender = new TreeProcess(agentDir, fixture);
	try {
		await owner.command("boot", { session: child });
		await sender.command("boot", { session: parent });
		owner.child.kill("SIGSTOP");
		const [boot] = await gated(loser, child);
		await sender.command("request", { to: child });
		assert.equal((await loser.command<Snapshot>("scan")).prompts.length, 0);
		await loser.command("release");
		await boot;
		owner.child.kill("SIGCONT");
		let seen: Snapshot | undefined;
		for (let i = 0; i < 50; i++) {
			seen = await owner.command<Snapshot>("snapshot");
			if (seen.prompts.length) break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(seen?.prompts.length, 1);
		assert.match(seen!.prompts[0].text, /coordinator task/);
		// Death releases identity ownership, not delegate ownership.
		await owner.kill();
		const replacement = new TreeProcess(agentDir, fixture);
		try {
			assert.equal((await replacement.command<Snapshot>("boot", { session: child })).shutdowns, 0);
		} finally {
			await replacement.kill();
		}
	} finally {
		owner.child.kill("SIGCONT");
		await Promise.all([owner.kill(), loser.kill(), sender.kill()]);
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeProcess, type OwnerProcess, ownerRefusal } from "../src/owner-refusal.ts";

test("describeProcess reads the owner and its parent from ps", () => {
	const calls: string[] = [];
	const described: OwnerProcess = describeProcess(42840, (fields: string, pid: number): string | undefined => {
		calls.push(`${fields} ${pid}`);
		return pid === 42840 ? "64975 Mon Nov 16 19:01:20 2026     pi" : "Paseo Daemon";
	});
	assert.deepEqual(described, {
		started: "Mon Nov 16 19:01:20 2026",
		command: "pi",
		parentPid: 64975,
		parentCommand: "Paseo Daemon",
	});
	assert.deepEqual(calls, ["ppid=,lstart=,comm= 42840", "comm= 64975"]);
});

test("describeProcess is empty when ps has nothing, and skips launchd as a parent", () => {
	assert.deepEqual(
		describeProcess(7, (): undefined => undefined),
		{},
	);
	const orphan: OwnerProcess = describeProcess(7, (fields: string): string | undefined =>
		fields === "comm=" ? assert.fail("parent 1 is not looked up") : "1 Mon Nov 16 19:01:20 2026 pi",
	);
	assert.equal(orphan.parentPid, undefined);
	assert.equal(orphan.command, "pi");
});

test("describeProcess reads a real process", () => {
	if (process.platform === "win32") return;
	const described: OwnerProcess = describeProcess(process.pid);
	assert.ok(described.started, "ps reports the start time");
	assert.ok(described.command, "ps reports the command");
});

test("ownerRefusal names the owner and the commands that free the session", () => {
	const text: string = ownerRefusal("s-1", 42840, "/agent/squire/owners/s-1.json", {
		command: "pi",
		started: "Mon Nov 16 19:01:20 2026",
		parentPid: 64975,
		parentCommand: "Paseo Daemon",
	});
	assert.equal(
		text,
		[
			"pi-squire: this Pi session is already open in another process, so this Pi quit.",
			"Owner: PID 42840 (pi), started Mon Nov 16 19:01:20 2026, child of PID 64975 (Paseo Daemon).",
			"To quit that process and open the session here, run: kill 42840",
			"then, once it has exited: pi --session s-1",
			"If it does not exit, force it: kill -9 42840",
			"Owner record: /agent/squire/owners/s-1.json",
		].join("\n"),
	);
	assert.match(ownerRefusal("s-1", 9, "/r.json", {}), /^Owner: PID 9\.$/m);
});

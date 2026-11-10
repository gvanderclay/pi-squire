// Capture serialization without parsing/reordering stored objects. Only run-local
// addresses, paths and process ids are replaced; whitespace and key order stay pinned.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { treePath } from "../src/tree-registry.ts";
import { agentDir, agentFile, root, session, sessionDir, writeAgent } from "./harness.ts";

export async function captureStartBytes(): Promise<string> {
	writeAgent("scout", agentFile({ model: "alpha/fast-model", thinking: "low", auto_exit: "false" }));
	const s = session({ parent: "byte-parent" });
	await s.start();
	const replacements: [string, string][] = [
		[realpathSync(root), "<cwd>"],
		[root, "<cwd>"],
		[basename(root), "<project>"],
	];
	const snapshots: string[] = [];
	function capture(kind: string): string {
		const entry = s.entries.findLast((item) => item.customType === "delegate-start-v2");
		assert.ok(entry);
		const id = String(entry.data.id);
		replacements.push([id, `<${kind}-id>`], [id.slice(0, 8), `<${kind}-short>`]);
		replacements.push([String(entry.data.requestId), `<${kind}-request>`]);
		snapshots.push(
			`=== ${kind}: registry ===\n${readFileSync(treePath(s.parent), "utf8")}` +
				`\n=== ${kind}: child-task ===\n${readFileSync(join(agentDir, "squire", "child-tasks", `${s.parent}.json`), "utf8")}` +
				`\n=== ${kind}: journal ===\n${JSON.stringify(entry)}\n`,
		);
		return id;
	}
	await s.toolCall("delegate", { agent: "scout", label: "bytes", task: "first", cwd: root });
	const original = capture("launch");
	mkdirSync(sessionDir, { recursive: true });
	const path = join(sessionDir, `source_${original}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: original, cwd: root, timestamp: "2026-10-26T00:00:00.000Z" })}\n`,
	);
	s.tmux.windows.clear();
	await s.toolCall("delegation_resume", { id: original, task: "second" });
	const resumed = capture("resume");
	await s.toolCall("delegation_fork", { id: resumed, task: "third" });
	capture("fork");
	let bytes = snapshots.join("\n");
	for (const [from, to] of replacements) bytes = bytes.replaceAll(from, to);
	return bytes.replaceAll(`"ownerPid":${process.pid}`, '"ownerPid":<pid>');
}

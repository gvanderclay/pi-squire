import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTmuxClient } from "../src/tmux.ts";

test("a tmux call that outlasts the timeout rejects naming the subcommand", async () => {
	const dir = mkdtempSync(join(tmpdir(), "squire-tmux-"));
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(dir, "tmux"), "#!/bin/sh\nexec sleep 5\n");
		chmodSync(join(dir, "tmux"), 0o755);
		process.env.PATH = `${dir}:${oldPath}`;
		await assert.rejects(createTmuxClient({ timeoutMs: 100 }).listWindows(), {
			message: "tmux list-windows timed out after 0.1 s",
		});
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

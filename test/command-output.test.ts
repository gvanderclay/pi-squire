import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandOutput } from "../src/command-output.ts";
import { cleanup, session } from "./harness.ts";

after(cleanup);
test("TUI and RPC command diagnostics use notify, never stderr or model messages", (t) => {
	t.mock.method(process.stderr, "write", () => {
		assert.fail("UI diagnostics must not write stderr");
	});
	// TUI-only callers can supply a narrow UI context; mode still bounds stderr.
	const narrow = { mode: "tui", ui: { notify: (_text: string) => {} } };
	commandOutput(narrow as unknown as ExtensionContext, "TUI notification", "warning");
	for (const mode of ["tui", "rpc"] as const) {
		const s = session({ mode, hasUI: true });
		commandOutput(s.context as unknown as ExtensionContext, "prerequisite missing", "error");
		assert.deepEqual(s.errors, ["prerequisite missing"]);
		assert.deepEqual(s.sent, []);
		assert.deepEqual(s.userMessages, []);
		assert.deepEqual(s.entries, []);
	}
});

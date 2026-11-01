import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DelegateRow } from "../src/widget-data.ts";
import { renderDelegateWidget } from "../src/widget-render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const rows: DelegateRow[] = Array.from({ length: 8 }, (_, index) => ({
	key: String(index),
	sessionId: String(index),
	launchId: `launch-${index}`,
	identity: `worker-${index}`,
	title: "表情🔎",
	state: "running",
	running: true,
	window: "open",
	model: "provider/model",
	lastActive: undefined,
}));
test("focused viewport exposes hidden above/below counts and only focused hints", () => {
	const normal = renderDelegateWidget(rows, 3, 100, theme).join("\n");
	assert.match(normal, /worker-0/);
	assert.doesNotMatch(normal, /select|details|prompt|▸/);
	const focused = renderDelegateWidget(rows, 3, 100, theme, 0, { offset: 2, focused: true, selectedKey: "4" }).join(
		"\n",
	);
	assert.match(focused, /↑ 2 more direct delegates/);
	assert.match(focused, /\+3 more direct delegates/);
	assert.match(focused, /▸ ├─ ◌ worker-4/);
	assert.doesNotMatch(focused, /worker-0|worker-1|worker-5/);
	assert.match(focused, /enter details/);
	assert.match(focused, /^ {2}Delegates\n {2}├─ ↑ 2 more direct delegates\n/);
	assert.match(focused, /\n {2}└─ \+3 more direct delegates\n/);
});
test("selection gutter and overflow remain width-safe on tiny/wide terminals", () => {
	for (let width = 1; width <= 120; width++) {
		const lines = renderDelegateWidget(rows, 1, width, theme, 0, { offset: 7, focused: true, selectedKey: "7" });
		for (const line of lines) assert.ok(visibleWidth(line) <= width, JSON.stringify({ width, line }));
	}
	assert.deepEqual(renderDelegateWidget(rows, 0, 80, theme, 0, { focused: true }), []);
});

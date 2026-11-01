import assert from "node:assert/strict";
import { test } from "node:test";
import { Dashboard, type DashboardIntent, type DashboardPosition } from "../src/dashboard.ts";

const items = Array.from({ length: 12 }, (_, index) => ({
	id: String(index),
	label: `worker-${index}`,
	details: Array.from({ length: 20 }, (_v, n) => `line ${n}`),
}));
function screen(detailBack: "list" | "exit" = "list", detail = false) {
	const position: DashboardPosition = { id: "0", detail, offset: 0 };
	const results: DashboardIntent[] = [];
	const dashboard = new Dashboard({
		items,
		position,
		detailBack,
		theme: { fg: (_color, text) => text, bold: (text) => text },
		done: (result) => results.push(result),
		redraw: () => {},
		rows: () => 12,
	});
	return { position, results, dashboard };
}
test("one presentation enters details from overall list; widget-target details returns directly to widget", () => {
	const command = screen();
	command.dashboard.handleInput("\r");
	assert.match(command.dashboard.render(80).join("\n"), /Delegate: worker-0/);
	assert.equal(command.position.detail, true);
	command.dashboard.handleInput("\x1b");
	assert.equal(command.position.detail, false);
	assert.deepEqual(command.results, []);
	command.dashboard.handleInput("\x1b");
	assert.deepEqual(command.results, [undefined]);
	const widget = screen("exit", true);
	widget.dashboard.handleInput("\x1b");
	assert.deepEqual(widget.results, [undefined], "no competing extra panel between details and compact list");
});
test("actions are opaque intents, position persists through reconstructed screens", () => {
	const f = screen();
	for (let n = 0; n < 10; n++) f.dashboard.handleInput("\x1b[B");
	assert.equal(f.position.id, "10");
	const frame = f.dashboard.render(80).join("\n");
	assert.match(frame, /worker-10/);
	assert.doesNotMatch(frame, /worker-0/);
	f.dashboard.handleInput("x");
	assert.deepEqual(f.results, [{ action: "close", id: "10" }]);
	const next = new Dashboard({
		items,
		position: f.position,
		detailBack: "list",
		theme: { fg: (_color, text) => text, bold: (text) => text },
		done: () => {},
		redraw: () => {},
		rows: () => 12,
	});
	assert.match(next.render(80).join("\n"), /▸ worker-10/);
});
test("detail scroll, release filter, empty and disappearing selection", () => {
	const f = screen("list", true);
	f.dashboard.handleInput("\x1b[B");
	assert.equal(f.position.offset, 1);
	f.dashboard.handleInput("\x1b[1;1:3B");
	assert.equal(f.position.offset, 1);
	for (let n = 0; n < 100; n++) f.dashboard.handleInput("\x1b[B");
	assert.equal(f.position.offset, 14);
	for (const action of ["p", "r", "\r"]) f.dashboard.handleInput(action);
	assert.deepEqual(f.results, [
		{ action: "peek", id: "0" },
		{ action: "resume", id: "0" },
		{ action: "switch", id: "0" },
	]);
	const position: DashboardPosition = { id: "missing", detail: true, offset: 5 };
	const empty = new Dashboard({
		items: [],
		position,
		detailBack: "exit",
		theme: { fg: (_c, t) => t, bold: (t) => t },
		done: () => {},
		redraw: () => {},
		rows: () => 1,
	});
	assert.equal(position.detail, false);
	assert.match(empty.render(20).join("\n"), /No open delegates/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { WidgetSelection } from "../src/widget-selection.ts";

test("empty/cap-zero cannot acquire invisible rows", () => {
	const selection = new WidgetSelection();
	selection.update([], 3);
	assert.equal(selection.enter(), false);
	selection.update(["a"], 0);
	assert.equal(selection.enter(), false);
	assert.equal(selection.active, false);
});

test("navigation windows all rows, leaves at top and preserves identity through reorder", () => {
	const selection = new WidgetSelection();
	selection.update(["a", "b", "c", "d", "e"], 3);
	assert.equal(selection.enter(), true);
	selection.move(1);
	selection.move(1);
	selection.move(1);
	assert.equal(selection.selectedKey, "d");
	assert.equal(selection.offset, 1);
	selection.update(["d", "a", "b", "c", "e"], 3);
	assert.equal(selection.selectedKey, "d");
	assert.equal(selection.offset, 0);
	selection.move(-1);
	assert.equal(selection.active, false);
	assert.equal(selection.offset, 0);
});

test("disappearance clamps nearest survivor, viewport/cap changes never strand selection", () => {
	const selection = new WidgetSelection();
	selection.update(["a", "b", "c", "d"], 1);
	selection.enter();
	for (let n = 0; n < 8; n++) selection.move(1);
	assert.equal(selection.selectedKey, "d");
	assert.equal(selection.offset, 3);
	selection.update(["a", "b"], 1);
	assert.equal(selection.selectedKey, "b");
	assert.equal(selection.offset, 1);
	selection.update(["a", "b"], 3);
	assert.equal(selection.offset, 0);
	selection.update([], 3);
	assert.equal(selection.active, false);
	assert.equal(selection.selectedKey, undefined);
});

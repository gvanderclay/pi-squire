import assert from "node:assert/strict";
import { test } from "node:test";
import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { promptState, WidgetFocus } from "../src/widget-focus.ts";
import { WidgetSelection } from "../src/widget-selection.ts";

function fixture() {
	let text = "";
	let completion = false;
	let custom = false;
	const editor = Object.create(CustomEditor.prototype) as CustomEditor;
	editor.isShowingAutocomplete = () => completion;
	let focused: unknown = editor;
	let handler: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
	const ui = {
		getEditorText: () => text,
		getEditorComponent: () => (custom ? () => editor : undefined),
		onTerminalInput: (listener: NonNullable<typeof handler>) => {
			handler = listener;
			return () => {
				handler = undefined;
			};
		},
	};
	const tui = { getFocusedComponent: () => focused };
	const selection = new WidgetSelection();
	selection.update(["a", "b", "c"], 2);
	const opened: string[] = [];
	const errors: unknown[] = [];
	let changed = 0;
	let pending: Promise<void> = Promise.resolve();
	const focus = new WidgetFocus({
		ui,
		selection,
		changed: () => changed++,
		open: async (key) => {
			opened.push(key);
			await pending;
		},
		error: (error) => {
			errors.push(error);
		},
	});
	focus.attach(tui);
	focus.start();
	return {
		ui,
		tui,
		editor,
		focus,
		selection,
		opened,
		errors,
		key: (data: string) => handler?.(data),
		text: (value: string) => {
			text = value;
		},
		completion: (value: boolean) => {
			completion = value;
		},
		custom: (value: boolean) => {
			custom = value;
		},
		target: (value: unknown) => {
			focused = value;
		},
		pending: (value: Promise<void>) => {
			pending = value;
		},
		changes: () => changed,
	};
}
async function settle() {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("exact built-in only; null/unknown/throwing focus, custom editor and completion fail closed", () => {
	const f = fixture();
	assert.equal(promptState(f.tui, f.ui), "empty");
	f.text(" ");
	assert.equal(promptState(f.tui, f.ui), "text");
	f.text("");
	f.completion(true);
	assert.equal(promptState(f.tui, f.ui), "other");
	assert.equal(f.key("\x1b[B"), undefined);
	f.completion(false);
	f.custom(true);
	assert.equal(promptState(f.tui, f.ui), "other");
	f.custom(false);
	for (const target of [undefined, null, {}, { getText: () => "", setText: () => {} }]) {
		f.target(target);
		assert.equal(promptState(f.tui, f.ui), "other");
		assert.equal(f.key("\x1b[B"), undefined);
	}
	assert.equal(promptState(undefined, f.ui), "other");
	assert.equal(promptState({}, f.ui), "other");
	assert.equal(
		promptState(
			{
				getFocusedComponent: () => {
					throw Error("unknown");
				},
			},
			f.ui,
		),
		"other",
	);
	f.target(f.editor);
	f.editor.isShowingAutocomplete = () => {
		throw Error("unknown");
	};
	assert.equal(promptState(f.tui, f.ui), "other");
	f.focus.stop();
});

test("only Down activates; arrows consume, unrelated input is preserved and releases ignored", () => {
	const f = fixture();
	assert.equal(f.key("\x1b[D"), undefined);
	assert.deepEqual(f.key("\x1b[B"), { consume: true });
	assert.equal(f.focus.focused, true);
	assert.deepEqual(f.key("\x1b[B"), { consume: true });
	assert.equal(f.selection.selectedKey, "b");
	assert.equal(f.key("\x1b[1;1:3B"), undefined);
	assert.equal(f.selection.selectedKey, "b", "release doesn't move or deactivate");
	assert.equal(f.key("paste text"), undefined);
	assert.equal(f.focus.focused, false);
	assert.equal(f.key("\x1b[A"), undefined, "prompt Up remains history");
	assert.equal(f.key("\x1b[B")?.consume, true);
	assert.equal(f.key("\x1b")?.consume, true);
	assert.equal(f.focus.focused, false);
	f.focus.stop();
});

test("completion/dialog interruption relinquishes focus; custom dashboard cannot capture", () => {
	const f = fixture();
	f.key("\x1b[B");
	f.completion(true);
	assert.equal(f.focus.focused, false);
	assert.equal(f.key("\x1b[B"), undefined);
	assert.equal(f.selection.active, false);
	f.completion(false);
	f.key("\x1b[B");
	f.focus.suspend(true);
	assert.equal(f.key("\r"), undefined);
	assert.equal(f.selection.active, false);
	f.focus.suspend(false);
	f.key("\x1b[B");
	f.target({ getText: () => "", setText: () => {} });
	assert.equal(f.focus.focused, false, "hint disappears before any next key");
	assert.equal(f.key("\x1b"), undefined);
	assert.equal(f.selection.active, false);
	f.focus.stop();
});

test("details owns all input while opening, back retains selection, next Escape returns prompt", async () => {
	const f = fixture();
	let done: (() => void) | undefined;
	f.pending(
		new Promise<void>((resolve) => {
			done = resolve;
		}),
	);
	f.key("\x1b[B");
	f.key("\x1b[B");
	assert.equal(f.key("\r")?.consume, true);
	assert.equal(f.key("\r")?.consume, true);
	await settle();
	assert.deepEqual(f.opened, ["b"]);
	f.target({ handleInput: () => {} });
	f.focus.suspend(true);
	assert.equal(f.selection.active, true, "own dashboard doesn't discard list selection");
	assert.equal(f.key("\x1b"), undefined);
	f.target(f.editor);
	f.focus.suspend(false);
	done?.();
	await settle();
	assert.equal(f.focus.focused, true);
	assert.equal(f.selection.selectedKey, "b");
	assert.equal(f.key("\x1b")?.consume, true);
	assert.equal(f.focus.focused, false);
	f.focus.stop();
	assert.equal(f.key("\x1b[B"), undefined);
});

test("pending open and between-action gaps consume only the exact empty prompt", async () => {
	const f = fixture();
	let done!: () => void;
	f.pending(
		new Promise<void>((resolve) => {
			done = resolve;
		}),
	);
	f.key("\x1b[B");
	f.key("\r");
	await settle();
	for (const key of ["\x1b", "x", "p", "r", "\r", "\x1b[B"])
		assert.equal(f.key(key)?.consume, true, `pending key must not reach prompt: ${key}`);
	assert.equal(f.key("\x1b[1;1:3B"), undefined);
	f.target({ handleInput: () => {} });
	f.focus.suspend(true);
	for (const key of ["\x1b", "x", "p"]) assert.equal(f.key(key), undefined, "mounted dashboard owns input");
	// The same busy operation covers navigator's re-list between action dialogs.
	f.target(f.editor);
	f.focus.suspend(false);
	for (const key of ["\x1b", "x", "p", "r"]) assert.equal(f.key(key)?.consume, true);
	f.completion(true);
	assert.equal(f.key("\x1b[B"), undefined);
	assert.equal(f.key("\x1b"), undefined);
	f.completion(false);
	f.custom(true);
	assert.equal(f.key("x"), undefined);
	f.custom(false);
	f.text("draft");
	assert.equal(f.key("\x1b"), undefined);
	f.text("");
	f.target(null);
	assert.equal(f.key("\x1b"), undefined);
	done();
	await settle();
	f.focus.stop();
});

test("failed open resets suppression, late shutdown never repaints", async () => {
	const f = fixture();
	const rejected = Promise.reject(new Error("open failed"));
	// Attach a rejection handler before the opener's microtask observes it.
	void rejected.catch(() => {});
	f.pending(rejected);
	f.key("\x1b[B");
	f.key("\r");
	await settle();
	assert.equal(f.errors.length, 1);
	assert.equal(f.focus.focused, true);
	const changes = f.changes();
	f.focus.stop();
	await settle();
	assert.equal(f.changes(), changes);
});

test("shutdown before opener microtask cannot start a dashboard", async () => {
	const f = fixture();
	f.key("\x1b[B");
	f.key("\r");
	f.focus.stop();
	await settle();
	assert.deepEqual(f.opened, []);
	assert.deepEqual(f.errors, []);
});

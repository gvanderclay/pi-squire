import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
	delegateTools,
	exposedDepth,
	maxDepth,
	multiplexerSetting,
	resultBodyBytes,
	squireSettingsFile,
	toolBundles,
	treeCaps,
	widgetSettings,
	windowSettings,
	worktreeSettings,
} from "../src/settings.ts";

const agentDir: string = mkdtempSync(join(tmpdir(), "squire-settings-"));
const file: string = squireSettingsFile(agentDir);
after(() => rmSync(agentDir, { recursive: true, force: true }));
beforeEach(() => {
	rmSync(join(agentDir, "squire"), { recursive: true, force: true });
	mkdirSync(join(agentDir, "squire"), { recursive: true });
});

/** Each way the whole file can be broken. */
const broken: Record<string, () => void> = {
	"not JSON": () => writeFileSync(file, "{"),
	"an array": () => writeFileSync(file, "[]"),
	null: () => writeFileSync(file, "null"),
	unreadable: () => mkdirSync(file), // a directory: reading it fails
};

/** Every key read where a broken file must refuse the call. */
const refusing: Record<string, () => unknown> = {
	multiplexer: () => multiplexerSetting(agentDir),
	"windowPlacement and companionSuffix": () => windowSettings(agentDir),
	maxDepth: () => maxDepth(agentDir),
	"maxConcurrentDelegates and maxDelegatesPerRoot": () => treeCaps(agentDir),
	delegateTools: () => delegateTools(agentDir),
	"worktreeRoot and worktreeRootByRepo": () => worktreeSettings(agentDir),
	resultBodyKiB: () => resultBodyBytes(agentDir),
	// Cosmetic: the widget catches this, warns once and uses its defaults.
	"delegateWidgetPlacement and delegateWidgetMaxEntries": () => widgetSettings(agentDir),
};

for (const [damage, write] of Object.entries(broken)) {
	for (const [keys, readKey] of Object.entries(refusing)) {
		test(`a settings file that is ${damage} refuses ${keys}, naming the file`, () => {
			write();
			assert.throws(readKey, (error: Error) => error.message.includes(file));
		});
	}
	test(`a settings file that is ${damage} exposes no nesting and disables bundle users, naming the file`, () => {
		write();
		assert.equal(exposedDepth(agentDir), 1);
		const bundles = toolBundles(agentDir);
		assert.equal(bundles.names.size, 0);
		assert.ok(bundles.problem?.includes(file), String(bundles.problem));
	});
}

test("a missing file gives every default", () => {
	rmSync(join(agentDir, "squire"), { recursive: true, force: true });
	assert.equal(multiplexerSetting(agentDir), undefined);
	assert.deepEqual(windowSettings(agentDir), { placement: "companion", companionSuffix: "delegates" });
	assert.equal(maxDepth(agentDir), 1);
	assert.equal(exposedDepth(agentDir), 1);
	assert.deepEqual(treeCaps(agentDir), { maxConcurrentDelegates: 0, maxDelegatesPerRoot: 0 });
	assert.deepEqual(delegateTools(agentDir), []);
	assert.deepEqual(toolBundles(agentDir), { file, names: new Map() });
	assert.deepEqual(worktreeSettings(agentDir), { file, worktreeRootByRepo: [] });
	assert.equal(resultBodyBytes(agentDir), 16 * 1024);
	assert.deepEqual(widgetSettings(agentDir), { placement: "aboveEditor", maxEntries: 3 });
});

test("resultBodyKiB is a whole number of KiB from 4 to 64, read at each call", () => {
	writeFileSync(file, JSON.stringify({ resultBodyKiB: 4 }));
	assert.equal(resultBodyBytes(agentDir), 4 * 1024);
	writeFileSync(file, JSON.stringify({ resultBodyKiB: 64 }));
	assert.equal(resultBodyBytes(agentDir), 64 * 1024);
	for (const value of [3, 65, 8.5, "8", null, true]) {
		writeFileSync(file, JSON.stringify({ resultBodyKiB: value }));
		assert.throws(
			() => resultBodyBytes(agentDir),
			(error: Error) => error.message.includes(file) && error.message.includes("resultBodyKiB"),
			String(value),
		);
	}
});

test("an invalid maxDepth refuses exposure too, naming the file", () => {
	writeFileSync(file, JSON.stringify({ maxDepth: "bad" }));
	assert.throws(
		() => exposedDepth(agentDir),
		(error: Error) => error.message.includes(file),
	);
});

test("settings are read at each call, never cached", () => {
	writeFileSync(file, JSON.stringify({ multiplexer: "tmux", maxDepth: 2 }));
	assert.equal(multiplexerSetting(agentDir), "tmux");
	assert.equal(maxDepth(agentDir), 2);
	writeFileSync(file, JSON.stringify({ multiplexer: "herdr" }));
	assert.equal(multiplexerSetting(agentDir), "herdr");
	assert.equal(maxDepth(agentDir), 1);
});

test("no other source file parses squire/settings.json", () => {
	const src = join(import.meta.dirname, "..", "src");
	const readers = readdirSync(src).filter((name) => {
		const text = readFileSync(join(src, name), "utf8");
		return /"squire",\s*"settings\.json"|squire\/settings\.json"/.test(text) && text.includes("JSON.parse");
	});
	assert.deepEqual(readers, ["settings.ts"]);
});

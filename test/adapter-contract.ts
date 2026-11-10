// Executable delegate-window contract. Test drivers bind today's split tmux
// open/state/navigation APIs; this is NOT a new production adapter framework.
// A future adapter supplies this small driver plus fault/lifecycle controls.
// Placement, tmux commands and locator encodings belong in backend-specific tests.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShowResult, WindowRecord } from "../src/tmux.ts";
import type { WindowState } from "../src/window-state.ts";

export type AdapterContract = {
	open(name: string): Promise<WindowRecord>;
	state(record: WindowRecord): Promise<WindowState>;
	close(record: WindowRecord): Promise<boolean>;
	show(record: WindowRecord, verify: () => Promise<boolean>): Promise<ShowResult>;
	peek(record: WindowRecord): Promise<string>;
	unavailable(checkVersion?: true): string | undefined | Promise<string | undefined>;
};

export type AdapterFixture = {
	adapter: AdapterContract;
	// Controls are outside the contract: the suite never sees tmux commands,
	// lists, ids, sessions, placement or the shape of an opaque locator.
	exit(record: WindowRecord): Promise<void>;
	replace(record: WindowRecord): Promise<WindowRecord>;
	failAsk(fail: boolean): void;
	ambiguousOpen(): void;
	ambiguousSurvives(): Promise<boolean>;
	setUnavailable(unavailable: boolean): void;
	isShown(record: WindowRecord): Promise<boolean>;
	dispose(): Promise<void>;
};

type Factory = () => Promise<AdapterFixture>;

export function adapterConformance(name: string, factory: Factory, skip: false | string = false): void {
	const check = (title: string, body: (fixture: AdapterFixture) => Promise<void>): void => {
		test(`adapter contract (${name}): ${title}`, { skip }, async () => {
			const fixture = await factory();
			try {
				await body(fixture);
			} finally {
				await fixture.dispose();
			}
		});
	};

	check("open is running; close is gone and a second close is a no-op", async ({ adapter }) => {
		const record = await adapter.open("worker");
		assert.ok(record.locator, "a successful open supplies an opaque locator");
		assert.equal(await adapter.state(record), "running");
		assert.equal(await adapter.close(record), true);
		assert.equal(await adapter.state(record), "gone");
		assert.equal(await adapter.close(record), false);
	});

	check("clean program exit is gone; close remains idempotent", async (f) => {
		const record = await f.adapter.open("exiting");
		await f.exit(record);
		assert.equal(await f.adapter.state(record), "gone");
		// Backends may retain the exited terminal or remove it automatically.
		await f.adapter.close(record);
		assert.equal(await f.adapter.state(record), "gone");
		assert.equal(await f.adapter.close(record), false);
	});

	check("failed ask is unknown, refuses close and does not erase ownership", async (f) => {
		const record = await f.adapter.open("ask-failure");
		f.failAsk(true);
		assert.equal(await f.adapter.state(record), "unknown");
		await assert.rejects(f.adapter.close(record));
		f.failAsk(false);
		assert.equal(await f.adapter.state(record), "running");
		assert.equal(await f.adapter.close(record), true);
	});

	check("ambiguous open stays unknown: no adoption or close without positive identity", async (f) => {
		f.ambiguousOpen();
		await assert.rejects(f.adapter.open("ambiguous"), (error: unknown) => {
			assert.ok(error instanceof Error && "certainty" in error);
			assert.equal(error.certainty, "unknown");
			return true;
		});
		const unknown = {};
		assert.equal(await f.adapter.state(unknown), "unknown");
		await assert.rejects(f.adapter.close(unknown));
		assert.equal(await f.ambiguousSurvives(), true, "the unconfirmed create must be left alone");
	});

	check("close rechecks identity and leaves a replacement alone", async (f) => {
		const old = await f.adapter.open("original");
		const replacement = await f.replace(old);
		assert.equal(await f.adapter.state(old), "gone");
		assert.equal(await f.adapter.close(old), false);
		assert.equal(await f.adapter.state(replacement), "running");
		assert.equal(await f.adapter.close(replacement), true);
	});

	check("explicit unsupported locator is unknown and refuses close", async (f) => {
		const record = await f.adapter.open("valid");
		const foreign = { ...record, locator: { adapter: "unsupported", version: 1 } };
		assert.equal(await f.adapter.state(foreign), "unknown");
		await assert.rejects(f.adapter.close(foreign));
		assert.equal(await f.adapter.state(record), "running");
	});

	check("show honors last-moment verification before changing the viewing terminal", async (f) => {
		const record = await f.adapter.open("show");
		assert.equal(await f.isShown(record), false, "open must not steal focus");
		let verified = 0;
		assert.deepEqual(
			await f.adapter.show(record, async () => {
				verified++;
				return false;
			}),
			{ shown: false },
		);
		assert.equal(verified, 1);
		assert.equal(await f.isShown(record), false);
		await assert.rejects(
			f.adapter.show(record, async () => {
				throw new Error("verification failed");
			}),
			/verification failed/,
		);
		assert.equal(await f.isShown(record), false);
		const shown = await f.adapter.show(record, async () => {
			verified++;
			return true;
		});
		assert.ok("shown" in shown && shown.shown);
		assert.ok(shown.returnHint.length > 0);
		assert.equal(verified, 2);
		assert.equal(await f.isShown(record), true);
	});

	check("peek returns terminal text without changing state or focus", async (f) => {
		const record = await f.adapter.open("peek");
		assert.match(await f.adapter.peek(record), /SQUIRE-ADAPTER-SCREEN/);
		assert.equal(await f.adapter.state(record), "running");
		assert.equal(await f.isShown(record), false);
	});

	check("unavailable returns refusal text, synchronously for environment-only checks", async (f) => {
		assert.equal(f.adapter.unavailable(), undefined);
		assert.equal(await f.adapter.unavailable(true), undefined);
		f.setUnavailable(true);
		const refusal = f.adapter.unavailable();
		assert.equal(typeof refusal, "string");
		assert.ok(String(refusal).length > 0);
		assert.equal(await f.adapter.unavailable(true), refusal);
		f.setUnavailable(false);
		assert.equal(await f.adapter.unavailable(true), undefined);
	});
}

// Executable delegate-window contract. Test drivers bind today's split tmux
// open/state/navigation APIs; this is NOT a new production adapter framework.
// A future adapter supplies this small driver plus fault/lifecycle controls.
// Placement, tmux commands and locator encodings belong in backend-specific tests.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { DelegateHost, OpenedWindow, StartKind, WindowSpec } from "../src/host.ts";
import { createHostAdmission } from "../src/host-admission.ts";
import {
	sameWindowLocator,
	validWindowLocator,
	windowFacts,
	windowLocator,
	windowPresentation,
} from "../src/locators.ts";
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

	// Start and lifecycle controls. The suite drives the host through the
	// DelegateHost verbs the shared start sequence uses (src/delegate-start.ts).
	/** The concrete host under test, never a router. */
	host: DelegateHost;
	/** A spec that starts this fixture's program in an existing directory; the suite adds argv and env. */
	spec(name: string): WindowSpec;
	/** Open through host.openWindow with this fixture's placement; resolves once the program started. */
	openHost(spec: WindowSpec): Promise<OpenedWindow>;
	/** What the host actually started for an opened spec. */
	started(
		opened: OpenedWindow,
		spec: WindowSpec,
	): Promise<{ argv: readonly string[]; cwd: string; env: Record<string, string> }>;
	/** Make the host's close step refuse after a successful observation. */
	failClose(fail: boolean): void;
	/** False when the host never has a viewer (no terminal to switch to). */
	viewer?: false;
	/** Detach every viewer of a host that normally has one. */
	noViewer?(): Promise<void>;
	/** The program ended but the host keeps the delegate listed; required when the locator rules say so. */
	exitRetained?(record: WindowRecord): Promise<void>;
	/** Make the host's configureStart reject; required when the host has configureStart. */
	failConfigure?(message: string): void;
	/** Another live Pi now holds this session; required when the host needs a session guard. */
	holdSession?(session: { path: string; id: string }): void;
};

type Factory = () => Promise<AdapterFixture>;

/** Behaviour a fixture's real host is known not to meet yet, by case title, with the reason. */
export type ContractGaps = Readonly<Record<string, string>>;

/** One valid locator of each released codec plus an unregistered tag: none may route to another host. */
const FOREIGN: readonly object[] = [
	{ adapter: "tmux", version: 1, kind: "window", id: "@4242", name: "foreign" },
	{
		adapter: "herdr",
		version: 1,
		kind: "window",
		session: null,
		socket: "/foreign/herdr.sock",
		workspace: "w9",
		tab: "w9:t9",
		pane: "w9:p9",
		terminal: "foreign-terminal",
		name: "foreign",
		launchFile: "/foreign/launch.mjs",
	},
	{ adapter: "unregistered", version: 1, kind: "window", id: "x", name: "foreign" },
];

const tag = (value: unknown): unknown => (value as { adapter?: unknown } | undefined)?.adapter;

export function adapterConformance(
	name: string,
	factory: Factory,
	skip: false | string = false,
	gaps: ContractGaps = {},
): void {
	const check = (
		title: string,
		body: (fixture: AdapterFixture) => Promise<void>,
		applies?: (fixture: AdapterFixture) => string | undefined,
	): void => {
		const gap = gaps[title];
		test(`adapter contract (${name}): ${title}`, {
			skip: skip || (gap ? `known gap: ${gap}` : false),
		}, async (t: TestContext) => {
			const fixture = await factory();
			try {
				const reason = applies?.(fixture);
				if (reason) {
					t.skip(`not applicable: ${reason}`);
					return;
				}
				await body(fixture);
			} finally {
				await fixture.dispose();
			}
		});
	};
	/** The record the start sequence keeps for an opened window. */
	const recordOf = (opened: OpenedWindow, spec: WindowSpec): WindowRecord => ({
		locator: opened.locator ?? windowLocator({ id: opened.id, name: spec.name }),
	});
	const target = (record: WindowRecord) => ({ windowId: windowPresentation(record).windowId, locator: record.locator });
	const hostState = async (f: AdapterFixture, record: WindowRecord): Promise<WindowState> =>
		(await f.host.states()).state(record);
	const openStart = async (f: AdapterFixture, label: string) => {
		const spec = f.spec(label);
		const opened = await f.openHost(spec);
		return { spec, opened, record: recordOf(opened, spec) };
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

	check(
		"show honors last-moment verification before changing the viewing terminal",
		async (f) => {
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
		},
		(f) => (f.viewer === false ? "the host has no viewer" : undefined),
	);

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
	// ---- Start and lifecycle: what the shared start sequence relies on. ----

	check("starts the spec's argv, working directory and environment unchanged", async (f) => {
		const base = f.spec("started");
		const spec: WindowSpec = {
			...base,
			argv: [...base.argv, "two words 'quoted' \"double\" $HOME ; *"],
			env: { ...base.env, SQUIRE_CONTRACT_MARK: 'it\'s "marked" $HOME ; done' },
		};
		const opened = await f.openHost(spec);
		const started = await f.started(opened, spec);
		assert.deepEqual([...started.argv], [...spec.argv]);
		assert.equal(realpathSync(started.cwd), realpathSync(spec.cwd));
		for (const [key, value] of Object.entries(spec.env)) assert.equal(started.env[key], value, key);
		assert.equal(await hostState(f, recordOf(opened, spec)), "running");
	});

	check("argv and environment values ending in ';' reach the program unchanged", async (f) => {
		const base = f.spec("semicolon");
		const spec: WindowSpec = {
			...base,
			argv: [...base.argv, "ends;"],
			env: { ...base.env, SQUIRE_CONTRACT_SEMICOLON: "ends;" },
		};
		const opened = await f.openHost(spec);
		const started = await f.started(opened, spec);
		assert.deepEqual([...started.argv], [...spec.argv]);
		assert.equal(started.env.SQUIRE_CONTRACT_SEMICOLON, "ends;");
	});

	check("declares task-mail timing per start kind; configuration means after-open; admission accepts it", async (f) => {
		const kinds: readonly StartKind[] = ["launch", "resume", "fork"];
		for (const kind of kinds) {
			const timing = f.host.taskMailTiming(kind);
			assert.ok(timing === "before-open" || timing === "after-open", `${kind}: ${String(timing)}`);
			assert.equal(f.host.taskMailTiming(kind), timing, `${kind} timing is stable`);
			if (f.host.configureStart) assert.equal(timing, "after-open", `${kind}: configureStart needs after-open mail`);
		}
		const admitted = await createHostAdmission(f.host, () => ({
			placement: "current",
			companionSuffix: "delegates",
		})).admit();
		assert.equal(admitted.client, f.host.forLaunch?.() ?? f.host);
	});

	check(
		"a configure failure rolls back through closeTaskless and leaves nothing open",
		async (f) => {
			const { opened, record, spec } = await openStart(f, "configure");
			f.failConfigure?.("configuration refused");
			await assert.rejects(
				f.host.configureStart!(opened, {
					kind: "launch",
					sessionId: "contract-session",
					launchId: "contract-session",
					model: "provider/model",
					thinking: "low",
					cwd: spec.cwd,
					sessionDir: spec.cwd,
				}),
				/configuration refused/,
			);
			assert.equal(await hostState(f, record), "running", "a failed configuration closes nothing by itself");
			await f.host.closeTaskless(opened);
			assert.equal(await hostState(f, record), "gone");
			assert.equal((await f.host.states()).listed(record), false);
		},
		(f) => (f.host.configureStart ? undefined : "the host has no configureStart"),
	);

	check("closeTaskless closes the opened start; it is gone and no longer listed", async (f) => {
		const { opened, record } = await openStart(f, "taskless");
		assert.equal(await hostState(f, record), "running");
		await f.host.closeTaskless(opened);
		assert.equal(await hostState(f, record), "gone");
		assert.equal((await f.host.states()).listed(record), false);
	});

	check("a refused close is reported, not swallowed, and leaves the delegate running", async (f) => {
		const { record } = await openStart(f, "refused");
		f.failClose(true);
		await assert.rejects((await f.host.states(true)).close(record));
		f.failClose(false);
		assert.equal(await hostState(f, record), "running");
		assert.equal(await (await f.host.states(true)).close(record), true);
		assert.equal(await hostState(f, record), "gone");
	});

	check("closeTaskless reports a refused close instead of swallowing it", async (f) => {
		const { opened, record } = await openStart(f, "taskless-refused");
		f.failClose(true);
		await assert.rejects(f.host.closeTaskless(opened), (error: unknown) => {
			assert.ok(error instanceof Error && error.message.length > 0);
			return true;
		});
		f.failClose(false);
		assert.equal(await hostState(f, record), "running", "a refused rollback must not report the start gone");
	});

	check(
		"show without a viewer says why before verification and focuses nothing",
		async (f) => {
			const { record } = await openStart(f, "no-viewer");
			await f.noViewer?.();
			let verified = 0;
			const answer = await f.host.show(target(record), async () => {
				verified++;
				return true;
			});
			assert.ok("text" in answer, "a host without a viewer answers NoViewer");
			assert.ok(answer.text.length > 0 && answer.brief.length > 0);
			assert.equal(verified, 0, "no verification is spent when nothing can show it");
			assert.equal(await f.isShown(record), false);
			assert.equal(await hostState(f, record), "running");
		},
		(f) => (f.viewer === false || f.noViewer ? undefined : "the fixture cannot detach the host's viewer"),
	);

	check("peek answers text for a running delegate, with or without a pane, and changes nothing", async (f) => {
		const { record } = await openStart(f, "host-peek");
		const text = await f.host.peek(target(record));
		assert.equal(typeof text, "string");
		assert.equal(await hostState(f, record), "running");
		assert.equal(await f.isShown(record), false);
	});

	check("a clean exit is gone, and listed afterwards only when the locator rules retain it", async (f) => {
		const { record } = await openStart(f, "exit-listed");
		await f.exit(record);
		const states = await f.host.states();
		assert.equal(states.state(record), "gone");
		if (!windowFacts(record).retainedAfterExit) assert.equal(states.listed(record), false);
		else assert.ok(f.exitRetained, "a host whose locators retain exited delegates must model it");
	});

	check(
		"a retained exit stays listed as gone until close removes it",
		async (f) => {
			const { record } = await openStart(f, "retained");
			await f.exitRetained!(record);
			let states = await f.host.states();
			assert.equal(states.state(record), "gone");
			assert.equal(states.listed(record), true, "retained after exit");
			assert.equal(await (await f.host.states(true)).close(record), true);
			states = await f.host.states();
			assert.equal(states.state(record), "gone");
			assert.equal(states.listed(record), false);
		},
		(f) => (f.exitRetained ? undefined : "the fixture's host does not retain exited delegates"),
	);

	check("observation and navigation never revive a gone delegate; revival is a new start", async (f) => {
		const first = await openStart(f, "revive");
		await f.exit(first.record);
		await f.host.peek(target(first.record)).catch(() => undefined);
		await f.host.show(target(first.record), async () => true).catch(() => undefined);
		assert.equal(await hostState(f, first.record), "gone");
		const again = await openStart(f, "revive");
		assert.equal(sameWindowLocator(first.record, again.record), false, "a new start has a new identity");
		assert.equal(await hostState(f, first.record), "gone");
		assert.equal(await hostState(f, again.record), "running");
		assert.equal(await (await f.host.states(true)).close(first.record), false);
		assert.equal(await hostState(f, again.record), "running");
	});

	check("session guard: declared as the locator rules say; a guarding host refuses a held session", async (f) => {
		const { record } = await openStart(f, "guard");
		assert.equal(windowFacts(record).requiresSessionGuard, f.host.requiresSessionGuard);
		if (!f.host.requiresSessionGuard) return;
		assert.equal(typeof f.host.guardSession, "function", "a host that needs a guard must provide one");
		assert.ok(f.holdSession, "the fixture must model another live Pi for a guarding host");
		const dir = mkdtempSync(join(tmpdir(), "squire-guard-"));
		try {
			const session = { path: join(dir, "session.jsonl"), id: "contract-guarded-session" };
			await f.host.guardSession!(record, session, f.host);
			f.holdSession(session);
			await assert.rejects(f.host.guardSession!(record, session, f.host));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	check("its own locator round-trips through JSON and stays owned; another host's is refused", async (f) => {
		const { record } = await openStart(f, "round-trip");
		assert.ok(validWindowLocator(record.locator), "durable readers accept the host's locator");
		const parsed: WindowRecord = JSON.parse(JSON.stringify(record));
		assert.deepEqual(parsed, record);
		assert.equal(sameWindowLocator(parsed, record), true);
		assert.equal(f.host.ownsLocator(parsed.locator), true);
		assert.equal(f.host.ownsLocator(parsed.locator, target(parsed)), true);
		assert.equal(await hostState(f, parsed), "running");
		const own = tag(record.locator);
		for (const foreign of FOREIGN.filter((value) => tag(value) !== own)) {
			assert.equal(f.host.ownsLocator(foreign), false, String(tag(foreign)));
			assert.equal(await hostState(f, { locator: foreign }), "unknown", String(tag(foreign)));
			await assert.rejects((await f.host.states(true)).close({ locator: foreign }));
		}
		assert.equal(await hostState(f, parsed), "running");
	});
}

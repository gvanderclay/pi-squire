// Real Pi SDK lifecycle dispatch, with no prompts, credentials, provider or tmux.
// The identity extension is loaded between a consumer and a provider-like observer.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createIdentity, type IdentityNotification, writeIdentity } from "../src/identity.ts";
import { agentDir, cleanup, resetRoot, root, sessionDir } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

test("Pi new, fork, switch and reload restore exact-id identity before provider-like activation", async () => {
	const offline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	const seen: { reason: string; snapshot: IdentityNotification }[] = [];
	const errors: unknown[] = [];
	const modelRuntime = await ModelRuntime.create({
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async (_id, update) => update(undefined),
			delete: async () => {},
		},
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const consumer = (pi: ExtensionAPI) => {
		let snapshot: IdentityNotification | undefined;
		pi.on("session_start", () => {
			snapshot = undefined;
		});
		pi.on("session_shutdown", () => {
			snapshot = undefined;
		});
		pi.events.on("squire:identity", (payload) => {
			snapshot = payload as IdentityNotification;
		});
		pi.on("resources_discover", (_event, ctx) => {
			assert.equal(snapshot?.sessionId, ctx.sessionManager.getSessionId());
		});
		// Expose no state to Squire: the later observer reads this closure only.
		return () => snapshot;
	};
	let observation: (() => IdentityNotification | undefined) | undefined;
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) => {
						observation = consumer(pi);
					},
					(pi) => {
						createIdentity(pi);
					},
					(pi) => {
						pi.on("session_start", (event, ctx) => {
							const snapshot = observation?.();
							assert.ok(snapshot, "identity arrives before provider-like session activation");
							assert.equal(snapshot.sessionId, ctx.sessionManager.getSessionId());
							seen.push({ reason: event.reason, snapshot });
						});
					},
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				noTools: "all",
				model: modelRuntime.getModels()[0],
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const manager = SessionManager.create(root, sessionDir);
	const id = manager.getSessionId();
	const entry = manager.appendMessage({ role: "user", content: "fixture, never prompted", timestamp: 0 });
	writeIdentity(id, {
		parent: "coordinator-id",
		root: "root-id",
		agent: "worker",
		chain: ["coordinator", "worker"],
		depth: 2,
		rootPlacement: "test-delegate-session",
		autoExit: false,
	});
	// Poisoned inherited labels cannot label a fresh session as this delegate.
	process.env.PI_DELEGATE_PARENT = "stale-parent";
	process.env.PI_DELEGATE_ROOT = "stale-root";
	const runtime = await createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager: manager });
	const bind = async () =>
		runtime.session.bindExtensions({
			onError: (error) => {
				errors.push(error);
			},
		});
	runtime.setRebindSession(bind);
	try {
		await bind();
		assert.equal(seen.at(-1)?.snapshot.status, "delegate");
		const original = runtime.session.sessionFile;
		assert.ok(original);
		await runtime.session.reload();
		assert.equal(seen.at(-1)?.reason, "reload");
		assert.equal(seen.at(-1)?.snapshot.status, "delegate");
		await runtime.newSession();
		assert.equal(seen.at(-1)?.reason, "new");
		assert.equal(seen.at(-1)?.snapshot.status, "root");
		assert.notEqual(seen.at(-1)?.snapshot.sessionId, id);
		await runtime.switchSession(original);
		assert.equal(seen.at(-1)?.reason, "resume");
		assert.equal(seen.at(-1)?.snapshot.status, "delegate");
		assert.equal(seen.at(-1)?.snapshot.sessionId, id);
		await runtime.fork(entry, { position: "at" });
		assert.equal(seen.at(-1)?.reason, "fork");
		assert.equal(seen.at(-1)?.snapshot.status, "root");
		assert.notEqual(seen.at(-1)?.snapshot.sessionId, id);
		assert.equal(seen.length, 5);
		assert.deepEqual(errors, []);
	} finally {
		await runtime.dispose();
		if (offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = offline;
	}
});

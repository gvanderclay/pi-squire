// Real Pi with codemode in mode "only": Pi hides the `delegate` declaration
// from the model while the tool stays active and callable from a script. The
// parent guidance section and the roster refresh must still apply.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import register from "../src/index.ts";
import { agentDir, agentFile, cleanup, resetRoot, root, writeAgent, writeDelegationPrompt } from "./harness.ts";

beforeEach(() => resetRoot());
after(() => cleanup());

const GUIDE = "# Delegation\n\nUse a delegate for broad exploration.\n";
const PARENT_SECTION = "squire_parent_delegation";

test("codemode-only hidden declarations keep the parent guidance section", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model" }));
	writeDelegationPrompt(GUIDE);
	let seen: { sections: Record<string, string>; active: string[]; selected: string[]; hidden: string[] } | undefined;
	const settingsManager = SettingsManager.inMemory({ codemode: { mode: "only" } });
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			register,
			createCodemodeExtension(),
			(pi) => {
				pi.on("before_agent_start", (event) => {
					seen = {
						sections: { ...event.systemPromptOptions.sections },
						active: pi.getActiveTools(),
						selected: [...event.systemPromptOptions.selectedTools],
						hidden: [...event.systemPromptOptions.hiddenTools],
					};
				});
			},
		],
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir,
		settingsManager,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(root),
		tools: ["read", "delegate", "codemode"],
	});
	try {
		await session.bindExtensions({});
		// A custom message starts a run without a model or credentials; the probe
		// reads the options the run was prepared with before the request fails.
		await session
			.sendCustomMessage({ customType: "probe", content: [], display: false }, { triggerTurn: true })
			.catch(() => undefined);
		assert.ok(seen, "the run preparation reached the probe");
		assert.equal(seen.sections[PARENT_SECTION], GUIDE);
		assert.ok(seen.selected.includes("delegate"), "the active loadout still selects the tool");
		assert.ok(seen.hidden.includes("delegate"), `codemode-only hides the declaration: ${seen.hidden}`);
		assert.ok(seen.active.includes("delegate"), "the hidden tool stays active");
	} finally {
		session.dispose();
	}
});

test("codemode leaves delegation_status deferred and undeclared; without it the tool is declared", async () => {
	writeAgent("scout", agentFile({ description: "Looks things up", model: "alpha/fast-model" }));
	/** A real session with this extension and codemode, its discovery tool enabled only by its settings. */
	const probe = async (discovery: string) => {
		let seen: { active: string[]; exposures: Map<string, string> } | undefined;
		const settingsManager = SettingsManager.inMemory({ defaultTools: [`+${discovery}`] });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				register,
				createCodemodeExtension(),
				(pi) => {
					pi.on("before_agent_start", () => {
						seen = {
							active: pi.getActiveTools(),
							exposures: new Map(pi.getAllTools().map((tool) => [tool.name, tool.exposure])),
						};
					});
				},
			],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			settingsManager,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
		});
		try {
			await session.bindExtensions({});
			await session
				.sendCustomMessage({ customType: "probe", content: [], display: false }, { triggerTurn: true })
				.catch(() => undefined);
		} finally {
			session.dispose();
		}
		assert.ok(seen, "the run preparation reached the probe");
		return { active: seen.active, exposures: seen.exposures };
	};
	const deferred = ["delegation_status", "delegation_cleanup", "delegation_fork"];
	const declared = ["delegate", "delegation_close", "delegation_resume"];
	for (const discovery of ["codemode", "tool_search"]) {
		const seen = await probe(discovery);
		for (const name of deferred) assert.equal(seen.exposures.get(name), "deferred", name);
		for (const name of declared) assert.ok(seen.active.includes(name), `${name} stays declared: ${discovery}`);
		// Only codemode can call a deferred tool by name without changing the declared tools.
		for (const name of deferred)
			assert.equal(seen.active.includes(name), discovery === "tool_search", `${name}: ${discovery}`);
	}
});

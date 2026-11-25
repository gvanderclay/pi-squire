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

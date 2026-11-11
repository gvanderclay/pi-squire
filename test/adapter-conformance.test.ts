import { spawnSync } from "node:child_process";
import { adapterConformance } from "./adapter-contract.ts";
import { herdrAdapter } from "./herdr-adapter-fixture.ts";
import { memoryAdapter, paneFreeMemoryAdapter } from "./memory-adapter.ts";
import { paseoAdapter } from "./paseo-fixture.ts";
import { tmuxAdapter } from "./tmux-adapter-fixture.ts";

// Runs by default whenever tmux is installed. Existing opt-in tmux-real tests
// retain companion placement, naming-race and environment-specific assertions.
const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
const noTmux = (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
adapterConformance("memory", memoryAdapter);
adapterConformance("memory pane-free", paneFreeMemoryAdapter);
adapterConformance("Herdr wire", herdrAdapter);
// An API host creates an agent from fields, so there is no argv to compare.
const noArgv = "an API host passes argv as create fields; there is no argv to compare";
adapterConformance("Paseo fake", paseoAdapter, false, {
	"starts the spec's argv, working directory and environment unchanged": noArgv,
	"argv and environment values ending in ';' reach the program unchanged": noArgv,
});
adapterConformance("real tmux", tmuxAdapter, noTmux ? "tmux is not installed" : false);

import { spawnSync } from "node:child_process";
import { adapterConformance } from "./adapter-contract.ts";
import { memoryAdapter } from "./memory-adapter.ts";
import { tmuxAdapter } from "./tmux-adapter-fixture.ts";

// Runs by default whenever tmux is installed. Existing opt-in tmux-real tests
// retain companion placement, naming-race and environment-specific assertions.
const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
const noTmux = (probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
adapterConformance("memory", memoryAdapter);
adapterConformance("real tmux", tmuxAdapter, noTmux ? "tmux is not installed" : false);

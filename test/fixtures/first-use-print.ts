import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../../src/index.ts";
import { FakeTmux } from "../fake-tmux.ts";

/** An available fake host lets real print-mode Pi reach the missing-mail gate without tmux. */
// biome-ignore lint/style/noDefaultExport: Pi loads extensions through their default export.
export default function firstUsePrint(pi: ExtensionAPI): void {
	register(pi, new FakeTmux());
}

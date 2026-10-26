// A parent process for `test/tmux.test.ts`: it opens a popup through the real
// client and then has nothing left to do, so it must exit as soon as it does.
import { createTmuxClient } from "../src/tmux.ts";

await createTmuxClient().popup("c1", { id: "@1", name: "one" }, () => {});
console.log("popup returned");

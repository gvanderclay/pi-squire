# Delegate and result

A user types `/delegate <agent> <task>` in a Pi session running in tmux. A delegate starts in a new tmux window, does the task, and its answer arrives in the parent as one `[delegate]` result message linking the task copy. With auto-exit on (the default) the delegate then closes its own window.

## Sub-features

- `launch` starts a delegate in a window named `<agent>-<label>` and shows a "started in window" notice.
- `result` delivers the delegate's final answer to the parent session as a `delegate` result with status `done`.
- `model` runs the delegate on the agent file's model and thinking.
- `auto-exit` closes the delegate's window after its result.

## How to get to it (user POV)

- Type `/delegate verifier --label <label> <task>` in the root Pi.

## Driving it with squire-verify

Preconditions:

- A launched run with a passing `doctor`.
- No window named `verifier-<label>` yet.

- **Launch.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs delegate --run <id> --label first`. JSON has `ok: true`, a 36-character `id`, `window: "verifier-first"` and a `nonce`.
- **Result.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs wait-result --run <id> --nonce <nonce>`. JSON has `status: "done"`, the same `id`, and `delegateAnswer` `{ model: "opencode-go/deepseek-v4.1-flash", text: "<nonce>" }`. `evidence/result-<nonce>.json` holds the root's result entry.
- **Auto-exit.** The `windows` list in that JSON, or `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs windows --run <id>` a few seconds later, has no `verifier-first`.

## Gotchas

- The root model answers the result with a turn of its own. That reply is not proof; only the result entry and the delegate's own session are.
- Right after the result, the window can still be listed for a moment before auto-exit closes it. Re-run `windows` before calling auto-exit broken.
- The task text is typed into a TUI. Keep it on one line, without backticks or a leading `/`.

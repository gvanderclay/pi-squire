# Close a delegation

The model calls `delegation_close` with a delegation id. Squire fences that subtree, kills the windows it verifies, and reports each member's outcome; worktrees, branches and session files stay.

## Sub-features

- `close-open` kills an open delegate window and reports `killed`.
- `close-complete` reports `closed: true` and `complete: true` when every member is confirmed.

## How to get to it (user POV)

- Ask the root model to call `delegation_close` with an `id`.

## Driving it with squire-verify

Preconditions:

- An open delegate window in this run, such as `verifier-keep` from [Keep the window open](./auto-exit-off.md). Note its `<delegation>` id.

- **Ask.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs ask --run <id> --tool delegation_close --text "Call the delegation_close tool with id <delegation>, then reply with only its output, verbatim."`. JSON has `isError: false`, `text` `Closed delegation subtree <delegation> (1 members).` and a line `killed verifier-keep`.
- **Details.** `details` has `closed: true`, `complete: true`, `killed: true`, and one member with `outcome: "killed"`.
- **Window gone.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs windows --run <id>`. No `verifier-keep` window.

## Gotchas

- A delegation whose window already closed (auto-exit) has nothing to kill, so it cannot show `killed`. Use a `--no-auto-exit` delegate to prove `killed`.

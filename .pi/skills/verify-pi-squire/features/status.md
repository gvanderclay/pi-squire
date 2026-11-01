# Delegation status

The model calls `delegation_status` to see each delegation's state (running, done, closed or closed without a result), its identity, model and thinking, window, working directory and checkout.

## Sub-features

- `status-one` reports one delegation by id.
- `status-done` reads `done` with the result status after a result arrived.

## How to get to it (user POV)

- Ask the root model to call `delegation_status`, optionally with an `id`.

## Driving it with squire-verify

Preconditions:

- A delegation in this run with a result, for example `verifier-keep` from [Keep the window open](./auto-exit-off.md). Note its `<delegation>` id.

- **Ask.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs ask --run <id> --tool delegation_status --text "Call the delegation_status tool with id <delegation>, then reply with only its output, verbatim."`. JSON has `isError: false`.
- **Read.** `text` starts with `1 delegation:`, names `<delegation> verifier (opencode-go/deepseek-v4.1-flash, thinking low)`, `name: verifier-keep`, an `identity:` line with `depth 1`, and a `state:` line starting `done`. The entry is saved as `evidence/tool-delegation_status-<entry>.json`.

## Gotchas

- The model sometimes paraphrases instead of quoting. Judge by `text` from the tool result, never by the model's reply.

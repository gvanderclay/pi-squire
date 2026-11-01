# Keep the window open

`/delegate ... --no-auto-exit` starts a delegate that delivers its result but keeps its window open, so the user can read it or keep talking to it.

## Sub-features

- `no-auto-exit` keeps the window after the result.
- `result-still-delivered` delivers the result exactly as with auto-exit on.

## How to get to it (user POV)

- Type `/delegate verifier --label <label> --no-auto-exit <task>` in the root Pi.

## Driving it with squire-verify

Preconditions:

- A launched run with a passing `doctor`.

- **Launch.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs delegate --run <id> --label keep --no-auto-exit`. JSON has `window: "verifier-keep"` and a `nonce`.
- **Result.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs wait-result --run <id> --nonce <nonce>`. `status: "done"` and the nonce in `delegateAnswer`.
- **Window stays.** Wait 10 s, then run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs windows --run <id>`. A window named `verifier-keep` is listed with `dead: false`.

## Gotchas

- Leave this delegation for [Close a delegation](./close.md); it is the cheapest open window to close.
- Cleanup kills the window with the rest of the run; nothing else is needed.

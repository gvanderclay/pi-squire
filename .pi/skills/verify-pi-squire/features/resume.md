# Resume a delegation

The model calls `delegation_resume` on an exited delegation with a follow-up task. Squire reopens the delegate's own session in a new window under a new delegation id, and the follow-up's answer arrives as a new result.

## Sub-features

- `resume-start` reopens the session and returns a new delegation id with `resumedFrom` set to the old one.
- `resume-result` delivers the follow-up's answer as a `done` result, written in the original delegate session file.

## How to get to it (user POV)

- Ask the root model to call `delegation_resume` with an `id` and a `task`.

## Driving it with squire-verify

Preconditions:

- A delegation in this run that exited after its result, such as `verifier-first` from [Delegate and result](./delegate-result.md). Note its `<delegation>` id. Pick a fresh nonce such as `SQUIRE-resume-<random>`.

- **Ask.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs ask --run <id> --tool delegation_resume --text 'Call the delegation_resume tool with id <delegation> and task "Reply with exactly the text <nonce> and nothing else." Then stop.'`. JSON has `isError: false`, `details.outcome: "started"`, `details.resumedFrom: "<delegation>"` and a new `details.id`.
- **Result.** Run `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs wait-result --run <id> --nonce <nonce>`. `status: "done"`, `id` is the new id, and `delegateSession` is the original delegate's session file (its name ends in `_<delegation>.jsonl`).

## Gotchas

- Resuming a delegation whose window is still open is refused; close it or wait for auto-exit first.
- The resumed window reuses the original window name (`verifier-first`), so a name alone does not tell the two runs apart; use the ids.

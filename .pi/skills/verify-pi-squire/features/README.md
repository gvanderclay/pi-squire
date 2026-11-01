# pi-squire verification map

This folder is the maintained source for verifying pi-squire's user-facing behavior. Read the index, then use the matching feature file as the recipe.

## Baseline preconditions

- A run started with `node .pi/skills/verify-pi-squire/scripts/squire-verify.mjs launch` and a passing `doctor`.
- The root Pi has not been driven yet, or every earlier delegation in it has a result or is closed.
- Never drive a tmux server or Pi session this run did not start.

## Driving conventions

- Commands are literal. Replace `<id>` with the run id and `<delegation>` with an id a previous step returned.
- Give every `/delegate` a label unique within the run, so its window name is unique.
- Prompts to the root model name exactly one tool and every argument, and end with "then reply with only its output, verbatim."

## Proof and skip reporting

- A delivered result is proved by `wait-result`: `ok: true`, the expected `status`, and a `delegateAnswer` holding the nonce from `opencode-go/deepseek-v4.1-flash`.
- A tool's effect is proved by its saved result (`ask`) plus an independent read, usually `windows`.
- Report each sub-feature with the run id, `run.json` commit and `srcDirty`, and the evidence file names.
- Report a recipe that could not run with the command, its JSON, and the unmet precondition. Do not report a sub-feature as verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with squire-verify` (starting with `Preconditions:`), `Gotchas`.

## Features

- [Delegate and result](./delegate-result.md): `/delegate` starts a delegate, its answer reaches the parent as a `[delegate]` result, and auto-exit closes its window.
- [Keep the window open](./auto-exit-off.md): `--no-auto-exit` leaves the delegate's window open after its result.
- [Delegation status](./status.md): the `delegation_status` tool reports a delegation's state, identity and model.
- [Close a delegation](./close.md): the `delegation_close` tool kills a delegate's window and reports each member's outcome.
- [Resume a delegation](./resume.md): the `delegation_resume` tool reopens an exited delegate's session with a follow-up task.

Not mapped yet: nested delegation (needs `squire/settings.json` limits and an agent with `allow_nested_delegation`), managed worktrees (`--worktree`), `--cwd` project trust, the `/delegates` panel and the delegate widget.

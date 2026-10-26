# Plan: resume an exited delegate

Status: proposed. Research: [`docs/research/subagent-resume.md`](../research/subagent-resume.md).

## Decision

A resume **reopens the delegate's own session file** with `pi --session <path>`
in a new tmux window, and is recorded as a **new delegation** linked to the old
one. This is what every surveyed library that resumes does (nicobailon's
`revivedFrom`, edxeth, herdr-agents, HenryQW): same session file, new run id.

- A delegate whose working directory is gone, a removed managed worktree
  included, is **not resumable**. Pi runs a reopened session in its stored cwd
  and, interactively, blocks on a picker when it is missing
  (`dist/main.js:556`); we refuse before launch instead. edxeth and
  herdr-agents refuse worktree resumes for the same reason.
- Forking (`--fork <path> --session-id <new>`) is the later answer for that
  case, if we ever want it. Not in this plan.
- Never resume with `--session-id`: with an explicit `--session-dir` and a
  different cwd, Pi misses the file and creates a second one with the same id
  (research report, `session-manager.js:1421-1435`).

## Interface

- Tool `delegation_resume`, beside `delegation_status` and `delegation_close`;
  `delegate` keeps its name and schema.
  - `id` (required): the delegation to resume. A chain resumes from its newest
    record; resuming an older one is refused, naming the newest (as HenryQW
    does).
  - `task` (required): the follow-up. Without a request no result can come
    back. Opening the session for a human is `pi --session <path>`, outside
    this tool.
  - `model`, `thinking`, `auto_exit` (optional). No `cwd`/`worktree`: the
    session's stored cwd is the only one Pi will use.
  - Annotations: not read-only, destructive, not idempotent, open world.
  - Result: `DelegateSchema` plus `resumedFrom`.
- `/delegate-resume <id> [--model …] [--thinking …] [--auto-exit|--no-auto-exit] <task>`,
  reusing `word`/`flagValue`, with id completions from `results.list()`.

## Identity: delegation id vs session id

Today one id is both the delegation id and the delegate's Pi session id. A
resumed record gets a new delegation id but the same session, so the record
gains `sessionId?: string` (absent means `id`, so old records read as before)
and one helper, `sessionIdOf(record)`, used wherever the session is meant:

| Where | Today | Becomes |
|---|---|---|
| `message:send` `to` (`index.ts` launch) | `id` | `sessionIdOf(record)` |
| reply match in `takeReply` (`results.ts:455`) | `byRequest.get(r)?.id === reply.from` | `sessionIdOf(...) === reply.from` |
| `findSession` / `locateSession` | `_<id>.jsonl` | `_<sessionIdOf>.jsonl` |
| usage-limit marks (`limitLine`, `results.ts:213`; child records `getSessionId()`) | `includes(id)` | `includes(sessionIdOf)` |

Runs separate on their own: each run has its own request id, and `byRequest`
is keyed by request id, so a late reply to the first run's request settles the
first record and leaves the resumed one alone. No run counter, no state reset,
no change to `restore` beyond reading the new fields.

## Eligibility, checked in order

1. The record is a started delegation, not a workspace attempt.
2. It is the newest in its chain (no later record has `resumedFrom` = its id).
3. Its state is not `running` (mail it instead) and not `unknown`
   (tmux could not be asked: refuse rather than guess).
4. **The old process is gone**: tmux lists no window with the record's id and
   name, or lists it with an exited pane, which is killed first (the same
   check `delegation_close` makes). A window that merely shares the name is
   ignored.
5. Its session file is found and its header's `cwd` still exists. The header
   is read, not the record, since that is what Pi will use.
6. Its agent is still in the roster (prompt, tools, extensions, fallbacks).
7. No other resume of the same id is in flight in this process (an in-memory
   set, released on success or failure).

Not a guard: HenryQW's "last turn is terminal" check. A delegate whose window
was killed mid-turn (`gone`) has a non-terminal last turn, and that is exactly
a case worth resuming.

Residual risk, accepted and documented: a Pi process the user opened on the
same session outside pi-squire's window is not detected. A stronger check
needs either the pane pid recorded at launch (`#{pane_pid}`) or presence from
the `message:*` provider; both are follow-ups.

## Launch

Factor the argv/env building out of `launchWindow` so launch and resume share
it. The resume differs only in:

- `--session <absolute path>` instead of `--session-id <id>`; `--session-dir`
  stays `record.sessionDir`.
- No `--name`: the session keeps its name; the window reuses `record.name`.
- The window opens in the header's cwd; no workspace preparation or worktree
  creation. Trust is decided again for that directory through the existing
  `prepareDirectory` path.
- Model: an explicit `model` alone, or
  `[finishedModel ?? record.model, ...agent.fallback]` through `chooseModel`,
  so a delegate that ended on a fallback, or whose model is marked, moves on.
  `thinking` and `auto_exit`: request, else the record.
- System prompt: the same as a launch (agent prompt, final line, parent trust).
- `session:launch` is emitted with the same payload; the hook contract and its
  README fence do not change. The README's list of launch invariants gains
  `--session`.

Then, as for a launch: send the task with `to: sessionIdOf(record)`, open the
window, `recordStart` the new record with `resumedFrom` and `sessionId`, start
the poll. `child.ts` already claims any request from the parent; its prompt
text is unchanged.

## Status and rendering

- Status: a `resumed from <id>` line and `resumedFrom` in details; the old
  record shows `resumed as <id>`. The `state` description's "done and closed
  are final" gains "a later delegation_resume continues it as a new
  delegation".
- Result and gone messages name `resumedFrom`; the gone message points to
  `delegation_resume`.
- The `delegate` tool description gains one sentence on `delegation_resume`
  for follow-up work that needs the delegate's existing context.

## Tests

- argv has `--session <path>`, never `--session-id`, and no `--name`.
- The new record has a new id, `sessionId` = old, `resumedFrom` = old id; mail
  goes to the session id; its reply makes the new record done.
- A late reply to the old request settles the old record only, also after a
  restore.
- Refusals: attempt, not newest, running, unknown, missing session file,
  missing cwd, removed agent, concurrent resume.
- An exited own window is killed; a foreign window with the same name is
  ignored.
- Model choice: falls back past a marked `finishedModel`; an explicit model is
  never substituted.
- Old records (no `sessionId`) still match replies, find sessions and marks.
- `/delegate-resume` parsing and completions.

## Delivery

One pull request: `src/resume.ts` (eligibility and the tool), the shared launch
helper in `index.ts`, the `sessionId` threading, tests, README section
"Resuming a delegation", CHANGELOG entry. `node scripts/check-pack.mjs` for the
new file.

## Confirmed on Pi 1.3.0 (2026-10-26)

Run with `pi -p -ne` in `.scratch/tmp/resume-check/`: a session created with
`--session-id` and `--session-dir`, then reopened from another directory with
`--session <path> --session-dir <same>`.

- Reopening appends to the same file; no second file is created. The resumed
  run recalled the first run's reply.
- `--model` overrides the session's model: the resumed assistant messages are
  from the new provider/model. `--thinking` overrides too: `off` on the first
  run gave no thinking blocks, `high` on the resume gave them. Pi writes no
  `model_change` entry for the override, so `finishedModel` (read from
  assistant messages) stays the source of truth.
- pi-session-mail scans `new/` on every `session_start` for the session's id,
  whether the session is new or reopened (`pi-session-mail` `src/index.ts`
  `session_start` → `scan()`; README: a message to a closed session "is
  delivered when the session starts or resumes"). Confirmed from source, not
  yet run end to end in tmux; the implementation's manual test covers that.

## Follow-up: presence from the provider

pi-session-mail already keeps `<mail root>/running/<address>.json` with the
session's pid and a start-time token, and treats a dead or reused pid as not
running. That is the check that would close the residual risk above. It is
internal to pi-session-mail today; using it means adding a `message:*` hook
(for example `message:presence`) to the provider's contract, in its README,
not reading its files from pi-squire.

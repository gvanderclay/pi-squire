# Results and recovery

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Statuses](#statuses)
- [Delivery and durable state](#delivery-and-durable-state)
- [Restoring and inspecting a delegation tree](#restoring-and-inspecting-a-delegation-tree)
- [Usage limits](#usage-limits)
- [Auto-exit](#auto-exit)
- [Results](#results)
  - [Reopening a delegate's session](#reopening-a-delegates-session)
- [Resuming a delegation](#resuming-a-delegation)
- [Forking a delegation](#forking-a-delegation)

## Statuses

`delegation_status` reports one state per delegation. Without an `id` it lists
every running delegation and unfinished workspace attempt, plus the 5 most
recently settled records, so the default list is partial. Every call's
structured result carries `selection`, saying what it selected: `scope`
(`recent`, `all` or `id`), `total` (every record in the session, unfinished
attempts included; 1 for an `id`), `shown`, `omitted`, and, when records were
left out, a `notice` saying how many older settled records (delegations and rolled-back
workspace attempts) were omitted
and that `delegation_status` with `all: true` gives the full inventory, `id`
one delegation. The heading carries the same sentence. `all: true` lists
every record, and an `id` selects one, including one the default leaves out.
List responses use a compact block of five base lines at most for settled
delegations: id/agent/model/thinking, state, checkout summary (with a
changed-path count when non-zero), session path, and envelope path when
present. Resume/fork relationships add their existing `resumed from`,
`forked from` and `resumed as` lines when present, so the newest id in a resume
chain remains visible. Running delegations and workspace attempts keep their
full blocks; `id` gives a delegation's full block. Structured details keep the
full snapshot and the `selection` object. Settlement order uses the recorded
settlement time; older sessions without one rank below timed records,
later-recorded first. Closing a delegation that already has a result keeps its
earlier settlement time. A started delegation with no result whose state is
unknown, because the host could not be asked, is listed like a running one.

```text
2 delegations:

<id> scout (provider/model, thinking low)
  name: scout-<first 8 of the id>
  state: running — the window is open and no result has arrived (last active 12 min ago)
  window: scout-<first 8 of the id> (@1)
  cwd: <the directory its window opened in>
  workspace: existing directory; Git checkout <main root> (linked worktree <checkout>), branch <name>, launch commit <sha>
  checkout now: branch <name>, head <sha>, launch commit <sha>, 1 commit since launch, working tree dirty
    2 changed paths; details in the structured result
  auto-exit: on — the delegate closes its window after a normal completion unless the user took over there
  session: <the delegate's session file, or its id when there is none yet>

<id> researcher (provider/other, thinking high)
  state: done — result status: done
  checkout now: Git state unknown (this delegation was recorded before its launch checkout was kept)
  session: <session file>
  envelope: <the reply's path in the parent's cur/>

Pass id for a delegation's full block.
```

- **Name** is the delegate's Pi session name, its agent and the first 8
  characters of its delegation id.
- **Running** means the window is open and no result has arrived. An open
  window is connection, not task state: the delegate may still be working, or
  waiting for the user, and only a result means done.
  When the delegate's session file exists, the line ends with when it was last
  written (`just now`, `12 min ago`, `2 h 5 min ago`). That is a hint, not
  proof: a long gap may mean the delegate is stuck, or just thinking.
- **Done** comes from the recorded result, and shows the envelope's status
  (`done`, `failed` or `stopped`).
- A delegate that closed itself by auto-exit reads **done**: its result
  arrived before its window went. For a moment before the result is claimed
  it can read closed, since the window is already gone.
- **Auto-exit** reads off for delegations recorded before auto-exit existed.
- **Cwd** is the directory the delegate's window opened in. A delegation
  recorded before it was kept reads `unknown (not recorded)`, never the
  parent's current directory.
- **Workspace** says how the directory was chosen and its Git checkout at
  launch (see [Working directory](workspaces.md#working-directory)); older records have
  none.
- **Checkout now** is a fresh [snapshot](workspaces.md#checkout-snapshots) of that
  checkout, taken by this call; the details carry it as `workspaceSnapshot`.
  The text shows the summary line and, when paths changed, a count; the full
  path categories are in the details. A failure is unknown for that delegation
  alone.
- **Session** is the delegate's session file, searched for in the storage
  directory recorded at launch. Once found, its path is kept, so a later
  status or result uses it without searching again. Before the delegate has
  written its file, the id is shown instead of an invented file name.
- **Closed** covers a close `delegation_close` recorded and a window that is no
  longer there. A recorded close wins over a result, and a result wins over a
  window that is gone.
- **Closed without a result** is what the poll records when a window is gone
  and no reply arrived (see [Results](results-and-recovery.md#results)). A result outranks it, so a
  late reply turns it into **done**; a close from `delegation_close` outranks
  both.
- When tmux cannot be asked about a window, the state is `unknown`, never
  `closed`, because a failed check is not evidence the window is gone.

`delegation_status` also ends with a `Usage-limit marks:` block, one line per
active mark: its scope, source (`reactive` or `proactive`), clear time and
reason (cut to about 120 characters), then one line per provider whose last
quota reading failed. The block is left out when there is neither, and shows
even when no delegation is recorded. The details gain a `marks` array of
`{ scope, source, reason, clearsAt }` and a `readingErrors` array (see
[Usage limits](results-and-recovery.md#usage-limits)).

## Delivery and durable state

Task ownership and a frozen final-answer outbox live in
`<agent dir>/squire/task-replies/<session id>.json`, independently of Pi's
buffered transcript. Atomic file replacement preserves pending answers over
reload, restart, squire resume and manual reopening of the same session with
the same agent directory. Identity and auto-exit state live separately in
`<agent dir>/squire/identity/<encoded session id>.json`; manual reopening
restores parent/root/depth/agent/chain, the original `rootPlacement` companion
preference and the saved auto-exit setting. This internal placement scalar adds
no launch environment variable or `session:launch` field. The
launch-time remaining fallback list is not restored by a manual reopen;
terminal-hosted Squire resume supplies its current fallback candidates. Native
Paseo resume instead reuses the original daemon-stored launch environment and
fallback list.

Direct-child facts and pending result/gone outcomes live in
`<agent dir>/squire/child-tasks/<encoded parent session id>.json`, independently
of transcript buffering. Starts and terminal outcomes are saved locally before
result injection. Restoring these facts precedes Squire task handling. If mail
claims before that restoration (including delayed startup or a duplicate
process), matching Squire input is staged durably for the sole owner.
Each model request includes pending outcomes; only those observed by a request
and followed by a non-stopped settlement are acknowledged. The task reply gate
requires no unfinished children and no unprocessed outcomes. Storage failures, including incomplete transcript/child-identity restoration,
block final completion/auto-exit and new launch/resume admission in roots and
coordinators. Read-only admission checks the restored store health; a write
preflight persists unchanged task facts before mail, windows, worktree creation
or killing an exited resume window. Repair unhealthy storage and reload before
launching again. An incomplete-restore latch also refuses incidental saves, so
partial in-memory records cannot replace known pending obligations. These local
task records remain the result-processing authority;
the shared [tree registry](nesting.md#tree-wide-launch-budgets) indexes their durable
lifecycle facts without copying task bodies or processing outcomes.

A failed write produces a visible `delegate: could not handle the task reply`
error and blocks auto-exit. A frozen answer is retried on the next settled
run, or on reload/reopen (starting on the next event-loop turn); the next
run's text does not replace that answer. An async startup handler between
squire and mail can delay provider initialization past that turn, so a failed
startup attempt gets two additional reply attempts, 100 ms apart, on an
unref'd timer. After those attempts, any failure is visible and no ongoing
retry timer remains. Fix the provider or storage error and reload/reopen to
retry without a model call. A successful startup retry does not itself close
the window.

Mail does not deduplicate replies. A crash after the envelope write but before
completion recording can cause squire to resend the saved outbox. This is
at-least-once transport, not atomic exactly-once delivery. The parent matches
every correlated task id, records each as answered, and suppresses further
final results for those ids even when a retry has a new envelope id. One
envelope answering several owed tasks is shown once, using its last pending
delegation for the displayed task quote.

## Restoring and inspecting a delegation tree

Reopen the **same Pi session id**, using the same agent directory, to restore its
identity, direct-child tracking, polling, pending results and owed answers.
Still-running windows are not recreated. Shared counts survive; reopening a
historically gone but unfinished coordinator counts it toward concurrency again,
without charging another lifetime launch. A Squire resume is different: it
starts another delegation and spends another lifetime launch.

Only one Squire runtime may act for an exact session identity. Process ownership
uses the same cross-process lock as admission, with a per-runtime token and no
time lease. A live/paused duplicate is refused and asked to shut down; it cannot
launch, process outcomes, send final replies or start a trust service. Already-
claimed matching Squire task/reply input is staged under
`<agent dir>/squire/owners/<encoded session id>/inbound/` before acknowledgment,
with an atomic per-envelope file, independent of the ownership lock. Only the
owner drains it, in provider timestamp/path order, through normal handling;
callbacks run outside the owner mutex and idle drain checks do not write lock
files. If staging is unwritable, an active ready owner can process directly.
A duplicate that cannot retain input reports the claimed path and asks for a
resend: delivery cannot be lossless without writable storage.

This safeguard covers Squire input, not ordinary mail/asks: a duplicate provider
can deliver those only in the losing process, not to the owner. Its shutdown can
also remove the shared running record, making the owner look not running to
`session_mail_ask` until its next provider announcement (such as `agent_start`).
Squire does not read or rewrite provider mailbox/running-record internals. Keep
one Pi process per session. Ownership refusals name the PID and owner file; if
stale/corrupt, verify the original owner has ended, stop affected Squire runtimes
and repair only that record. Never remove live lock tickets or force adoption.

Fresh sessions neither adopt nor report earlier trees. Each session sees only
its own tree; to collect the delegates of a session you closed, reopen that
exact session, which restores its full tree.

Both `delegation_status` and the compact widget show descendants: a root sees its tree;
a coordinator sees only its own subtree, not siblings or unrelated roots.
Hierarchy uses stable Pi session ids, not the new delegation id of a resume.
Parent/root/depth, launch/result/session paths, workspaces, current verified
window and resume history remain visible. Shared accounting is labeled separately
from semantic result state: a finished accounting entry is not proof its direct
parent received or processed the result. Registry-only rows without a complete
launch record remain unknown. Views read foreign parents' facts but never inject
grandchildren's raw results into the root conversation.

Only the **direct parent** may resume a child. Ancestor visibility grants no
resume authority; forked/cloned/copied history with a new Pi id grants none.
Return to the original parent. Identity is read from exact-id durable state,
written before launch; inherited launch environment cannot assign a new session
to the old tree. Current allowlists, depth, caps and
directory/source trust still apply to terminal resume, including its picker.
Native Paseo resume keeps its original trust and launch settings, while current
allowlists, depth and caps still apply. A live
same-id Squire owner and obsolete local/shared resume chains are refused.

## Usage limits

Usage-limit errors still create shared reactive marks. The proactive checks
and fallback behavior below describe legacy, unbound agents. Routed agents use
the cached, explicitly applicable quota observations described under
[Role/task routing](routing.md#role-task-routing); reactive marks still
constrain their candidates.

When a delegate's run ends on a usage-limit error, it records a mark in
`pi-squire-limits.json` in Pi's agent directory, which every Pi session on the
machine reads. Quota messages count, and so does a `429` that survived Pi's
retries; overloaded and `5xx` errors do not. A mark covers the failing
model's whole provider, except for a free model (an id ending in `-free`, or
zero cost in Pi's registry), which is never covered by a provider mark and,
when it is the one that failed, is marked alone.

A mark clears at the reset time the error states ("try again in 30 minutes",
`resets_at`), otherwise after 5 minutes, doubling on each repeat hit up to 6
hours. When the failed response's headers state a reset (`retry-after`,
`anthropic-ratelimit-*-reset`, `x-ratelimit-reset-requests` or `-tokens`),
that time wins over the error text. Until then `delegate` and `/delegate`
refuse a marked model passed as `model` / `--model`, say when it clears, and
name the agent's own models that are not marked, so the caller can omit the
model instead.

Without an explicit model, the delegation launches on the agent's model, or
else on the first of its `fallback` models that has credentials and is not
marked. The tool result and the command's notice then say, for example, "Used
fallback opencode-go/b because alpha/fast-model is usage-limited until …", and
the result details list the skipped models under `skipped`. When every
candidate is marked or unusable, the call is refused with one line per
candidate and why it was skipped.

The launch also passes the candidates after the chosen one to the delegate as
`PI_DELEGATE_FALLBACK` (none for an explicit model). When a delegate's run
ends on a usage limit, it switches its session to the first of them that has
credentials and is not marked, adds a message saying so, and continues the
task there, so work done so far is kept. An alias resolves to one model, as
it would in Pi's `--model`. Each model is tried once, never the one that just
failed; when none is left, the run fails as before. A `done` result from such a delegate
carries the `Usage limit:` line too, saying it finished on a fallback.

Before a launch, pi-squire also reads the OpenCode Go quota for a paid
`opencode-go` candidate (`GET https://opencode.ai/zen/go/v1/usage`, with the
provider's API key). A window at 100% or more, or one the provider reports as
`rate-limited`, skips the candidate and records a `proactive` mark on
`opencode-go`, for example "Go 5h window at 100%", that clears at that window's
reset time (the 5-minute cooldown when none is given). A reading is reused for
60 seconds. Free models and other providers are never read, and a candidate that
is already marked is skipped without a read. The key is sent only to
`https://opencode.ai`, with redirects refused: a provider or model base URL on
another origin means no request at all.

For an `anthropic` candidate used through a Claude subscription (an OAuth
login; API-key users get no proactive check and rely on reactive marks),
pi-squire reads Claude Code's own usage cache, the `cachedUsageUtilization`
field of `$CLAUDE_CONFIG_DIR/.claude.json` (`~/.claude.json` when the variable
is unset). It never calls Anthropic's usage endpoint. A 5-hour or 7-day window
at 100% or more records a `proactive` mark on `anthropic`, cleared at that
window's reset time. A model-scoped weekly window at 100% (for example Opus)
marks only the `provider/model` candidates whose name or id contains the scope
name, so other Anthropic models stay usable. The check reads the cache as it
stands and never waits: when the cache is missing or older than 5 minutes,
pi-squire starts `claude -p /usage --no-session-persistence` in the background
(in a temporary directory, output discarded, killed after 30 seconds) so Claude
Code rewrites it, at most once every 5 minutes per Pi process. It starts only
when Claude Code state exists (`$CLAUDE_CONFIG_DIR`, or `~/.claude.json` or
`~/.claude` when the variable is unset). A missing `claude` binary is ignored. A
window at 100% whose reset time has already passed counts as reset and blocks
nothing.

A failed reading (for Go: no key, a base URL off the Go origin, a non-2xx
answer, an unreadable body, a timeout, a network error; for Claude: a missing or
unreadable cache) never blocks a launch. The tool result and the command's
notice gain "Could not read <provider> quota: <reason>; launched without a
proactive check.", and `delegation_status` lists the provider's last reading
error and its time under the `Usage-limit marks:` block and in a `readingErrors`
array of `{ provider, reason, at }`.

A mark can also clear early. When a launch considers a marked `opencode-go` or
OAuth `anthropic` candidate, pi-squire re-checks that provider's quota, at most
once every 10 minutes per provider and never in the background, and not for a
mark recorded less than 10 minutes ago. It clears a mark only when the reading
succeeded, every applying window is under 100%, and a window began a new cycle
after the mark was recorded (its reset time minus its length is later than the
mark's time); headroom alone never clears one, because a quota endpoint can show
headroom while the account still answers 429. A model-scoped Claude mark clears
only when its scoped window has reset; a model-scoped mark on `opencode-go`
never clears early, because Go has no scoped window. A window without a reset time or
length cannot prove a reset. The tool result and the command's notice then say
"Cleared the usage-limit mark on <scope>: its quota has reset since the mark was
recorded." A failed re-check keeps the mark, lists the reading error in
`delegation_status`, and adds no note.

A mark can be stale (the quota came back, or the plan changed). Only you clear
one, with `/delegate-clear <target>`: `all`, a provider (its mark and every
model mark under it), or `provider/model` (that model's mark and the provider
mark covering it). Clearing also forgets the repeat-hit history, so the next
hit starts at 5 minutes again, and drops the cached quota reading so the next
launch reads it afresh. With no argument, or one matching no active
mark, it changes nothing and lists the active marks. No tool clears marks.

## Auto-exit

The parent resolves each delegation's auto-exit from the call
(`auto_exit`, or `--auto-exit` / `--no-auto-exit`), then the agent's
`auto_exit`, then on, and passes it to the child as `PI_DELEGATE_AUTO_EXIT`
(`1` or `0`). Inside the delegate:

- While it is on, a run that settles as a normal completion closes the
  delegate on the next event-loop turn, after its task reply has been sent.
  In tmux and Herdr this uses `ctx.shutdown()`; the session file stays, and
  `pi --session <path>` reopens it (see [Reopening a delegate's session](#reopening-a-delegates-session)).
  In Paseo it archives the agent and retains its transcript, rather than
  deleting it (see [Paseo support](hosts.md#paseo-support)).
- A failed final run, such as one ending on a usage limit or another provider
  error after fallbacks are exhausted, exits like a normal completion; the parent still gets the failed
  reply and the session file stays. Only a run the user stopped never exits
  the delegate.
- A coordinator cannot exit until its child tasks finish and their outcomes
  are processed in a subsequently settled run. An intermediate failure sends
  no final task reply and keeps it available for child results.
- The user taking over turns it off for the rest of the session, with a
  notice: typed or RPC input, or a run the user stopped (Esc).
- `/auto-exit` inside the delegate turns it on again for the next normal
  completion, whatever the launch said.
- The footer shows that this is a delegate, its agent, and whether auto-exit
  is on: `👦 worker delegate · auto-exit on`, or
  `👦 worker delegate · auto-exit off`, with 👦 or 👧
  picked at random per session. Its status key is `delegate-self`; its own
  running-child count uses `delegate`, so the footers do not overwrite each other.

There is no `subagent_done` tool: auto-exit off only means the delegate stays open.

## Results

A delegate answers its task with one reply through the `message:*` provider.
`pi-squire` takes that reply over before the provider can inject it, and sends
the parent one message labelled delegate output:

```
[delegate] Result from scout (provider/model), delegation <id>, request <request id>.
Status: done
Usage: 24 turns, 1.8M tokens in (1.7M cached), 9.2k out, $0.39; context at finish 181k.
Task: <sent/ copy>
Working directory: <the directory its window opened in>
Checkout when the result arrived: <branch, head, launch commit, commits since launch, clean or dirty>
Envelope: <cur/ path>
Delegate session: <session file or id>

<the result>
```

- The header carries the agent, the model, the delegation id and the request
  id; the status is the envelope's (`done`, `failed` or
  `stopped`).
- The model is the one the delegation was launched on. When the delegate's
  session file shows it finished on another (a fallback after a usage limit,
  or `/model` in its window), it reads `launched → finished`, for example
  `(anthropic/claude-haiku-5-5 → openai/gpt-6-luna)`. `delegation_status`
  reports the same.
- `Usage:` reports whole-session token use across all branches, including
  assistant calls, compaction, branch summaries, standalone billed operations
  and nested model work reported by tools. Turns count assistant messages only.
  Tokens in include ordinary input plus cache reads and writes; `cached` means
  cache reads. Cost is shown only when every counted call has a total (billed
  when the provider supplies it, otherwise the catalog estimate); zero stays
  zero; a cost under half a cent reads `<$0.01`. Context is the input plus cache
  reads and writes, excluding output, of the last assistant request that neither
  failed nor was aborted, so a run ending on an error keeps its real size. A
  resumed session includes its earlier spend; a fork includes copied history, so
  these are not per-attempt or tree totals, and the line then ends `Counts the
  whole session, including work before this delegation.`
  No readable usage means no line. The result saves the totals; the expanded
  result and full `delegation_status` blocks show them too. A full status block
  reads live usage when no result saved it, so a running delegation and one that
  ended without a result both show it; settled list rows keep it in structured
  details without adding a text line. A delegation that ends without a result
  carries the same `Usage:` line in the message the parent receives, read from
  its session file then.
- That text is what the parent model reads. The user sees the delegation as
  one tool call that changes state, in the style of
  [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents):
  - The `delegate` row shows `○` with the agent, the label, the task's first
    line and its line count while the call runs. Once the delegate starts,
    that header is replaced by `● <name> (<model>) — started` over the same
    task line, with any skipped fallback model. A refused call keeps its
    `○` header above the plain error text.
  - The result arrives drawn as a finished tool row, on Pi's tool success or
    error background: `✓ <name> (<model>) — done`, or `✗` with `failed`,
    `stopped` or `closed without a result`. Collapsed, it previews the first
    5 non-blank lines with heading marks, backticks and bold stripped;
    expanded (Ctrl+O), it shows the result as Markdown, the quoted task, then
    the ids and files, with the home directory shown as `~`.
- Stopping a delegate's run (Esc) sends no result: pi-squire holds the
  task, so the delegation stays running while the user steers it. The next
  run that completes successfully sends the result, `done`, and its body opens
  with a note that the user took over partway. Failed runs in between do not
  answer a held task. Asks are different: the mail provider still owns their
  replies, including `stopped` replies, and does not hold them.
- A `failed` reply from a delegate that recorded a usage-limit mark (see
  [Usage limits](#usage-limits)) gets one more line right after `Status:`,
  for example `Usage limit: the delegate hit a usage limit on provider
  opencode-go; it is marked until 2026-10-03T12:05:00.000Z and later
  delegations skip it.` (a model scope reads `on model provider/id`; a mark
  that has since cleared reads `it was marked until …`). A failed reply with
  no such mark is unchanged.
- `Task:` points to the full request copy in `sent/`. The message details
  and expanded view retain a task preview capped at 2 KiB. A request with no
  copy gets a diagnostic with its request id.
- The working directory is the one recorded at launch, or
  `unknown (not recorded)` for a delegation recorded before it was kept.
  The recorded [workspace](workspaces.md#working-directory) remains in message details
  and the expanded view, but the model-facing result omits its launch summary.
  Closed-without-a-result messages still include that summary when recorded.
- `Checkout when the result arrived:` summarizes the
  [snapshot](workspaces.md#checkout-snapshots) taken as the reply was claimed. Git summaries
  keep the branch or detached HEAD, full head and launch commit, commits since
  launch, and working-tree state. Path categories remain in the saved snapshot,
  message details, and expanded view, not the model-facing result.
  The reply is claimed first, so a slow or failing Git cannot lose or duplicate
  it. An unknown snapshot includes the reason. A non-Git directory reads
  `not a Git checkout`.
- The envelope path is the claimed reply in the parent's `cur/`; the
  delegate's session path is found by the delegation id in the session
  directory recorded at launch (the parent's current one for older records),
  and the id alone is shown when no file exists yet.
- The body keeps its first 8 KiB and its last 24 KiB, 32 KiB in all. A reply
  within the budget is kept whole. A longer reply is cut, and before the body,
  outside any Markdown fence the reply opens, the result says so and names the
  whole reply:

  ```
  [delegate] Incomplete reply: <N> UTF-8 bytes omitted from the middle. Before acting on this report or treating it as complete, read the "body" field of the JSON envelope at <envelope path>; findings, conditions, or required steps may be missing.
  ```

  The envelope is the provider's JSON file; its `body` field holds the whole
  reply. One line at the cut names how many KiB were dropped and the envelope
  path: `[delegate] 24 KiB omitted here; the full reply is <envelope path>`.
  The budget is the `resultBodyKiB` setting, a whole number of KiB from 4 to 64;
  the head is one quarter of it and the tail the rest. Both cuts fall on UTF-8
  character boundaries. An invalid value warns and the result uses the
  default, since a claimed reply must still be delivered.
- The message is sent as a `steer` with `triggerTurn`: a result starts a
  turn when the parent is idle, and when it is mid-turn arrives after the
  current tool calls, before the next model call. A follow-up would wait
  until the parent had answered, by which time it had often read the
  envelope itself, and the late result cost a second, redundant turn.
- The [direct-delegate overview](delegation.md#direct-delegate-overview) replaces Squire’s
  running-count entry in interactive Pi. With its cap set to zero, or in a
  non-TUI host, the footer counts running delegations (`👨 N delegates running`,
  with 👨 or 👩 picked at random per session), clears one entry per result or
  close and hides itself at zero. The own-delegate badge stays separate.
- Each result and each close is recorded in the parent session, and the
  records are rebuilt synchronously at session start. A resume still
  recognises replies, including one that arrived while the parent was
  closed, and still reports a recorded close as closed. A result is shown
  once for ordinary transport retries. Unprocessed coordinator outcomes may
  be replayed on reopening. A root retains outcomes until processing too: an
  already-displayed result wakes a recovery turn without displaying the final
  result again, and pending content is supplied to the next model request.
  An explicit root user stop is persisted: reopening does not start that work
  again automatically. Previously held outcomes wait for a later input or a
  genuinely fresh outcome. New live results still steer/start a turn, and new
  gone outcomes keep their normal wake delivery; they clear the held replay
  state. Coordinator held-task semantics stay unchanged.
- Plain replies, and requests not taken over as this delegate's task, are left
  to the provider. Squire never answers those ordinary requests.

While any delegation is running (no result, no close), the parent polls every
5 seconds; the timer does not keep the process alive and stops when nothing is
running and on `session_shutdown`. Each tick first emits `message:scan`, so the
provider claims waiting replies, and then lists the tmux windows once and
matches each still-running delegation to a window by id and name (window ids
restart with every tmux server). A window whose program has exited counts as
gone. A delegation whose window is gone and still has no result after that
scan is recorded as closed without a result, a record separate from
`delegation_close`'s, and the parent gets one `[delegate]` message naming the
delegation, with the delegate session path when one is found, sent as a
`followUp` with `triggerTurn` (a coordinator uses `steer` to process the missing
outcome before its final report). A tick declares nothing when nobody answers
`message:scan` or when tmux reports an error. A reply that arrives later is
still delivered and makes the delegation done. A resumed session polls again
for every delegation it restores as running.

### Reopening a delegate's session

`delegation_status` and every result name the delegate's session file by its
absolute path. Reopen it with that path: `pi --session /absolute/path/<file>.jsonl`.
Pi groups sessions by working directory: the session picker and an id given
to `--session` search the current project first, and may miss a delegate's
session or offer to fork it rather than open it when the delegate ran in
another directory or its file lives in another storage directory. The
absolute path opens that file directly.

## Resuming a delegation

**Breaking resume change:** delegations recorded without the required
original-root placement identity cannot be resumed after this update. This
includes pre-nesting and identity-less records, even when their original root
reopens them. The tool, command and picker refuse before trust resolution, mail,
killing an exited window, reserving a launch or spawning a new window. There is
no legacy identity synthesis or migration.

### Paseo native resume

An archived Paseo delegate can continue with `delegation_resume({ id, task })`
or `/delegate-resume <id> <task…>`; no arguments opens the same eligibility
picker. It keeps the **same Paseo agent, Pi session file and conversation**.
Only its original Paseo-hosted direct parent may resume it; fork stays refused.
An explicit close deletes the agent and cannot be resumed. An open agent
should receive mail instead.

Every explicit `model`, `thinking`, `auto_exit` or `routing` override is
refused, even if unchanged. Native reload preserves original tools, trust,
prompt, fallback and launch environment; current roster launch-setting edits
are **not** applied. Recorded auto-exit is retained. `session:launch` is not
emitted on native resume: its original hook-produced arguments/environment are
reused. Identity notifications, completion holds and result delivery still run.

Squire verifies the exact Squire-labelled agent/native parent, Pi runtime and
persistence ids, original native path, session header and cwd, and archived
state before any reservation. It checks again before reload, then verifies the
actual returned runtime session before sending the follow-up. A missing/moved
session file, deleted agent, mismatched identity/cwd or ambiguous daemon state
fails closed, never importing a replacement session. Routed records, current
routing profiles and persisted routing history are refused. Legacy records
without a managed-workspace receipt may resume if exact verification passes.

Each resume still has a new delegation id and `resumedFrom`, uses the old
session mail address, reapplies direct-parent/roster admission and tree
caps/fences, and refuses a live exact-session Squire owner. Mail failure
re-archives the original agent rather than deleting its conversation. That
post-open mail failure leaves a shared started successor, so Squire refuses
another resume of the chain (as with terminal resume). Inspect or continue the
preserved conversation manually in Paseo/Pi with only one writer, or start a
fresh delegate; do not delete tracking history to force a retry.

A refusal before reload, or a failed/mismatched reload whose rollback is
confirmed archived and closed, instead refunds its reservation and can be retried
once the source passes readiness again. Unconfirmed rollback remains charged
and requires inspection. Details:
[Paseo support](hosts.md#paseo-support).

### Terminal-hosted resume

An exited terminal delegate can continue its own session with a follow-up task:

```text
/delegate-resume <id> [--model <provider/id>] [--thinking <level>] [--routing "<JSON>"] [--auto-exit | --no-auto-exit] <task…>
```

The model does the same with `delegation_resume` (`id` and `task`, optionally
`model`, `thinking`, `routing` and `auto_exit`), which returns the `delegate` tool's result
plus `resumedFrom`. The command completes the ids that can still be resumed.

`/delegate-resume` with no arguments opens a picker instead: the delegations
that pass every check below (newest first, from one look at tmux), then the
multi-line editor for the follow-up. When the selected role is bound to a
routing profile, it also asks for fresh routing JSON. The checks change nothing: it refuses as the
command does when tmux is older than 3.2 or `windowPlacement` is invalid, and leaves out a
delegation whose recorded thinking level is invalid or whose model and fallbacks cannot be used
(credentials, usage limits). An exited window is left for the resume to close, and trust is
asked only when you resume. The model, thinking level and auto-exit are the delegation's own,
and it resumes as the command does.

- The delegate's own session file is reopened with `pi --session <absolute path>`
  and the recorded `--session-dir`, in a new window named like the first. The
  delegate keeps everything it read and decided; Pi appends to the same file.
  Opening it yourself is `pi --session <path>`, outside this tool.
- When the source's last successful request reported 50k tokens of context or
  more (input plus cache reads and writes), the result reports that historical
  size, not the context Pi will reload after compaction or a branch switch;
  if the task does not need that context, a fresh delegate with a written
  summary may be cheaper. Cache advice compares the effective model with the
  model of that same request, resolving aliases through Pi: a different model
  warns of a new cache write, and an unknown identity says the cache may not
  carry over. Without usable usage, cache advice falls back to the last
  assistant model, without a size estimate. These are notices, never refusals.
- The resume is recorded as a **new delegation** with its own id and a
  `resumedFrom` naming the old one. Its task goes to the old session's mail
  address, and its result arrives as a `[delegate]` message that names
  `resumed from <id>`. Status shows `resumed from <id>` on the new delegation and
  `resumed as <id>` on the old one. A late reply to the old request still
  settles the old delegation only, and a resumed delegation is never reported
  closed without a result.
- Unlike a launch, the task is mailed after the window opens: the session's
  inbox outlives a failed attempt, so a task sent for a window that never
  opened would reach the next resume as a second task. The reopened delegate
  receives it once its mailbox starts. If the send fails, the new window is
  killed and nothing is recorded.
- Only its direct parent may resume it, preserving the original root/depth.
  The current parent grant, depth/cap/trust checks are reapplied.
  A chain resumes from its newest local/shared delegation; older records and
  copied fork/clone history are refused, naming the owner or newest record.
- It is refused, before anything is sent or opened, unless: the delegation is a
  started one (not a workspace attempt); it is not `running` (mail a running
  delegate instead) and tmux can be asked; no window with its id and name still
  runs a program (an exited one is killed first; a window that merely shares the
  name is ignored); its session file is found and the working directory in the
  file's header still exists; its agent is still in the roster and not disabled
  (a disabled agent's refusal names its file and the reason); and no other
  resume of it is under way. A delegate whose window was killed mid-turn can be
  resumed after a completed close; an unresolved active subtree close refuses
  resume until positively resolved by an explicit retry.
- A removed working directory, a removed managed worktree included, makes a
  delegation not resumable: Pi runs a reopened session in its stored directory.
  The window opens in that directory, with project trust decided again for it as
  for `cwd` (see [Project trust](workspaces.md#project-trust)); there is no `cwd` or
  `worktree` for a resume, and no worktree is created.
- For a legacy agent, without `model` it continues on the model the delegate
  finished on, moving to its agent's fallbacks when that one is unavailable or
  marked (see [Usage limits](#usage-limits)). An explicit `model` is used alone
  and refused rather than substituted. Without `thinking` it continues on the
  level the delegate last ran on: the last thinking-level change on its
  session's active branch (Pi records one at start, one per change, and one
  when a model change clamps the level), or the delegation's recorded level
  when the session has none. For a routed role, supply fresh `routing` metadata;
  blank model/thinking choices use the policy rather than the last served model
  or effort. `auto_exit` defaults to the delegation's own. A
  field the agent locks is the exception: for legacy agents it runs on the
  agent file's current `model` (then its fallbacks, even when the delegate had
  moved to a fallback) or `thinking`; for a routed role, a locked model still
  has to be a policy candidate, and a locked thinking value cannot bypass route
  constraints. A value passed for a locked field is not used, with a notice,
  and passing the
  file's own value is the same as passing nothing. The agent's prompt and tools are those of the
  roster now, and an agent without a `tools` field gets the parent's tools as
  they are at the resume.
- `session:launch` is emitted as for any launch, with the same payload.
- A live Squire owner for the same exact session id in the same agent directory
  refuses resume, including a manual reopen outside the recorded window. This
  checks Squire's owner record and PID, not every Pi process or session-file user.
  A Pi opened without Squire (or with another agent directory) is not covered;
  close it yourself before resuming.

## Forking a delegation

Call `delegation_fork({ id, task })` when new work needs a child's built context
without continuing that child's session. The tool is deferred, so it is not in
every request's tool list: find it with `tool_search`, or call it from a
codemode script. When neither `tool_search` nor `codemode` is active,
pi-squire declares the fork itself so it stays reachable; it decides that once,
when the session starts, so turning both off later leaves the fork undeclared.
`delegation_resume` stays declared either way. It runs
`pi --fork <child session file> --session-id <new id>` in a new tmux window.
The source may still be running; its window, task and session file are untouched.
Without `worktree`, both sessions share the working folder; the tool warns when
the source is running and recommends `worktree` to isolate their file changes.
Pi copies the source history available when the new process starts, not future
messages. An older delegation in a resumed chain names that chain's shared
session file, so it copies the session's current history rather than an old snapshot.

The new session runs in the working folder from the source session's header.
Pass `worktree: "<new branch>"` to create a managed worktree from that folder's
checkout instead; `worktree_base` optionally selects a local commit-ish rather
than its HEAD. Normal worktree trust, placement and rollback checks apply.
This copies conversation context, not uncommitted checkout changes.
The fork's launch prompt names the source folder and tells it to work only in
the new worktree, where the source's uncommitted changes are absent.

The tool returns the `delegate` result plus `forkedFrom`. The new delegation
has its own session/mail address and window name, and receives the new task
like a fresh delegate. Its result arrives through the normal `[delegate]`
message; results and status name `forkedFrom`. Forking does not supersede the
source or prevent further forks/resumes.

Only the source's direct parent may fork it. The source session and working
folder must exist, its agent must still be enabled, and current nesting grants,
depth, capacity and trust checks apply. Copied history does not transfer
ownership of the original child's descendants. Model, thinking and auto-exit
default to the source's last settings with the same locks and fallbacks as a
resume; the current roster supplies the prompt and tools. Cache advice compares
the effective model with the source's last successful request's model using
Pi's alias resolver: a different model warns of a new cache write, and an
unknown identity says the cache may not carry over. Without usable usage, it
falls back to the last assistant model without a size estimate. At 50k context
tokens or more (input plus cache reads and writes), the result reports what that request
sent, not how much context the fork copies or reloads; if the task does not
need that context, a fresh delegate with a written summary may be cheaper.
A running source can advance before the notice is read, and compaction or a
branch switch can reduce the context Pi reloads. Keep the source's model unless
the task needs another role. A fork from a routed role requires fresh
`routing` metadata and cannot carry forward a public-context attestation. `session:launch` is emitted with the
`delegation_fork` tool call id.

# pi-squire

Starts a delegate Pi session in a background tmux window and shows you its result.

You give a task to a named agent with the `/delegate` command, or the model does
it with the `delegate` tool. The delegate works in its own tmux window and
answers with one message, which the parent session shows as a result.

## Install

You need:

- Pi 1.3.0 or later, on macOS or Linux (not Windows). Pi 1.3.0 is the version
  pi-squire is tested with. It provides the per-run `before_agent_start`
  preparation for idle custom-message results, the structured system-prompt
  options the parent guidance uses, and the extension APIs the package relies
  on. Pi supplies the peer dependencies `@earendil-works/pi-coding-agent` and
  `typebox`.
- tmux 3.2 or later, with the Pi session running in a tmux pane. That is the
  first version with `new-session -e`. Windows are placed
  relative to the pane's session (see [Where delegate windows
  open](#where-delegate-windows-open)), so a client attached elsewhere does
  not matter.
- A provider of the four `message:*` hooks, including `message:reply`;
  [pi-session-mail](https://github.com/gvanderclay/pi-session-mail) **0.6.0 or
  later** supplies them. Without a provider there is no way to send the task or get an
  answer, so `/delegate` refuses rather than start a delegate that cannot
  report back.

Upgrade pi-session-mail and pi-squire together, then restart or reload both
parent and delegate sessions. Older mail providers are unsupported; there is
no version negotiation or legacy automatic-answer path. Install both from npm:

```bash
pi install npm:pi-session-mail
pi install npm:pi-squire
```

To follow the latest commit of pi-squire instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-squire
```

The package has no runtime dependencies and no build step.

## First use

The package ships no agents, so create one first. `<agent dir>` is Pi's agent
directory: `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when that is set. Save this
as `<agent dir>/agents/scout.md`, replacing `provider/model-id` with a model
your Pi can use:

```markdown
---
description: Looks things up and answers in one message
model: provider/model-id
thinking: medium
tools: read, grep, find, ls
---

You research one question at a time and answer concisely, citing the files
you read.
```

Every field is optional: without `model` and `thinking` the delegate runs on
your session's, and without `tools` it has your session's tools (see
[Agents](#agents)). The roster is read at call time, so no reload is needed. Delegation guidance
for the parent is optional: save Markdown as
`<agent dir>/squire/delegation_prompt.md`, and it is read before each run.
Then, from a Pi session running in tmux, hand it a task:

```text
/delegate scout --label first Which files define the command-line entry point?
```

A detached tmux window named `scout-first` opens in your working directory.
When the delegate finishes, its answer reaches the parent as one `[delegate]`
message that quotes the task (see [Results](#results)), and the delegate then
closes its own window ([auto-exit](#auto-exit)).

`/delegate` with no arguments opens a form instead: pick an agent, write the
task in the multi-line editor, give it an optional label (empty for the
default name), then a settings screen. Its first row, Start, launches; the rows
below it all begin at the agent's defaults: Model (a filterable list of the
models your Pi has credentials for), Thinking (only the levels the selected
model supports; a level the model does not support, whether from the agent's
default or after changing the model, moves to the nearest supported one and says so), Auto-exit, Working directory (your own, to change)
and Worktree (a new branch name, empty for none). A worktree and a changed
working directory exclude each other; the base, source and fallbacks stay
command-only. The form starts the delegate through the same path as the
command, in the background, with the same start message. The label and
directory are checked as `--label` and `--cwd` are, before anything is sent
or opened.

## How a delegation works

`/delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>]] [--auto-exit | --no-auto-exit] <task…>`
reads the agent from `<agent dir>/agents/<name>.md` (or a trusted project's
`.pi/agents/<name>.md`; see [Agents](#agents)), writes
the task to the delegate's inbox through `message:send`, emits
`session:launch` so other extensions can shape the launch, then opens a
detached window running the parent's own Pi in the parent's working directory,
or the directory `--cwd` selects or the new `--worktree` checkout creates (see [Working directory](#working-directory)),
with the parent's agent root. The agent's
prompt reaches the child as a path to a private file under the system
temporary folder, not as text on the command line.

- The window and the child's Pi session share one name: `<agent>-<label>`, or
  `<agent>-<first 8 characters of the id>` without a label, where `<agent>` is
  the agent's `display_name` when it has one. A label is at most
  32 letters, digits, `_` or `-`, starting with a letter or digit. A `-` joins
  it rather than `:`, since tmux reads `:` in a target as session and window.
- Labels need not be unique. The delegation id stays the handle for
  `delegation_status`, `delegation_close` and mail.
- The delegate id is fresh, so a delegate never reopens a live session. It is
  also the delegate's mailbox address: the task waits in its inbox and is
  delivered at session start, with no handshake.
- Starting a delegation adds nothing to the parent's context: the model sees
  neither the command nor the task.
- The model can start one itself with the `delegate` tool, which starts the
  delegation at once without opening a dialog, so several calls in one message
  each start their own. `delegation_status` and `delegation_close` let it check
  on a delegation and end one.
- When the delegate settles, its answer is taken over on `message:inbound` and
  shown to the parent as one result message that quotes the task. By default
  the delegate then closes its own window ([auto-exit](#auto-exit)). With
  auto-exit off the window stays open so you can read it or keep working in it.
- Delegations are recorded in the parent session without the task text. Each
  record keeps the directory the window opened in and the session-storage
  directory the delegate was given.
- The delegate always gets an explicit project-trust flag, `--approve` or
  `--no-approve`, so a permissive global `defaultProjectTrust` cannot trust a
  project the parent does not, and an unattended window never waits on a
  trust question. In the parent's own directory it is the parent's current
  trust (`ctx.isProjectTrusted()`); for a `--cwd` directory see
  [Project trust](#project-trust).
- The delegate always gets `--session-dir` with the parent's absolute
  session-storage directory, which outranks `PI_CODING_AGENT_SESSION_DIR`, the
  tmux server's environment and a project's `sessionDir` setting. The parent
  finds the delegate's session file there by its id, even after the parent
  resumes with another storage directory selected. A parent whose session
  directory is not an absolute path refuses to launch, before sending the
  task.
- Delegates restore their identity and task state at session start. Delegation
  tools are inactive unless the current agent opts in below `maxDepth`; launch
  and resume admission enforce that boundary even through commands (see
  [Nested delegation](#nested-delegation-unreleased)).
- Without a UI the command and the `delegate` tool still work, except a
  top-level launch whose project trust needs a question (a nested launch can
  ask its attended root; see
  [Project trust](#project-trust)). They need tmux
  and a provider of `message:*`, and refuse with a message when either is
  missing. In print mode (`pi -p`) Pi does not show the refusal notices, so
  the refusal is silent there.

## Nested delegation (unreleased)

This integration is not ready for production nested agents: descendant tree
controls and full milestone validation remain required slices. Use only isolated
development fixtures until the full nesting
milestone is integrated and tested.

The default `maxDepth` in `<agent dir>/squire/settings.json` is **1**: root
(depth 0) → delegate (depth 1), with no grandchildren. Set `maxDepth: 2` for
root → coordinator → worker. A readable value must be a positive safe integer;
an absent/unreadable settings file uses the safe depth-1 default for exposure.
Launch/resume refuses malformed, unreadable or non-object settings rather than
risk silently losing configured tree caps.

A coordinator's agent file opts in with
`allow_nested_delegation: [worker, reviewer]`, or `true` for any current roster
agent. Absent, false or an empty list grants no nesting. A list names exact
agent identities; duplicates are removed. Other values (including null, empty
scalars, quoted booleans, malformed lists and patterns) disable the agent with
a path-specific warning. Unknown or unavailable names warn and cannot launch;
known entries remain usable, and later roster changes apply normally.
Below the limit the grant adds `delegate`,
`delegation_status`, `delegation_close` and `delegation_resume` even with an
explicit `tools` list. Merely listing those
tools (including by pattern) does not opt in and produces
a roster warning. At the depth limit they are inactive and not passed onward.

Every launch/resume re-reads the direct parent's current grant before side
effects. A refusal names the permitted agents or depth/setting. Removing an
agent from the grant blocks future launches/resumes, not existing work.
Trusted project agents still shadow global definitions. Each launching session
keeps the existing throttled quota checks and shared reactive usage-limit marks.

A nested child's tools are worked out as at top level, from its own agent file:
its `tools` list, or, with no `tools` field, its direct parent's available
tools (active ones plus codemode/deferred operations), plus `delegateTools` and
the automatic nesting grant. They are not cut back to the parent's tools. The
`allow_nested_delegation` list is the boundary: a coordinator that must not
start a child with more tools lists only children whose agent files give fewer.

Each agent keeps its own permission policy; squire does not inherit or compare
effective policies. A granting agent with a `permission:` map (even `{}`) warns
when a listed child lacks one; `true` checks all applicable roster agents.
This is only a heuristic warning, not authorization or proof of lesser privilege.
Permission policy parsing/enforcement remains the permission provider’s job.
Tool-name restrictions and configuration permission rules are not filesystem
isolation: tools such as bash can write files or start processes. A tool list
bounds tool names, not arbitrary extension code or the implementation an
extension registers under an allowed name. Rules asking
before changes to agent/squire configuration cannot promise interception of
every indirect write by scripts or repository changes; exact shell handling
belongs to the permission provider.

A coordinator's task finishes child-first: no final task reply or auto-exit
while any direct-child task is unfinished. Idle runs and open windows are not
task completion; a finished `auto_exit: false` child does not hold the barrier.
Child results steer only their direct parent. The coordinator must receive
their outcomes in a model request and subsequently settle before reporting
upstream. A result arriving during final settlement therefore requires another
processing run, not just decrementing a count. Out-of-order work and rolling
fan-out are supported; raw grandchild results are not independently forwarded
to root.

Task takeover and per-run guidance use the same current agent grant/depth check
as tool exposure. Leaves keep the original final-message wording; only effective
coordinators receive child-first final-report instructions. Manual reopening and
grant changes use the current role, not the launch-time role.

Intermediate failures, including exhausted fallbacks, keep the coordinator open
while workers run. Child results can wake it again; its eventual final run
determines done/failed. A user stop holds its task through failed runs as before.
A confirmed vanished worker produces the existing closed-without-result
outcome, which the coordinator processes without treating it as successful work.
Unknown tmux state is not disappearance and does not release the barrier.

Identity (direct parent, root, depth, own agent and ordered agent-name chain)
and child-task facts survive manual reopening of the same Pi session with the
same agent directory, without launch environment variables. Reopening does not
adopt another parent's children. Closing/reloading/exiting a parent does not
terminate its workers. Descendant views and exact-session restoration are
available below, including explicit ancestor-scoped subtree close. Full integrated
real-model/permission-forwarding validation is still required before production use.

A nested launch/resume needing an unresolved trust decision asks the attended
root directly, outside model task mail (see [Project trust](#project-trust)).
Already-decided trust, inherited-directory trust and explicit approve/no-approve flags remain.

### Tree-wide launch budgets

All sessions beneath a root share these call-time settings in
`<agent dir>/squire/settings.json`:

| Setting | Meaning | Absent with maxDepth > 1 | Absent with maxDepth 1 |
| --- | --- | --- | --- |
| `maxConcurrentDelegates` | Unfinished delegations across the tree, including coordinators waiting for children | 16 | unlimited |
| `maxDelegatesPerRoot` | Launches over that root session's lifetime, including resumes | 64 | unlimited |

Both accept nonnegative safe integers; **0 means unlimited**. A changed setting
applies to subsequent admissions. Lowering it never kills existing work. At a
cap, launch/resume refuses with the current count and limit, before mail,
worktree creation or killing an exited resume window. There is no launch queue.
A finished task frees concurrency even if its `auto_exit: false` window stays
open. It never refunds its lifetime launch. A coordinator's intermediate settle
or a held user stop does not finish its task.

Shared structural facts and reservations live under
`<agent dir>/squire/trees/<encoded root session id>.json`. The registry indexes
ownership, ancestry, resume chains and launch locators; local child-task records
still own result delivery/processing. Publishing those saved parent facts is
best-effort: failure warns but does not suppress result/gone messages, steer,
close tracking or local outcome processing. Every admission reconciles durable
facts under the registry lock before checking caps, so missed publication does
not create spare capacity. True local child-task storage failures still block
completion and admission. Frozen worker replies publish terminal accounting
before transport, so a finished worker frees a slot even while its parent is
absent. A failed worker-terminal publication retains the outbox and blocks auto-exit;
retry/reopen preserves the existing answer. This accounting publication does
not claim that the parent received or processed the reply.

Admissions use a cross-process mutex on a **local filesystem**, not NFS, and
atomically reserve both budgets. Short lock contention can wait up to five
seconds, then refuses; cap exhaustion never waits for a slot. Lock contenders
have unique files; only a process proven absent permits cleanup, never a lease
expiry. A reused PID or unknown process state conservatively blocks cleanup.
Keep the same agent directory when reopening a session. Registry corruption
refuses admission instead of resetting the budget. Atomic replacement protects
ordinary process restarts; these records do not promise power-loss durability.

Confirmed pre-start failure refunds both reservations. After a tmux create may
have been dispatched, an error/timeout is **uncertain**, not a refund. A child
that starts publishes its own window locator to recover a lost tmux response.
Subsequent admissions reconcile durable parent/worker facts and observed windows,
even with the root/intermediate parent absent. Confirmed disappearance frees
concurrency but is not success; the direct parent still processes its own
missing-result notification or late reply. Unknown tmux state releases nothing.
If neither start nor no-start can be established, the reservation remains
charged; no timeout guesses it away or relaunches it. No parent-death watcher,
repair daemon, mailbox scraping or implicit ownership transfer is involved.

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

Fresh sessions do not adopt earlier trees. At startup a fresh root inspects only
this agent directory's newest **64** registry files, and only entries using its
current session-storage directory. It reports at most **10** direct owners with
positively matched live windows and explains reopening the owning session (or
returning to its existing owner). Registry-content reads are limited to 1 MiB
per tree and one **200 ms total cooperative notice budget**, including the tmux
wait, with registry lock waits capped at the remaining budget or 20 ms. The scan
yields between trees and reports unavailable tmux, unreadable owner records or
truncated scope once. Individual filesystem operations cannot be preempted.
Directory names/mtimes are enumerated, but no recursive
session search, mailbox search or other agent-directory search occurs. Exact-id
restoration is not restricted by this notice budget.

Both `delegation_status` and `/delegates` show descendants: a root sees its tree;
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
directory/source trust still apply to resume, including its picker. A live
same-id Squire owner and obsolete local/shared resume chains are refused.

## Where delegate windows open

By default a delegate's window opens in a shared **project companion session**
named `<project>-delegate-session` on your existing tmux server. The owning
root Pi session's project chooses it, not the parent tmux session or the
delegate's working directory. Launching into another repository or creating a
worktree there still uses the root's companion; resuming a delegate does too.

Nested launches inherit the original root project: A → coordinator in B →
worker in C all select A's companion. The preferred base name (for example,
`A-delegate-session`) is saved as `rootPlacement` in the existing durable
delegation identity and shared tree records, not recomputed from B/C or the
containing tmux session. Reopening the **same** coordinator session without its
launch environment restores that preference; it can launch or directly resume
its workers while the root is absent, provided target trust is already resolved.
Resume retains the original preference and still requires the direct parent.
The saved preference is not a numbered selected session or a tmux locator:
every open still applies the managed/unmarked selection rules below.

In Git, the project name is the **main checkout's folder name**. Roots in
repository subdirectories and linked worktrees therefore share the main
checkout's companion. Outside Git, use the root working directory's folder
name (a non-Git subdirectory has its own name). If Git inspection fails or
cannot locate the main checkout identity, the launch reports a notice and
uses the root working-directory basename instead.

Project names preserve ASCII letters (including case), digits, hyphens and
underscores. Runs of other characters become one hyphen, edge hyphens are
trimmed, and an empty name becomes `project`: `Client API` uses
`Client-API-delegate-session`.

Multiple roots share a companion even across parent tmux sessions. Distinct
paths with the same basename, separate clones named alike, and names that
normalize identically intentionally share it. This groups windows only:
delegation records, task mail, results, limits and close-all remain scoped to
each root.

pi-squire verifies the tmux session option `@squire-companion` before reusing
an occupied name. An unmarked session is left untouched; numbered alternatives
start at `<project>-delegate-session-2`, skipping unmarked alternatives too.
Later launches reuse an existing managed alternative even if a lower name
becomes free. Unexpected duplicate managed candidates use the first in numeric
order, without moving windows or repairing sessions. Existing legacy companions
and live windows are neither renamed nor migrated; only new launches and
resumes use project naming.

- The session is created on demand, by the launch that needs it, and tmux
  removes it with its last window, so it does not outlive its delegates.
- Closing delegates (including close-all) kills only that root's tracked
  windows. Manually killing the shared tmux companion session terminates
  **all** its windows, including other roots' delegates.
- `detach-on-destroy` is set to `off` (and the mark set) on that session only: if you are
  looking at it when its last delegate exits, tmux moves you to your most
  recent other session instead of detaching you. Your sessions and tmux's
  global options are never changed.
- The start message, the delegate card and the `delegate` and
  `delegation_resume` results show the session the window opened in, as the
  optional `windowSession`; they keep that name. `delegation_status` looks it
  up each time, so it follows a window you move to another session, which is
  still found, closed and resumed.

To open windows in your own session, as before, set `windowPlacement` in
`<agent dir>/squire/settings.json`, beside `worktreeRoot`:

```json
{ "windowPlacement": "current" }
```

The values are `companion` (the default when the setting is absent) and
`current`. The mode is read at each launch/resume independently of the saved
project preference. Even a `current` launch saves the original root project for
later companion launches; `current` itself still opens in the invoking pane's
session. Missing or malformed `rootPlacement` in a recorded identity, or conflicting
saved/launch identities, refuses restore/admission/resume. Identity-less records
also cannot be resumed after this update, including by their original root
(see [Resuming a delegation](#resuming-a-delegation)). There is
no identity migration, directory relocation/rename tracking or companion repair.
The file is read at each launch. Any other value refuses the launch
with an error naming the file, before the task is sent or a window opens.

<a id="direct-delegate-overview"></a>

## Delegate overview

In interactive Pi, Squire shows a compact **Delegates** tree above the editor.
It lists this session's running direct delegates first, then finished delegates
whose windows are still open, newest launch first within each group. A resumed
delegate keeps one row keyed by its stable Pi session id, not by its new
delegation id or mutable title. Failed and stopped results keep their actual
outcome labels; an open window or quiet session is not evidence of success.

Rows show the recorded delegate identity in bold, the current native Pi session
title when available, and task state. No title is repeated when it matches the
identity. The recorded launch model (or result model when available) and
transcript-file age appear when space permits: model is
dropped first, then file age, before identity/state are compressed. At very
narrow widths the state glyph remains beside the truncated identity.
`file … ago` is only a last-active hint from transcript mtime, not live tool
activity. When available, a second line shows factual live activity (below).
Each coordinator row summarizes **all descendant tasks**, at every depth,
including tasks whose windows have exited. Counts are per delegation/launch id,
not per stable session: a failed task and its resumed successor both count, so
a retry cannot erase a known failure. Actual replies supply done/failed/stopped;
saved gone/closed-without-result tasks count as missing. Shared registry
finished/closed/closing flags are not successful replies or proof another
parent processed an outcome. Missing parent facts or tree coverage are labeled
unknown/partial/unavailable, never all done. Summary and activity share one
secondary line; when both do not fit, the task summary wins.

Delegates also see their ancestors vertically, root to direct parent, with the
direct parent marked `(parent)` (including `root (parent)`). A connected
**Delegates** branch contains only the current session's direct children.
There is no current-session row or empty child heading; leaves show ancestors
only. Ancestor rows and secondary lines do not consume child-entry slots.

Configure it in the existing `<agent dir>/squire/settings.json`, alongside
`windowPlacement`, worktree and nesting preferences:

```json
{
  "delegateWidgetPlacement": "above",
  "delegateWidgetMaxEntries": 3
}
```

- `delegateWidgetPlacement`: `above` (default) or `below` the editor.
- `delegateWidgetMaxEntries`: nonnegative safe integer, default **3**. Each
  direct child consumes one slot. `+N more direct delegates` counts hidden
  eligible direct children, not descendants. **0** hides child rows and restores
  Squire's running-count footer while preserving ancestor rows/navigation;
  zero children never produce an empty heading.
- These preferences apply equally to roots and coordinators. Interactive views
  re-read them about once a second; invalid widget preferences warn once per
  distinct error and use the defaults without changing task state.

Launch/result/close changes refresh promptly; an independent one-second observer
keeps finished-open rows, window eligibility and later native title changes
fresh even when the result poll has stopped. Only visible rows resolve titles and
file metadata and live activity; overflow counts still include every eligible child. Closed/gone-only
history without a live reattached session does not keep the observer listing
windows. A positively reopened gone coordinator may appear at its current window
with its missing-outcome history intact; reopening does not make its task running. A failed tmux listing is unknown,
not proof that a window disappeared: running tasks remain eligible, but
finished rows require a positively open matching window.

Titles come from the latest complete native `session_info` in the delegate's
known session file, including external /resume-picker renames and explicit
clears. A small owner-only disposable title mirror under
`<agent dir>/squire/session-titles/` covers sessions with no persisted title
(including before the first transcript flush). Naming tools are optional;
`/name`, `--name` and Pi's native setter work. Persisted metadata takes priority
over that mirror: an external picker rename may differ temporarily from the
child's own in-memory name. Files are read incrementally, with bounded work per
refresh; very large existing transcripts may take several refreshes to catch up.

### Factual live activity

The secondary line follows actual Pi tool-execution events: `reading…`,
`editing…`, `writing…`, `command call…`, or `using <tool name>…`. Parallel
and nested calls are tracked by their actual call ids, not by tool name.
Active nested calls take precedence over their orchestrator. A tool start is
observed before permission interception: `command call…` means an outstanding
call, not proof that a subprocess started or permission was granted. Squire
does not inspect commands to guess intent, or display arguments, paths, tool
results, thinking or provider payloads.

Otherwise, while an assistant response streams, `response: …` shows a literal
single-line excerpt bounded to 512 UTF-8 bytes. It clears when that message
ends; a quick response may finish between refreshes and never appear. Calls
clear on matching end, run end/settlement, stop, reload and shutdown. Known
task results/close suppress activity even if a delegate's last snapshot remains.
A settled or silent coordinator can still own unfinished child tasks: activity
does not determine task completion, thinking or waiting for a human.

This best-effort feed uses bounded owner-only atomic snapshots under
`<agent dir>/squire/live-sessions/`, separate from title mirrors and durable
task/tree state. Each runtime owns a unique generation; dead/reused processes
are rejected and their own snapshots can be removed, while unknown or duplicate
live owners make activity unavailable. No inactivity timeout or stale-state UI
is introduced. The same private launch correlation distinguishes a resumed task
from its stable Pi session. Manual reopen without this correlation does not
supply task-row activity yet. Missing, corrupt or inaccessible telemetry never
blocks task launch, reply delivery or settlement, and causes no chat or model
calls. Publication requires positive Squire ownership at startup; later factual
end/settlement observation continues even if task-owner processing fails or its
record becomes unreadable, without re-enabling actions. Event publishing works
in non-TUI delegates and with the list hidden.
One child-entry slot may occupy two physical lines; there is no empty secondary
line or tool-use counter.

### Navigation

At an **empty built-in prompt**, press **Down** to select the direct parent in a
delegate session, or the first child at root. Up/Down traverse ancestors and
eligible children in display order; only children scroll within the configured cap;
hidden-above/below counts refer to direct children. Selection follows stable
session identity through renames, reordering and resumes. Enter opens that
child's details in the **same dashboard** as /delegates, scoped to that child's
branch (including descendant and resume history, not its siblings). Press **b**
for the branch list to select and inspect its workers. Initial details Escape
returns directly to the compact list; details opened from the branch list return
to that branch list first. Branch-list Escape returns to the compact list, then
Escape again returns to the prompt; Up past the first compact row also leaves
the list. A short hint appears only while the list owns these keys.
Typing or any unrelated key leaves list navigation and passes that key through.
While a widget-opened dashboard is loading or re-listing between actions, keys
are absorbed only if the exact empty built-in prompt still owns focus: Escape
cannot abort a run and action letters cannot leak into that prompt. Once a
real dashboard, dialog, completion menu or unknown component owns input, its
keys pass through normally.
Cap zero never creates invisible selectable children; ancestors remain selectable
and /delegates still works.

Enter on an ancestor switches directly to its verified **current live tmux
window**, not to the dashboard or a historical launch window. Root and leaf
processes publish their own positive pane/window observation in the same
disposable generation snapshot used for activity. The reader checks the elected
exact-session owner, process incarnation, tmux server socket/PID/start identity,
exact pane and window id **and** name. Current window placement is read from tmux;
cwd, companion names and rootPlacement are never used to guess a root window.
Own-pane observations refresh about once a second even while quiet or cap zero.
A rename/move before the owner refreshes fails closed; a later positive update
makes the new locator available. This navigates to the window, not a specific
pane's keyboard focus.

An exact-id manual reopen can supply a new locator without launch environment,
while old task history stays unchanged. It still cannot supply launch-correlated
task activity. Missing/unreadable/ambiguous metadata, a different server, a dead
pane or no attached client reports an unavailable target. Navigation never
adopts, recreates, kills or implicitly resumes an ancestor. New/forked session ids
do not inherit ancestor authority from copied history.

Squire owns only its widget key and its existing status entries. It does not
replace your footer or editor, and cleans up observers/input listeners on
shutdown or reload. Automatic navigation deliberately passes through custom
editors, autocomplete, dialogs, permission questions and unrelated dashboards.
It relies on **Pi TUI internals**, isolated in a small compatibility adapter:
the concrete focus getter and exact built-in editor identity. Compatibility was
tested with the installed **Pi 1.4.0 bundled CLI**, including regular/fullscreen
mode changes. Unknown focus/editor/completion capabilities disable key capture
rather than guessing; /delegates remains available. This is not a generic
custom-editor integration or a supported Pi focus hook. JSON/RPC hosts retain
the running-count status rather than receiving a terminal widget.

## Reaching delegates

Delegate windows sit out of your way, so reach them from the parent. `/delegates`
(or `alt+shift+d`) opens the same dashboard used by widget Enter, at the overall
view of its descendant hierarchy, including
closed/history rows. Parents precede their children; resume history stays
visible. Each row shows stable launch identity, the available current native Pi
title, agent display label, semantic state/outcome and verified window availability.
Enter opens selected details with identities, paths, result envelope, workspace
and resume information. Historical launch windows are labeled separately from
current verified windows. Lists and details scroll within the available screen.
Widget entry uses the same screen for only its selected branch; `b` exposes that
branch's list without widening its scope. A title change never changes routing.
Metadata is refreshed when opening/reopening the screen after an action; the
compact overview remains the live activity/summary view.
Only a verified live window supports switch/peek; the model has no
tool that moves the terminal. Any ancestor can explicitly close a selected
subtree. The root also has a confirmed close-all action; shared companion names
never grant control over another root.

| Key | Does |
|---|---|
| `↑` / `↓` | select a delegation in the list; scroll in details |
| `enter` | open selected details; from details, switch your tmux client to its verified window |
| `esc` | details → overall list → prompt; initial widget details → compact list; branch-list details → branch list → compact list |
| `b` | widget entry only: show the selected branch list, preserving its target and history |
| `p` | peek: a snapshot of the window's pane (`capture-pane`) in an overlay; `r` refreshes, `enter` switches, `esc` returns to the list |
| `x` | explicitly close the selected subtree as `delegation_close` does; confirms running work and verified live navigation rows |
| `a` | root only: confirm closing **all root** descendant subtrees, including absent coordinators, even when viewing one branch |
| `r` | resume the selected eligible direct child, collecting a follow-up through the existing resume flow; descendants without authority are refused |
| `n` | new child of the invoking session, not of the selected remote row: the same form `/delegate` opens with no arguments (see [First use](#first-use)) |

Switch acts on the most recently active tmux client attached to the parent's
session. With none attached it refuses with a notice; peek and close still
work. No tmux key bindings or options are added.

To come back, use your own tmux last-session key (tmux's default is `prefix L`,
often rebound); the notice after a switch says so.

`/delegate-open <id> [--switch|--peek]` does one of these on one delegation
without the panel: with no flag or with `--switch`, it switches; `--peek` opens
the peek overlay. Ids complete from the open delegations.

Dashboard switch/peek and `/delegate-open` share current-locator verification.
For the latest known launch of a stable session, a positively observed current
runtime supersedes its old launch window; a later lost/changed locator refuses
rather than falling back to an old still-open window. Exact Pi pane liveness
allows navigation even if a different active pane has exited, and peek captures
that verified Pi pane. Legacy tracked windows still require matching id and
name. Reattached process visibility does not rewrite historical gone/closed/
result facts, invent task activity, or grant resume authority. Current telemetry
is navigation evidence only: close still uses the existing shared control
runner's durable locators/fences and reports partial failures honestly. A live
reattached navigation window may remain open when it differs from the durable
control locator; confirmation warns about that distinction. Current-locator
supersession memory lasts only for this navigator runtime: after a restart,
before the first positive live observation, a legacy id+name-verified historical
window can still be offered.

## Working directory

`--cwd <dir>` (the `delegate` tool's `cwd`) runs the delegate in an existing
directory instead of the parent's: another checkout, a linked worktree, a
subdirectory or a directory outside Git.

- A relative path resolves against the parent's working directory. A leading
  `~` or `~/` means your home directory. Nothing else is expanded: no
  environment variables, globs or `~user`.
- The directory must exist and be readable. Its real path, with symlinks
  resolved, is where the window opens and what is recorded. A missing path,
  a file or a directory that cannot be entered is refused before the task is
  sent or a window opens; nothing is created.
- The directory is used as it is. Its branch, index, uncommitted and
  untracked files are not touched when the delegate starts, fails to start or
  is closed, and pi-squire never cleans it up.
- The delegate's Pi finds context files (`AGENTS.md`), project settings,
  skills and extensions from that directory and its ancestors, as Pi always
  does. Context files load even without project trust, so trust is not an
  instruction-safety boundary.
- The delegate's appended prompt names the selected directory. A delegate in
  the parent's own directory is not told its cwd again.
- The model may leave `cwd` out, or send `null`, `""`, `"null"`, `"none"`,
  `"false"` or `"undefined"`; each means the parent's directory. A boolean,
  number, array or object is refused. `/delegate --cwd` treats those same
  strings the same way.
- Write a value with spaces in double quotes:
  `/delegate scout --cwd "~/work/my repo" Read the README`. Inside the quotes
  `\"` is a quote and `\\` a backslash; there is no other escaping or shell
  expansion. The task after the flags is kept exactly as typed, quotes and
  backslashes included. A missing closing quote or a missing value is refused
  before anything starts.

Each new delegation records a `workspace`: its `mode` (`inherited` for the
parent's directory, `existing` for `--cwd`), its `cwd` and the Git checkout at
launch. `git` is one of:

- `{ kind: "git", identity: { mainRoot, commonDir, checkoutRoot }, position, head, baseline }`,
  where `position` is `{ branch, detached: false }` or
  `{ branch: null, detached: true }` and `baseline` is the commit checked out
  at launch (`null` in a repository with no commits yet);
- `{ kind: "non-git" }` when Git says the directory is not in a checkout;
- `{ kind: "unknown", reason }` when Git is missing, times out (5 seconds per
  question) or fails. That never blocks a launch and is not a claim that the
  directory is outside Git.

Git is asked read-only, without optional index locks. The start message
names the directory when it differs from the parent's; the tool's
structured result always carries `cwd` and `workspace`, and status, results
and their expanded views show them.

### Managed worktrees

`--worktree <branch>` (or the `worktree` tool input) creates a new local branch
and worktree from this session's checkout, or from the existing checkout named
by `--worktree-source <dir>` (tool input `worktree_source`). Relative sources
resolve from this session's cwd; `~`, symlinks, linked worktrees and repository
subdirectories are accepted. The delegate starts at the created root. Its base
is the selected checkout's committed `HEAD`, or `--worktree-base <commit-ish>`
(the tool input `worktree_base`). The base resolves only against locally available branches, remote-tracking refs, tags, commits or commit-ish expressions; Squire does not fetch. The exact commit is frozen before creation. An explicit commit works even if source `HEAD` is unborn; without an override an unborn `HEAD` is refused. The default
location is a sibling directory named `{repo}-worktrees/{branch}`, with `/` in
the folder segment replaced by `-`; the branch name itself is unchanged.
`worktree_source` and `worktree_base` require `worktree`; `cwd` and `worktree` cannot be combined. An unrelated source repository uses its own saved trust decision; when undecided, protected resources in the frozen base and applicable destination ancestor skills are reviewed in the parent before creation. Branches and destinations are never
reused, reset, suffixed or force-created. Git creation uses the frozen commit,
not a later moving `HEAD`.

Dirty staged, unstaged and untracked source paths are summarized in the start
notice and recorded; none are copied. Ignored files remain in the source and
are not transferred. No setup or submodule initialization is performed.
The delegate starts at the created worktree root with factual branch and base
context.

Managed placement is selected on every creation from the optional
`<agent dir>/squire/settings.json` file (separate from Pi's `settings.json`):

```json
{
  "worktreeRoot": "~/worktrees/{repo}/{branch}",
  "worktreeRootByRepo": {
    "/Users/me/src/special-project": "../special-checkouts/{branch}"
  }
}
```

A matching `worktreeRootByRepo` entry wins over `worktreeRoot`, which wins
over the built-in `{repoParent}/{repo}-worktrees/{branch}` default. Repository
keys identify the canonical main checkout root, even when creation starts from
a linked worktree; keys and relative templates resolve from the settings
directory, and `~`/`~/` expands to the home directory. Templates accept
`{repoParent}` (the main checkout's parent), `{repo}` (its directory name) and
`{branch}` (the branch with `/` replaced by `-` for this path only). For a
main checkout at `/Users/me/src/special-project` and branch `feature/topic`,
the built-in path is
`/Users/me/src/special-project-worktrees/feature-topic`. With `~` set to
`/Users/me`, the global example resolves to
`/Users/me/worktrees/special-project/feature-topic`; if the settings directory
is `/Users/me/.pi/agent/squire`, the matching relative override resolves to
`/Users/me/.pi/agent/special-checkouts/feature-topic`. The Git branch remains
`feature/topic`.

Worktree placement keys are read only for managed creation. A missing file
uses the built-in default; invalid templates and duplicate canonical repository
keys refuse creation rather than silently falling back. Those creation-key
errors do not affect inherited or `cwd` launches, but malformed, inaccessible
or non-object shared settings refuse every launch/resume because tree caps
cannot be read safely. Placement does
not choose a source checkout or base commit. Pi discovers `AGENTS.md`, skills
and other project context from the created directory and its ancestors, so the
chosen layout determines which instructions and skills apply. For a layout
inside another checkout, arrange any needed Git ignore rule yourself;
pi-squire never edits `.gitignore`.

A launch attempt is recorded before Git creation. If launch fails before a
window is known to have opened, pi-squire removes only a checkout and branch
it can prove it created and that remain pristine; it never uses force. Changed,
ignored, untracked or uncertain resources are retained and reported with
recovery facts. A timeout or other ambiguous tmux failure retains the worktree.
Once tmux returns a window id, the worktree and branch are kept through later
failure, completion and close; remove them manually when no longer needed.
Worktrees isolate checkouts, not delegate permissions or filesystem access.

### Checkout snapshots

A result records one snapshot of the delegation's checkout, taken when the
reply arrives, and `delegation_status` takes a fresh one on every call. The
result's snapshot is history: a later status never changes it. Both are a
`workspaceSnapshot`, one of:

- `{ kind: "git", position, head, baseline, ahead, workingState, committed, pending }`:
  the current branch or detached HEAD, the head commit, the launch commit
  (`baseline`), how many commits are reachable from head but not from the
  baseline, `clean` or `dirty`, the paths changed between baseline and head
  (`committed`), and the `pending` paths, split into `staged`, `unstaged`,
  `untracked` and `conflicted`. A clean working tree can still have commits
  and committed paths since launch;
- `{ kind: "non-git" }` for a directory launched outside Git that still exists;
- `{ kind: "unknown", reason }` when the directory is gone, its checkout root
  or Git common directory is no longer at the location recorded at launch, its
  launch commit is missing, Git is missing,
  fails or passes a limit, its Git state at launch was unknown, or the record
  predates workspaces. Only the recorded checkout is inspected, never the
  parent's.

Each path list is `{ paths, total, truncated }`: at most 100 whole paths and
16 KiB of names per list, with `total` counting all of them. Paths come from
NUL-separated Git output and are shown JSON-quoted, so spaces and newlines in
a name stay data; a rename lists both its old and new path. An inspection
gives each Git command 2 seconds, the whole checkout 5 seconds and 4 MiB of
output; a command still running at its limit is killed. Past any of those
limits the snapshot is unknown, never a partial count, and stdout and stderr
count together toward the 4 MiB. Committed paths are relative to the
repository root whatever `diff.relative` says. Git runs read-only, without
optional index writes.

A snapshot observes the Git state at the recorded location, not that it is the
same repository on disk: a repository replaced there, for example by a fresh
clone, that still has the launch commit is reported normally against that
commit. It is not proof that the delegate made those changes, that the task
succeeded, or that the branch is safe to merge.
It does not say whether the branch is merged anywhere, prints no cleanup
command, and nothing acts on it.

### Project trust

The requesting parent resolves the delegate's trust flag before task mail,
worktree creation or a window opens. Unresolved choices go to the root user,
not to an intervening model or an unattended delegate UI. A same-repository
managed worktree uses the requester's current trust for that repository.
The model has no trust input; every launch/resume still passes explicit
`--approve` or `--no-approve`.

1. A directory in the parent's own repository, by Git's common directory, so
   including its linked worktrees, gets the parent's current trust, even a
   decision the user made for this session only. It never carries to another
   repository or to a directory outside Git.
2. Otherwise a saved decision in Pi's trust store applies, found the way Pi
   finds it (the closest saved directory at or above the key). The key is the
   main repository root for a linked worktree of another repository, and the
   directory itself for everything else, including a subdirectory of another
   main checkout or a main checkout whose Git directory lives elsewhere
   (`--separate-git-dir`), so a nearer saved denial there still wins. A
   linked worktree whose main checkout Git cannot name, such as one of a bare
   repository, has an unknown Git state and is keyed by its own directory.
3. With no saved decision and no project resources that Pi gates behind trust
   (`.pi/settings.json`, extensions, skills and the like, or an
   `.agents/skills` directory above it), the delegate starts with
   `--no-approve` and no question.
4. Otherwise the root asks, naming the requesting agent chain, requester
   session id, directory, the main repository when it is the key, and what each
   answer saves:
   `Trust`, `Trust parent folder (<folder>)` (left out at the filesystem
   root), `Trust (this session only)`, `Do not trust` and
   `Do not trust (this session only)`. The two "this session only" answers
   apply to this launch alone and save nothing. "Trust parent folder" saves
   the folder and clears a decision saved for the key itself. Cancelling
   starts nothing. One question is open at a time; a question that waited
   reads the store again, so an answer just saved is not asked twice. Aborting
   the turn or tool call stops a launch that is waiting for or answering a
   question; nothing is saved, sent or opened.

An unresolved nested question requires the same root Pi session to be running
with dialog-capable UI (TUI or RPC), without `PI_UNATTENDED=1`. An absent or
unavailable root refuses immediately; a disconnected root fails its pending
launches, rather than waiting for the root to return. Already-resolved trust
and resource-free targets need no root connection. A root's own trust in a
different repository never supplies approval. For a top-level launch without UI,
open Pi in the trust key directory named by the refusal (the source/main checkout
for a managed worktree), answer its trust question, then delegate again.

Root questions, local and remote together, are serialized, even while the
root model is busy. Each request has a **10-minute deadline including queue
wait**. Escape, tool/turn cancellation, requester or root shutdown/reload/session
replacement, disconnection and expiry cancel that launch and dismiss its
question; canceled queued requests are skipped. An unrelated root model run's
abort does not cancel a remote request. Late decisions cannot save trust or
start the canceled work. A new launch after reopening makes a new request;
pending requests and decisions are never replayed.

Squire uses an authenticated **127.0.0.1 loopback connection**, not mail or
`session_mail_ask`, for this control. The root writes its random port and
per-runtime token to the owner-only
`<agent dir>/squire/trust/<SHA-256 of root id>.json` descriptor. Only squire
reads it; no provider files, APIs or tool grants are needed. Unreachable
endpoints fail at once (connection establishment is bounded to one second).
A fresh client-nonce/HMAC handshake verifies the root before sending any
question or secret, so a reused stale port cannot impersonate it. Root restart
changes the token, invalidating old frames.
The descriptor is transient and removed on ordinary shutdown; a crash can
leave a harmless stale descriptor that cannot approve anything. Like the rest
of squire, this is not an OS boundary against processes running as you.

Only the live **requester** saves a persistent choice in that agent directory's
Pi `trust.json`, after cancellation/deadline checks and before launch.
The root holds the queue until the requester has applied the answer or
disconnected, so queued requests re-read saved decisions. The two session-only
choices save nothing and apply only to that launch. `Do not trust` launches
untrusted; Escape cancels instead. A trust store that cannot be read or written
refuses the launch; nothing is granted by default.

Model questions still use `session_mail_ask` to the direct parent, parent by
parent. Permission prompts remain with the permission provider, with each
child's own agent policy: there is **no permission inheritance**. Its bridge
can label a requester with `PI_DELEGATE_CHAIN` (comma-separated roster names,
root downward including the current delegate); `session:launch.chain` is the
corresponding frozen string array. Routing uses separate parent/root session
ids, not chain names. Squire does not implement that permission bridge.

## Agents

An agent is one Markdown file, `<name>.md`, in the agents folders Pi agent
tooling shares; the file name without `.md` is the agent's name (letters,
digits, `_` or `-`). The roster is read at call time, so a new or edited file
is usable without a reload.

- `<agent dir>/agents/<name>.md` holds the global agents.
- `<cwd>/.pi/agents/<name>.md` holds a project's agents, read only when Pi
  reports the parent's project as trusted. A project file replaces the global
  file of the same name. In an untrusted project only the global agents load,
  so a cloned repository cannot change a delegate's prompt, model or tools.

The body is the delegate's instructions, appended to Pi's own prompt; it
reaches the child as a path to a private file under the system temporary
folder, so the text stays off the command line. Every frontmatter field is
optional, and the [first-use example](#first-use) is a complete agent file:

| Field | Meaning |
| --- | --- |
| `description` | Shown in the roster and the `delegate` tool's description. Defaults to the name. |
| `display_name` | Shown instead of the name on the delegate card, in `/delegates` and in the window title (`<display_name>-<label>`). The agent is still called by its name. It may hold only ASCII letters, digits, `-` and `_`; any other value (a space, `#`, `.`, a non-ASCII letter, or an empty value) makes the file invalid, so the agent is disabled. |
| `model` | One model: `provider/id` or an alias such as `sonnet`, passed to the child's `--model` unchanged, so Pi resolves it to one model. A `*` pattern makes the file invalid. Absent means the parent session's current model. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Absent means the parent session's level; an unknown value is dropped with a warning and the parent's level applies. Pi clamps the level to the model. |
| `tools` | The delegate's tools (see below): tool names and `$bundle` entries for exactly those, or only `-name` entries for the parent session's current tools less those. Absent means the parent session's current tools; empty (`tools:` or `tools: []`) means no tools except the `delegateTools` setting. MCP tools follow the selection like any other. |
| `fallback` | Models to try, in order, when `model` is usage-limited (see [Usage limits](#usage-limits)). Each entry is one model, like `model`; a `*` pattern, or a YAML list entry holding a comma, makes the file invalid. A comma-separated line (`fallback: a, b`) is two entries. |
| `auto_exit` | `true` or `false`, default `true`; see [Auto-exit](#auto-exit). |
| `allow_nested_delegation` | Unreleased: `true` or a YAML list of exact child agent names; grants nested delegation below `maxDepth` (see [Nested delegation](#nested-delegation-unreleased)). Absent, false or an empty list grants none. Malformed values disable the agent; unavailable names warn. |
| `prompt_mode` | `append` (the default) wraps the body in `<agent_instructions>` and `</agent_instructions>` lines; `replace` adds the body unwrapped. An empty body adds nothing either way. |
| `enabled` | `false` leaves the agent out. A project file with `enabled: false` hides a global agent of the same name in that project. |
| `locked` | `true`, or a list of `model` and `thinking`. A call to `delegate`, `/delegate` or a resume that passes a locked field does not get it: the agent's value is used (the parent's when the file sets none) and the result says which agent locked which field. Passing the agent's own value is the same as passing nothing: no notice, and its fallbacks still apply. A resume of a locked field runs on the file's value as it is now, not on what the delegate last ran on. `true` locks the fields the file sets. |

Any other key, such as `max_turns`, `inherit_context` or `run_in_background`,
is ignored without a warning and left for whatever else reads the file.
Squire observes only whether `permission:` is a map for the nested-grant warning
above; it leaves interpretation and enforcement to the permission provider.

**Breaking frontmatter change:** use `auto_exit` instead of `auto-exit`.
The old `auto-exit` and `extensions` fields are silently ignored, including
malformed values and missing extension paths. In particular, an old
`auto-exit: false` no longer keeps the delegate open: without `auto_exit: false`
or a call override, auto-exit defaults to on. Agent-specific extension loading
has been removed from both launch and resume. Normal Pi extension discovery
and [`session:launch`](#sessionlaunch) customization remain available.
The `--auto-exit` / `--no-auto-exit` flags, `/auto-exit` command and
`PI_DELEGATE_AUTO_EXIT` environment variable are unchanged.

`exclude-tools` is no longer read; a file that still has it gets a warning
(use `tools` instead).

`tools` lists the delegate's tools as a comma-separated or YAML list
(`tools: read, grep` or `tools: [read, grep]`). Each entry of a YAML list
names one tool: an entry holding a comma, such as `tools: ["read,-bash"]`,
makes the file invalid. pi-squire works out the delegate's whole selection
itself and always passes the child a plain list, `--tools read,grep`, which Pi
treats as the whole selection, extension tools included; entries may be `*`
patterns. It never passes Pi `+name` or `-name` entries. MCP tools follow the
list like any other tool: an MCP tool (`mcp__<server>__<tool>`, or one of the
MCP resource tools) that no entry names or matches is not registered in the
delegate at all, so it is neither declared nor callable from `codemode` nor
loadable by `tool_search`, whatever its exposure. Pi filters MCP tools by
`--tools` only once an entry starts with `mcp__`, so when the list has no
such entry pi-squire adds the entry `mcp__`, which names no tool; an empty
selection is `--no-tools`, which removes MCP tools too. To give a delegate an
MCP server's tools, name them, for example `mcp__docs__*`. An extension that
turns tools on at run time can still add only tools the list allows. Tool names
are not checked against the parent's tools, at top level or nested: normal Pi
extension discovery or `session:launch` customization can provide tools in the
child.

- No `tools` field: the delegate gets the parent session's tools as they are
  when the launch (or resume) starts: active tools for a top-level launch, or
  available tools including codemode/deferred operations for a nested one, passed as
  `--tools`, plus the `delegateTools` entries. A parent limited to `read`
  gives such a delegate only `read`.
- An empty `tools` field, `tools:` or `tools: []`: the delegate gets no tools
  except the `delegateTools` entries. With none of those either, it starts
  with `--no-tools`.
- A `tools` list of tool names: exactly those tools, plus the
  `delegateTools` entries. A `$name` entry stands for the tools of that
  bundle in the `toolBundles` setting (see below).
- A `tools` list of only `-name` entries (`tools: -bash, -write`): the
  parent's tools, as with no `tools` field, less those, plus the
  `delegateTools` entries. A `-name` entry may be a `*` pattern
  (`-mcp__docs__*`).
- A `+name` entry, a `-$name` entry, a `$name` entry naming no bundle, or
  tool names and `-name` entries in one list, make the file invalid, and the
  agent is disabled (see below).

`toolBundles` in `<agent dir>/squire/settings.json` names tool lists that
several agents share:

```json
{ "toolBundles": { "readonly": ["read", "grep", "find", "ls"] } }
```

An agent then writes `tools: [$readonly, pstack_models]`, which reads as
`read, grep, find, ls, pstack_models`; a name listed twice counts once. A
bundle name is letters, digits, `_` or `-`; each entry is one tool name or
`*` pattern, with no comma and no leading `+`, `-` or `$`, so bundles do not
nest. A bundle carries tools only, not permission rules. The setting is read
with the roster. A setting that is not an object of such lists disables every
agent that uses a bundle, with the reason; agents without bundles are
unaffected. (`$`, unlike `@`, may start a plain YAML value.)

The delegation tools (`delegate`, `delegation_status`, `delegation_close`,
`delegation_resume`) are removed from ordinary tool selections. An opted-in
coordinator below `maxDepth` receives them automatically; a leaf has them
inactive. Commands are still registered but cannot bypass admission. See the
unreleased [nesting restrictions](#nested-delegation-unreleased).

The delegate's result reaches the parent through the `message:*` provider's
reply hook when squire settles the task, not through a tool, so a short `tools` list cannot
stop it answering. To let a delegate message its parent mid-task, whatever its
`tools`, list the tools your `message:*` provider gives a session for that in
the `delegateTools` setting, in `<agent dir>/squire/settings.json` beside
`windowPlacement` and `worktreeRoot`:

```json
{ "delegateTools": ["<tool or pattern>"] }
```

Each entry, a tool name or `*` pattern, is added to every delegate's tools,
whether they come from its agent's `tools` or from the parent (after any
`-name` entries are taken off), and passed to `--tools` unchanged. The setting
is empty by default, is read at each launch and resume, and a value that is
not a list of names, or an entry that holds a comma or starts with `+` or
`-`, refuses every launch with an error naming the file, before the task is sent or a window
opens; it does not disable agents one by one.

A `model` or `fallback` entry that is an exact `provider/id` in Pi's registry
is checked as before: a model without credentials or with an active
usage-limit mark is skipped for the next candidate. Anything else, such as an
alias, goes to the child's `--model` unchanged, and Pi resolves it to one
model; if Pi cannot, the child's Pi reports the error and its window closes
without a result. When a running delegate moves to a fallback after a usage
limit, it resolves each entry the way Pi resolves `--model`: an exact
`provider/id`, or a bare id or alias such as `sonnet`, to one model, in the
order the entries are listed. No entry may be a `*` pattern: a `model` or
`fallback` entry with `*` makes the file invalid, and the agent is disabled.

The body is followed by one fixed final-message line and a paragraph naming the
parent session's address. The delegate's task arrives as a message from that
session, and that message and every later one from the same address are
instructions to follow as given. Other sessions are colleagues: the delegate
may answer them, but checks with the parent before doing work the parent did
not ask for. The paragraph names no provider, package or tool, so it holds
whatever `message:*` provider delivers the task. `prompt_mode: replace` builds
the prompt exactly as every delegate was built before `prompt_mode` existed.

An agent file that cannot be used is invalid, and its agent is disabled:
frontmatter that is not readable YAML or not a set of fields, an `enabled` or
`auto_exit` that is not `true` or `false`, a `tools` value that is not a list,
a `tools` list with a `+name` entry or with tool names and `-name`
entries mixed, a `tools` or `fallback` YAML list entry holding a comma, or a
`model` or `fallback` entry with a `*` pattern. A disabled agent is left
out of the roster and of the `delegate` tool's description, so the model never
picks it, and a warning names the file and the reason when the session starts
(and before a run, when a file turns invalid while the session runs). A call
or resume that names it anyway is refused with that reason. A
field that cannot be used (a `fallback` that is not a list, an unknown
`thinking`, `prompt_mode` or `locked` entry) is dropped with a warning and the
agent still loads. While the retired `<agent dir>/squire/agents/` folder
exists, a warning says to move each `<name>/AGENT.md` to
`<agent dir>/agents/<name>.md`. With no agents at all, `/delegate` says how to
add one.

## Configuration

`<agent dir>/squire/` holds the optional parent guidance file and
`settings.json` (`maxDepth`, `maxConcurrentDelegates`, `maxDelegatesPerRoot`,
`windowPlacement`, `worktreeRoot`, `delegateTools`, `toolBundles`,
`delegateWidgetPlacement` and `delegateWidgetMaxEntries`); the
agents live in `<agent dir>/agents/` (see [Agents](#agents)).
`delegation_prompt.md` is Markdown, inserted unchanged as the
`squire_parent_delegation` system-prompt section before each new run, including
a run started by an idle delegate result. It is not a conversation or user
message, is not duplicated in the `delegate` tool description or guidelines,
and is not copied into the launched child's prompt. An opted-in coordinator
reads this same file for its own parent role. The guidance is added only while the `delegate`
tool is active and not hidden; when delegation is inactive or hidden, the
section is removed and tool selection is left as it was. A missing or whitespace-only
file adds no section. Editing the file replaces the section at the next run;
deleting it removes the section. A read failure other than a missing file
warns with the path, removes stale guidance for that run, and leaves otherwise
valid delegation working. The package ships no default delegation or approval
policy.

Refresh happens before a new run, not before every model request in a tool
loop, and the extension does not watch the filesystem. `pi-squire` uses launch variables to bootstrap a delegate; durable session
identity takes precedence when it reopens. The window starts with the tmux
server's environment plus `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`
(when set; `--session-dir` outranks it), and these delegate values:

- `PI_DELEGATE_PARENT`: direct parent's session id;
- `PI_DELEGATE_ROOT`: root session id;
- `PI_DELEGATE_DEPTH`: child depth as a decimal string;
- `PI_DELEGATE_AGENT`: this child's roster identity (not display name);
- `PI_DELEGATE_CHAIN`: comma-separated agent names, root downward, including
  the child last, e.g. `coordinator,worker`; names label requests, session ids route them;
- `PI_DELEGATE_AUTO_EXIT`: `1` or `0`;
- `PI_DELEGATE_FALLBACK`: remaining model candidates, when any.

It always gets `PI_UNATTENDED=1`.
`PI_UNATTENDED=1` is a general signal, not specific to pi-squire: no human is
watching this session, even though it runs in a TUI. Other extensions may read
it to skip a dialog or confirmation instead of waiting on one, and any other
runner that starts Pi unattended can set it too. Anything else the
parent process has, such as a `CLAUDE_CONFIG_DIR` set by a shell alias,
reaches the child only through a `session:launch` contributor. `--model` and
`--thinking` override the agent's defaults for one call, unless the agent
locks them (see [Agents](#agents)), and an unknown value
is refused with close matches, and so is a model with no configured
credentials. An API key that exists only as an environment variable in the
parent's shell does not reach the delegate, so log in through Pi or make the
variable part of the tmux server's environment. `--auto-exit` and `--no-auto-exit` override the
agent's `auto_exit`.

## Tools

The model gets four tools. They share the command's launch path and the
session's delegation records. In a delegate they are active only for an
opted-in coordinator below `maxDepth`; admission also checks every launch/resume.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `delegate` | `agent`, `task`, optional `model`, `thinking`, `label`, `cwd` and `auto_exit` (boolean) | Validates the call the way the command does, starts the delegation without opening a dialog (except an unresolved [trust question](#project-trust) for `cwd`), and returns the delegation id at once without waiting for a result. |
| `delegation_status` | optional `id` | Reports each delegation as running, done, closed or closed without a result, with the window, the delegate's session and the result envelope's path. |
| `delegation_close` | `id` | Explicitly fences and closes a descendant subtree using current verified windows. Returns per-member outcomes and complete/partial status; retains worktrees and branches. |
| `delegation_resume` | `id`, `task`, optional `model`, `thinking` and `auto_exit` | Reopens an exited delegate's own session in a new window with a follow-up task, and returns the new delegation's id at once (see [Resuming a delegation](#resuming-a-delegation)). |

The `delegate` tool's description lists the current roster, one line per agent:
its name and any display name, description, default model (or this session's)
and fallbacks, thinking, auto-exit when it is off, its tools (`no tools` for
an empty `tools` field, `this session's except …` for `-name` entries) and the
fields it locks.

```text
- scout "Recon" — Read-only recon (default provider/model-id, thinking low, auto-exit off, tools: read/grep, locked: model)
```

The model picks an agent from these lines without reading files. The
description also tells the model to turn `auto_exit` off when it means to keep
talking to the delegate by mail after its result. It says a task must stand
alone, that results arrive automatically, and that the parent should keep
working or end its turn rather than poll or send a blocking mail request
merely to wait; a substantive follow-up remains fine. The description is
rebuilt at session start and before each new run when the exposed roster
changes, so an edit, addition or removal shows up in the run being prepared,
including a run woken by an idle delegate result. Unchanged metadata is not
re-registered. The description built while extensions load lists only the
global agents, since the project's trust is known only once the session
starts. The roster itself is still read at call time, and an
unknown agent, model or thinking level is refused with close matches and
nothing starts.

`delegation_status` reports one state per delegation:

```text
2 delegations:

<id> scout (provider/model, thinking low)
  name: scout-<first 8 of the id>
  state: running — the window is open and no result has arrived (last active 12 min ago)
  window: scout-<first 8 of the id> (@1)
  cwd: <the directory its window opened in>
  workspace: existing directory; Git checkout <main root> (linked worktree <checkout>), branch <name>, launch commit <sha>
  checkout now: branch <name>, head <sha>, launch commit <sha>, 1 commit since launch, working tree dirty
    committed since launch: 1 path: "src/a.ts"
    staged: none
    unstaged: 1 path: "README.md"
    untracked: none
    conflicted: none
  auto-exit: on — the delegate closes its window after a normal completion unless the user took over there
  session: <the delegate's session file, or its id when there is none yet>

<id> researcher (provider/other, thinking high)
  name: researcher-<first 8 of the id>
  state: done — result status: done; the result reaches this session as a [delegate] message on its own
  window: researcher-<first 8 of the id> (@2)
  cwd: unknown (not recorded)
  checkout now: Git state unknown (this delegation was recorded before its launch checkout was kept)
  auto-exit: off — the window stays open after the result
  session: <session file>
  envelope: <the reply's path in the parent's cur/>
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
  launch (see [Working directory](#working-directory)); older records have
  none.
- **Checkout now** is a fresh [snapshot](#checkout-snapshots) of that
  checkout, taken by this call; the details carry it as `workspaceSnapshot`.
  A failure is unknown for that delegation alone.
- **Session** is the delegate's session file, searched for in the storage
  directory recorded at launch. Once found, its path is kept, so a later
  status or result uses it without searching again. Before the delegate has
  written its file, the id is shown instead of an invented file name.
- **Closed** covers a close `delegation_close` recorded and a window that is no
  longer there. A recorded close wins over a result, and a result wins over a
  window that is gone.
- **Closed without a result** is what the poll records when a window is gone
  and no reply arrived (see [Results](#results)). A result outranks it, so a
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
[Usage limits](#usage-limits)).

## Explicit subtree close

`delegation_close` and the `/delegates` close actions enumerate persistent
records and close the selected session and all its descendants, including work
whose coordinator is offline. Any ancestor may close; unrelated trees, siblings
outside the selected subtree and user windows remain untouched. Only the root
has the panel's `a` close-all action. Close-all fences new root admissions too;
neither action kills a companion tmux session wholesale.

Admission is fenced under the shared tree lock **before** window effects.
Already-reserved pre-dispatch launches cannot dispatch; an already-dispatched
create stays charged and fenced until its outcome/current locator is known.
The explicit call makes at most three passes, with two 25 ms waits for late
locator publication, and otherwise returns partial. It never infers no-start
from a timeout, dead opener, finished accounting or an empty tmux listing.
There is no automatic close-repair daemon. Retry the explicit operation after
positive create/window evidence becomes available; unknown launches are not
refunded or relaunched speculatively.

Only a window matching the **current recorded id and name** is killed, even
if its program has exited or its tmux session moved. A same-id manually reopened
coordinator can have a newer shared locator than its parent's launch history;
close uses that locator. An already absent verified window records a close.
Individual tmux or persistence errors do not erase successful members. A failed
initial registry read/fence refuses before any kill; a post-kill publication
failure reports the side effect and uncertainty, not successful completion.

The tool's `details` and `structuredContent` match its output schema:
`{id, windowId?, windowName?, closed, complete, alreadyClosed, killed, members,
error?}`. Each member has `{id, sessionId, windowId?, windowName?, outcome,
closed, killed, error?}`; outcome is `killed`, `absent`, `already-closed`,
`not-started`, `pending` or `error`. Aggregate `closed/complete` is true only
when every captured member is resolved; partial returns `isError:true` while
retaining structured details. Repeat close visits unresolved descendants even
if the selected coordinator alone was already closed. Unknown/out-of-scope
ids and obsolete resumed records refuse without window effects.

Confirmed shared closes are control/accounting facts, not fabricated worker
results. The sole direct-parent owner imports them into its own durable
child-task inbox as canceled/missing work, then processes them in a model run
before finishing upstream. An offline coordinator does this on same-id reopen;
the ancestor never writes its semantic state or emits raw grandchild reports.
A stopped root retains its previous replay hold on reopen. Fresh live close
outcomes wake normally, like other new outcomes. Real replies arriving before,
during or after close are retained and correlated normally, not replaced by a
success or cancellation envelope.

Once the explicit operation is complete, a legitimate direct-parent resume can
supersede that session's completed fence as a **new lifetime-counted delegation**.
It still passes current authority/owner, chain, depth, grants, caps and trust
checks. Failed pre-dispatch resumes leave the old fence effective.
Closed descendants remain canceled; resuming a coordinator does not revive them.
An unresolved active close cannot be bypassed by resume.

Quit, crash, reload, session switch and auto-exit do **not** cascade. Close never
removes worktrees, branches, session files or result envelopes. Existing narrow
rollback of pristine resources on a known failed launch is unchanged.

## Usage limits

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

- While it is on, a run that settles as a normal completion shuts the delegate
  down (`ctx.shutdown()`) on the next event-loop turn, after the settle
  reply has been sent, so its tmux window closes. The session file stays, and
  `pi --session <path>` reopens it (see [Reopening a delegate's session](#reopening-a-delegates-session)).
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

There is no `subagent_done` tool: auto-exit off only means the window stays.

## Results

A delegate answers its task with one reply through the `message:*` provider.
`pi-squire` takes that reply over before the provider can inject it, and sends
the parent one message labelled delegate output:

```
[delegate] Result from scout (provider/model), delegation <id>, request <request id>.
Status: done
Task, quoted from <sent/ copy>:
> the task
Working directory: <the directory its window opened in>
Workspace: <how the directory was chosen and its Git checkout at launch>
Checkout when the result arrived: <branch, head, launch commit, commits since launch, clean or dirty>
  committed since launch: <paths>
  staged: <paths>
  unstaged: <paths>
  untracked: <paths>
  conflicted: <paths>
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
- The task is quoted from the request copy the provider puts on the payload,
  capped at 2 KiB with the copy's `sent/` path. A request with no copy is
  named by id alone.
- The working directory is the one recorded at launch, or
  `unknown (not recorded)` for a delegation recorded before it was kept. The
  `Workspace:` line repeats the recorded [workspace](#working-directory), and
  is left out for records from before it was kept; the closed-without-a-result
  message carries the same two lines.
- `Checkout when the result arrived:` is the [snapshot](#checkout-snapshots)
  taken as the reply was claimed, also recorded with the result and in the
  message details and expanded view. The reply is claimed first, so a slow or
  failing Git cannot lose or duplicate it; the snapshot is then unknown. A
  non-Git directory reads `not a Git checkout`.
- The envelope path is the claimed reply in the parent's `cur/`; the
  delegate's session path is found by the delegation id in the session
  directory recorded at launch (the parent's current one for older records),
  and the id alone is shown when no file exists yet.
- The body is cut at 32 KiB with the envelope path.
- The message is sent as a `steer` with `triggerTurn`: a result starts a
  turn when the parent is idle, and when it is mid-turn arrives after the
  current tool calls, before the next model call. A follow-up would wait
  until the parent had answered, by which time it had often read the
  envelope itself, and the late result cost a second, redundant turn.
- The [direct-delegate overview](#direct-delegate-overview) replaces Squire’s
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

An exited delegate can continue its own session with a follow-up task:

```text
/delegate-resume <id> [--model <provider/id>] [--thinking <level>] [--auto-exit | --no-auto-exit] <task…>
```

The model does the same with `delegation_resume` (`id` and `task`, optionally
`model`, `thinking` and `auto_exit`), which returns the `delegate` tool's result
plus `resumedFrom`. The command completes the ids that can still be resumed.

`/delegate-resume` with no arguments opens a picker instead: the delegations
that pass every check below (newest first, from one look at tmux), then the
multi-line editor for the follow-up. The checks change nothing: it refuses as the
command does when tmux is older than 3.2 or `windowPlacement` is invalid, and leaves out a
delegation whose recorded thinking level is invalid or whose model and fallbacks cannot be used
(credentials, usage limits). An exited window is left for the resume to close, and trust is
asked only when you resume. The model, thinking level and auto-exit are the delegation's own,
and it resumes as the command does.

- The delegate's own session file is reopened with `pi --session <absolute path>`
  and the recorded `--session-dir`, in a new window named like the first. The
  delegate keeps everything it read and decided; Pi appends to the same file.
  Opening it yourself is `pi --session <path>`, outside this tool.
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
  for `cwd` (see [Project trust](#project-trust)); there is no `cwd` or
  `worktree` for a resume, and no worktree is created.
- Without `model` it continues on the model the delegate finished on, moving to
  its agent's fallbacks when that one is unavailable or marked (see
  [Usage limits](#usage-limits)). An explicit `model` is used alone and refused
  rather than substituted. Without `thinking` it continues on the level the
  delegate last ran on: the last thinking-level change on its session's
  active branch (Pi records one at start, one per change, and one when a
  model change clamps the level), or the delegation's recorded level when
  the session has none. `auto_exit` defaults to the delegation's own. A
  field the agent locks is the exception: it runs on the
  agent file's current `model` (then its fallbacks, even when the delegate had
  moved to a fallback) or `thinking`, a value passed for it is not used, with
  a notice, and passing the file's own value is the same as passing nothing. The agent's prompt and tools are those of the
  roster now, and an agent without a `tools` field gets the parent's tools as
  they are at the resume.
- `session:launch` is emitted as for any launch, with the same payload.
- Not detected: a Pi process you opened yourself on the same session outside
  pi-squire's window. Close it before resuming.

## Hooks

The `js` block below is the contract's worked example, and
`test/hooks.test.ts` extracts and runs it verbatim on a real `createEventBus`.
Its scope is the test harness's: `pi` is the extension API. Write it as plain
JavaScript so it stays runnable; the name after `js` is the test that runs
that block.

### `session:launch`

`pi-squire` provides this hook. It emits
`{ args, env, agent, cwd, toolCallId, parent, root, depth, chain }`
just before it opens the delegate's window: for a launch, after the task has
been sent; for a resume, before it is sent, since a resume mails the task once
the window is open (see [Resuming a delegation](#resuming-a-delegation)).

| Field | Meaning |
| --- | --- |
| `args` | the child `pi`'s complete argument list, launcher first |
| `env` | the child's environment, as `KEY`/`value` pairs |
| `agent` | the agent's name, as in `<agent dir>/agents/<name>.md` or `<cwd>/.pi/agents/<name>.md` (never its `display_name`); read it, do not change it |
| `cwd` | the directory the window opens in, the parent's or the resolved `--cwd`; read it, do not change it |
| `toolCallId` | the ID of the `delegate` or `delegation_resume` tool call that started the launch; absent when started from the `/delegate` or `/delegate-resume` command; read it, do not change it |
| `parent` | Read-only direct parent session id. |
| `root` | Read-only root session id; retained on resume. |
| `depth` | Read-only numeric child depth, root = 0; retained on resume. |
| `chain` | Read-only frozen array of roster agent names ordered root downward, including the current child last; no session ids. |

Listeners may only append to `args` and add keys to `env`; there is no veto,
and top-level launches pass both to tmux unchanged. For nested launches and
resumes, after all listeners return, pi-squire resolves the final tool selection
and appends an authoritative exact-name `--tools` registration allowlist bounded
by the direct parent. This limits which tool names the child can register and
reach, including names provided by hook-added extensions, late registrations
and MCP. It does not
limit extension code or implementations registered under allowed names;
unrelated arguments/environment keys survive. For nested launches and resumes,
final customized arguments that Pi cannot parse refuse the launch before the
window opens.
An empty final set also receives `--no-tools` and an empty allowlist so earlier
selection flags cannot restore tools. Do all work synchronously: the emitter
reads the payload the moment `emit` returns.

`cwd`, the trust flag (`--approve` or `--no-approve`), `--session-dir` and the
session choice (`--session-id` for a new delegate, `--session` for a [resumed](#resuming-a-delegation)
one) are launch invariants that `pi-squire` chooses. The window opens in its own `cwd`,
whatever a listener assigns to the payload. A listener must not add another
trust flag, `--session-dir`, `--session` or `--session-id`, or a working-directory change to `args`, since
that would launch a child whose trust or session storage the parent did not
choose and cannot find; append only unrelated settings.

```js session:launch
// Any extension can shape a launch: append a flag and add an environment key.
// `cwd` says where the window opens; read it, never assign it.
pi.events.on("session:launch", (payload) => {
  payload.args.push("--auto");
  payload.env.GATE_MODE = "auto";
  payload.env.GATE_ROOT = payload.cwd;
  payload.env.GATE_CHAIN = payload.chain.join(",");
  payload.env.GATE_PARENT = payload.parent;
  assert.equal(payload.chain.at(-1), payload.agent);
  assert.ok(Number.isSafeInteger(payload.depth));
  assert.ok(Object.isFrozen(payload.chain));
});
```

### `squire:identity`

`pi-squire` emits this synchronous, read-only notification from its identity
restore handler in `session_start`, before its later asynchronous startup work.
The payload is `{ sessionId, status, identity? }` for the active exact session id:

- `status: "delegate"`: its saved identity passed Squire's validation and was
  successfully persisted again. `identity` contains only
  `{ parent, root, agent, chain, depth }`, with the same meanings as
  `session:launch`.
- `status: "root"`: no identity record exists for that exact id. This is absence
  of Squire delegate identity, not proof that the session is an original root.
- `status: "invalid"`: reading, validating or persisting its identity failed.
  No prior identity or raw error is included; Squire's existing restore error
  and launch/completion refusal remain in effect.

The payload, identity projection and copied `chain` array are frozen. Internal
placement and auto-exit state are not exposed. Environment variables, display
labels and copied transcript entries are not identity authority.

Pi 1.3 and 1.4 recreate the extension runtime and dispatch `session_start`
after new, fork/clone and session switch/import; reload also dispatches it.
Each restore reads only the destination's exact id, so a new/forked session
without its own record reports `root`, not the source's delegate identity.
This event does not adopt sessions or migrate records.

Register listeners before Squire loads and do all observation synchronously.
The bus does not replay notifications, await asynchronous listeners, acknowledge
listener success or veto later startup; listener exceptions are reported by Pi.
Consumers own resetting their state at session shutdown/replacement, matching
`sessionId` to their current context, and handling missing or invalid
notifications. A consumer that must initialize before another extension's
`session_start` must load its listener before Squire, and Squire before that
extension. This is an observation seam, not an authorization gate or a provider
integration.

```js squire:identity
pi.events.on("squire:identity", (snapshot) => {
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(typeof snapshot.sessionId, "string");
  assert.ok(["root", "delegate", "invalid"].includes(snapshot.status));
  if (snapshot.status === "delegate") {
    assert.ok(Object.isFrozen(snapshot.identity));
    assert.ok(Object.isFrozen(snapshot.identity.chain));
    assert.equal(typeof snapshot.identity.root, "string");
    assert.equal("rootPlacement" in snapshot.identity, false);
  } else {
    assert.equal("identity" in snapshot, false);
  }
});
```

### Process-local completion holds (v1)

Squire composes external work with its existing completion predicate through a
provider-neutral data table at `globalThis[Symbol.for("pi.completion-holds.v1")]`:

```ts
{
  version: 1,
  hosts: Map<sessionId, Map<hostName, runtimeToken>>,
  holds: Map<sessionId, Map<holdId, { provider: string, ready: boolean }>>
}
```

An active Squire runtime registers `"pi-squire"` with a fresh string runtime token
only during its exact session's `session_start`, after process ownership is
acquired. A losing duplicate does not advertise support. Every
`session_shutdown`, including reload, removes only that runtime's matching host
token. Stale shutdown cannot remove a replacement's registration.

Providers must check for a well-formed, nonempty host map for the current exact
session before promising a hold. Register a unique hold id with `ready:false`
atomically before launching the work; refund only that provisional entry if
launch fails. Keep accepted entries across reload, including while the provider
is unavailable. Set `ready:true` only after the terminal result has been observed
and successfully processed; the provider owns that decision and its normal-run
commit, before Squire reads readiness at `agent_settled`. Squire neither observes
external output nor decides whether an operation succeeded.

All current-session holds must be well formed and ready before Squire sends a
new final task reply, marks its tree entry finished, or auto-exits. An absent
table or no holds preserves normal completion. A malformed table/version or
malformed current-session host/hold entry blocks completion; Squire does not
overwrite it to repair storage. Other sessions' holds do not block this session.
An absent host does not invalidate already-ready entries; it refuses promises
of new holds. Providers clear only their own holds at non-reload teardown;
Squire never removes provider entries.

This is trusted in-process extension data, not a model-callable release API,
cross-process registry, durable reopen block, or authorization boundary. There
are no callbacks in the table, fake child tasks, polling/continuation loops, or
automatic model calls to keep a session alive. Ordinary shutdown cancels the
provider's work; reopening does not recover these holds. Already-frozen reply
outboxes retain their existing retry semantics.

This executable observer loads after Squire and checks only the host contract:

```js completion-holds:v1
pi.on("session_start", (_event, ctx) => {
  const table = globalThis[Symbol.for("pi.completion-holds.v1")];
  assert.equal(table.version, 1);
  assert.ok(table.hosts instanceof Map);
  assert.ok(table.holds instanceof Map);
  const hosts = table.hosts.get(ctx.sessionManager.getSessionId());
  assert.ok(hosts instanceof Map);
  assert.equal(typeof hosts.get("pi-squire"), "string");
});
```

### `message:send`

`pi-squire` consumes this hook to write the task; the provider writes the
envelope from its own session's address and sets `envelope` (or `error`) on the
payload before `emit` returns. **If neither is set, no provider is installed**
and `pi-squire` refuses with a message naming `message:*`. The envelope's `id`
is kept in the delegation's record, so an answer can be matched to it. The
provider's own README carries the contract.

### `message:reply`

After the final run settles (including fallback continuations and the durable
child-first processing barrier), squire emits
`{ to, inReplyTo, body, status }`: the direct parent's address, the owed request
ids in batches of at most 50, the exact result text, and `done` or `failed`.
The provider must synchronously set `envelope` or `error`; neither means no
provider. Squire keeps the task owed until the write succeeds and completion
is recorded. The provider's README owns the transport contract.

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
squire resume still supplies its current fallback candidates.

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
the shared [tree registry](#tree-wide-launch-budgets) indexes their durable
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

### `message:inbound`

`pi-squire` consumes this hook for answers: a reply whose `in_reply_to` names a
recorded delegation's request is taken over. `pi-squire` sets `handled`, so
the provider injects nothing, and shows the parent the result message above.
The reply's request copies fill the quoted task and its `cur/` path is the
envelope it names. A reply to a request this session did not delegate is left
to the provider.

Inside a delegate, `pi-squire` also takes over the task: a `request` whose
`from` is the parent's address. It sets `handled` and sends the task as a user
prompt labelled `[delegate]`, so the run starts the way a typed prompt does.
Squire durably records its parent and request id before starting the task;
it owns the answer through `message:reply`. The provider arms no automatic
request answer. Every other message to the delegate is left to the provider.
`pi-squire` reads `from` and requires
it to be the sender's address, which for a delegate is its session id; a reply
from any other sender is left to the provider, even when it answers a recorded
request. The provider's README carries the contract.

`pi-squire` rebuilds its records synchronously in its own `session_start`, so it
relies on the provider not emitting `message:inbound` from inside a
`session_start` handler: mail waiting at session start must be claimed on a
later event-loop turn, as pi-session-mail's `message:inbound` contract guarantees.
That is what makes a result that arrived while the parent was closed reach the
rebuilt records. Keep extensions whose `session_start` waits on I/O from
loading between the provider and `pi-squire`.

### `message:scan`

`pi-squire` consumes this hook on every poll tick (see Results): it emits `{}`,
and the provider claims the mail waiting in its inbox, emitting each reply as
`message:inbound`, before setting `scanned` to `true` on the payload and
returning from `emit`. Only then does `pi-squire` check windows, so a reply
written just before a window closed is never mistaken for no reply. **If
`scanned` is not set, nobody answered**, and the tick declares nothing closed,
because a waiting reply cannot be ruled out. The provider's README carries the
contract.

## Testing limits

The automated tests drive the extension through fake Pi lifecycles. The
reusable `test/mail-harness.ts` runs multiple independent extension instances
with the real, exactly pinned pi-session-mail 0.6.0 over an isolated shared
mail root. Protocol tests cover correlation, asks, stops, fallback, pending
answers, retries and duplicate delivery after the write/completion crash
window. These are not real model runs or real process-crash tests. They check
the registered tool definitions, the structured prompt options a simulated run
preparation receives, file handling, visibility gating and the existing launch
and result paths. They do not prove actual Pi event scheduling, final provider
requests, compaction, cache behavior, or model obedience. The idle-result wake
is simulated by dispatching the next preparation; the suite does not assert
that the runtime emits it.

Working-directory and trust tests use real temporary Git repositories and
Pi's real trust store under a temporary agent directory, but a fake tmux. The
existing-directory/inherited launch evidence does not verify startup for a
managed worktree or prove that a real delegate loads the selected checkout's
instructions and settings; actual Pi/tmux startup and resource loading remain
unverified. Snapshot tests use real repositories and,
for hung, failing or flooding Git, a scripted `git` on `PATH`.

## Compatibility

While pi-squire is below 1.0, breaking any contract below bumps the minor
version and is listed under "Breaking" in [CHANGELOG.md](CHANGELOG.md).

Other extensions may rely on:

- the `session:launch` payload
  `{ args, env, agent, cwd, toolCallId, parent, root, depth, chain }`, emitted
  synchronously before the window opens (after the task is sent for a launch,
  before it is sent for a resume), with
  `cwd`, the trust flag and `--session-dir` chosen by `pi-squire` (see
  [Hooks](#hooks));
- the `message:send`, `message:reply`, `message:inbound` and `message:scan` hooks, consumed as
  their sections document;
- the `delegate`, `delegation_status`, `delegation_close` and `delegation_resume` tool names,
  parameters, the recorded `workspace` shape and the `workspaceSnapshot`
  shape in results and status;
- the `/delegate` and `/delegate-resume` syntax and flags, and their
  no-argument forms: `/delegate` opens the new-delegate form and
  `/delegate-resume` the resume picker;
- the `/delegates` command and its `alt+shift+d` shortcut, and `/delegate-open <id>` with its
  `--switch` and `--peek` flags;
- the `[delegate]` result text and the closed-without-a-result text;
- the agent file's frontmatter keys and its locations,
  `<agent dir>/agents/<name>.md` and, in a trusted project,
  `<cwd>/.pi/agents/<name>.md`;
- the `maxDepth`, `maxConcurrentDelegates`, `maxDelegatesPerRoot`, `delegateTools`, `toolBundles`,
  `windowPlacement`, `worktreeRoot`, `delegateWidgetPlacement` and
  `delegateWidgetMaxEntries` settings in
  `<agent dir>/squire/settings.json`;
- the optional `<agent dir>/squire/delegation_prompt.md` file and the
  `squire_parent_delegation` system-prompt section;
- the child environment variables `PI_DELEGATE_PARENT`, `PI_DELEGATE_ROOT`,
  `PI_DELEGATE_DEPTH`, `PI_DELEGATE_AGENT`, `PI_DELEGATE_CHAIN`,
  `PI_DELEGATE_AUTO_EXIT`, `PI_DELEGATE_FALLBACK` and `PI_UNATTENDED=1`.

A `message:*` provider must:

- implement `message:send`, `message:reply`, `message:inbound` and `message:scan`
  as documented under [Hooks](#hooks);
- set a reply's `from` to the sender's address, so the delegate's reply can be
  matched to its task;
- write explicit request replies through `message:reply`, without automatically
  answering requests at settle; asks remain separately owned by the provider.

## Contributing

See [CONTRIBUTING.md](https://github.com/gvanderclay/pi-squire/blob/main/CONTRIBUTING.md) to set up, run the tests and open a pull
request. Changes by release are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, as stated in [LICENSE](LICENSE).

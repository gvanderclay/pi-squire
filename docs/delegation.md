# Delegation and navigation

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [New-delegate form](#new-delegate-form)
- [How a delegation works](#how-a-delegation-works)
- [Delegate overview](#delegate-overview)
  - [Live activity telemetry](#live-activity-telemetry)
  - [Navigation](#navigation)
- [Reaching delegates](#reaching-delegates)
- [Tools](#tools)
- [Explicit subtree close](#explicit-subtree-close)

## New-delegate form

With an empty roster in interactive Pi, `/delegate` first offers to create a
minimal `scout.md`. Choose user scope (all projects) or project scope (offered
only when this project is trusted; replaces a same-name user agent). Review the
exact path and content before confirming. Creation is exclusive: an existing
file, including a disabled agent, is never overwritten. Cancel either creation
dialog to write nothing. Model and thinking are omitted, so the current
session’s values apply. The new scout is selected straight into the task form;
canceling the task afterward keeps the agent file you already approved.
The bootstrap never runs for typed requests, RPC, print or JSON mode.

`/delegate` with no arguments and an existing roster opens a form: pick an agent, write the
task in the multi-line editor, give it an optional label (empty for the
default name), then a settings screen. Its first row, Start, launches; the rows
below it all begin at the agent's defaults: Model (a filterable list of the
models your Pi has credentials for), Thinking (only the levels the selected
model supports; a level the model does not support, whether from the agent's
default or after changing the model, moves to the nearest supported one and says so), Auto-exit, Working directory (your own, to change)
and Worktree (a new branch name, empty for none). A worktree and a changed
working directory exclude each other; the base, source and fallbacks stay
command-only. For an agent with `routing_profile`, the form also asks for
routing JSON; leaving its model or thinking choice blank uses the policy, not
the parent's current values. The form starts the delegate through the same path as the
command, in the background, with the same start message. The label and
directory are checked as `--label` and `--cwd` are, before anything is sent
or opened.

## How a delegation works

`/delegate <agent> [--model <provider/id>] [--thinking <level>] [--routing "<JSON>"] [--label <name>] [--cwd <dir> | --worktree <branch> [--worktree-source <dir>] [--worktree-base <commit-ish>]] [--auto-exit | --no-auto-exit] <task…>`
reads the agent from `<agent dir>/agents/<name>.md` (or a trusted project's
`.pi/agents/<name>.md`; see [Agents](agents.md#agents)). A legacy call sends the task
through `message:send` before emitting `session:launch`; a routed call validates
the hook's protected launch values before task delivery (see
[Role/task routing](routing.md#role-task-routing)). It then opens a detached
window running the parent's own Pi in the parent's working directory,
or the directory `--cwd` selects or the new `--worktree` checkout creates (see [Working directory](workspaces.md#working-directory)),
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
  the delegate then closes its own window ([auto-exit](results-and-recovery.md#auto-exit)). With
  auto-exit off the window stays open so you can read it or keep working in it.
- Delegations are recorded in the parent session without the task text. Each
  record keeps the directory the window opened in and the session-storage
  directory the delegate was given.
- The delegate always gets an explicit project-trust flag, `--approve` or
  `--no-approve`, so a permissive global `defaultProjectTrust` cannot trust a
  project the parent does not, and an unattended window never waits on a
  trust question. In the parent's own directory it is the parent's current
  trust (`ctx.isProjectTrusted()`); for a `--cwd` directory see
  [Project trust](workspaces.md#project-trust).
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
  [Nested delegation](nesting.md#nested-delegation)).
- Without a UI the command and the `delegate` tool still work, except a
  top-level launch whose project trust needs a question (a nested launch can
  ask its attended root; see
  [Project trust](workspaces.md#project-trust)). They need a supported host (tmux, Herdr or a Paseo-hosted Pi)
  and a provider of `message:*`, and refuse with a message when either is
  missing. `/delegate` and `/delegate-resume` refusals go to stderr in print
  (`pi -p`) and JSON mode, without adding a message or starting a model turn.
  `/delegate-open` and `/delegate-cleanup` refusals use the same path. JSON
  stdout stays protocol-only. Successful slash commands still add nothing to
  context; refusal diagnostics do not change Pi’s exit status. See
  [doctor](troubleshooting.md#delegate-doctor).

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
activity. Each running row has a second line showing `working...`, regardless
of live telemetry; finished rows have no second line.
A collapsed delegate with open descendants shows **+N** at the end of its row.
This counts open stable sessions, not historical attempts or results.

Delegates also see their ancestors vertically, root to direct parent, with the
direct parent marked `(parent)` (including `root (parent)`). A connected
**Delegates** branch starts with the current session's direct children and
expands to show their open descendants.
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
  visible delegate consumes one slot, at any expanded depth. `+N more delegates`
  counts eligible rows beyond the viewport. **0** hides child rows and restores
  Squire's running-count footer while preserving ancestor rows/navigation;
  zero children never produce an empty heading.
- These preferences apply equally to roots and coordinators. Interactive views
  re-read them about once a second; invalid widget preferences warn once per
  distinct error and use the defaults without changing task state.

Launch/result/close changes refresh promptly; an independent one-second observer
keeps finished-open rows, descendant membership, window eligibility, and later
native title changes fresh even when the result poll has stopped. Only visible rows resolve titles and
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

### Live activity telemetry

The internal feed follows actual Pi tool-execution events: `reading…`,
`editing…`, `writing…`, `command call…`, or `using <tool name>…`. Parallel
and nested calls are tracked by their actual call ids, not by tool name.
Active nested calls take precedence over their orchestrator. A tool start is
observed before permission interception: `command call…` means an outstanding
call, not proof that a subprocess started or permission was granted. Squire
does not inspect commands to guess intent, or display arguments, paths, tool
results, thinking or provider payloads.

Otherwise, while an assistant response streams, the feed holds a literal
single-line excerpt bounded to 512 UTF-8 bytes. These details are not shown in
the widget. The excerpt clears when that message ends. Calls
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
One running child-entry slot occupies two physical lines; there is no empty
secondary line or tool-use counter.

### Navigation

At an **empty built-in prompt**, press **Down** to select the direct parent in a
delegate session, or the first child at root. Up/Down traverse ancestors and
open delegates in display order. Only delegate rows scroll within the configured
cap. Selection follows stable session identity through renames, reordering and
resumes. Enter switches directly to the selected delegate's verified tmux window.
Press **x** to close its recorded subtree. Every close asks for confirmation,
including finished delegates. Ancestors cannot be closed.

Right expands a delegate with children. Right again selects its first child.
Left collapses an expanded delegate; on a collapsed child with children, Left
selects its parent. Ancestors and childless rows ignore Left and Right.
Collapsed delegates show **+N** open descendants at the end of their row.
Esc, typing, or Up past the first row returns focus to the prompt and collapses
every branch. Typing passes the key through to the prompt.

A dim **↓ to manage delegates** hint appears when the widget is not focused.
Focused hints show the selected row's valid actions, including expand or
collapse when applicable. Cap zero never creates invisible selectable
delegates; ancestors remain selectable.

Pending actions absorb keys only while the exact empty built-in prompt still
owns focus. Dialogs, completion menus, and unknown components keep their keys.

Enter on an ancestor switches directly to its verified **current live tmux
window**, not to a historical launch window. Root and leaf
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
the concrete focus getter and exact built-in editor identity. Tests exercise
the adapter against the pinned Pi version (currently **1.5.2**), including
regular/fullscreen UI migration. Unknown focus/editor/completion capabilities disable key capture
rather than guessing; `/delegate-open` remains available. This is not a generic
custom-editor integration or a supported Pi focus hook. JSON/RPC hosts retain
the running-count status rather than receiving a terminal widget.

## Reaching delegates

Use the compact widget to switch to a delegate or close its subtree.
Use `/delegate-open <id> [--switch|--peek]` to reach one delegate by id.
With no flag or with `--switch`, it switches your tmux client to that delegate's
verified window. `--peek` opens a pane snapshot in an overlay, where `r`
refreshes, Enter switches, and Esc returns to the prompt. Ids complete from the
open delegations. The model has no tool that moves your terminal.

Switch acts on the most recently active tmux client attached to the parent's
session. With none attached it refuses with a notice; peek and close still
work. No tmux key bindings or options are added. To return, use your own tmux
last-session key, which defaults to `prefix L`. The switch notice reminds you.

The compact widget and `/delegate-open` share current-locator verification.
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

## Tools

The model gets six tools. They share the command's launch path and the
session's delegation records. In a delegate they are active only for an
opted-in coordinator below `maxDepth`; admission also checks every launch/resume.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `delegate` | `agent`, `task`, optional `model`, `thinking`, `routing`, `label`, `cwd`, `worktree`, `worktree_source`, `worktree_base` and `auto_exit` (boolean) | Validates the call the way the command does, starts the delegation without opening a dialog (except an unresolved [trust question](workspaces.md#project-trust) for `cwd`), and returns the delegation id at once without waiting for a result. |
| `delegation_status` | optional `id`, `all` | Reports each delegation as running, done, closed or closed without a result, with the window, the delegate's session and the result envelope's path. By default it lists running, unfinished and the 5 newest settled records; `all: true` lists every record. |
| `delegation_close` | `id` | Explicitly fences and closes a descendant subtree using current verified windows. Returns per-member outcomes and complete/partial status; retains worktrees and branches. |
| `delegation_cleanup` | `ids` (1–50 unique ids) or `all: true` | Removes merged, unused, clean Squire-created worktrees and their local branches; ignored files are deleted too. Unproved items are kept with reasons (see [Cleanup](workspaces.md#cleanup)). |
| `delegation_resume` | `id`, `task`, optional `model`, `thinking`, `routing` and `auto_exit` | Reopens an exited delegate's own session in a new window with a follow-up task, and returns the new delegation's id at once (see [Resuming a delegation](results-and-recovery.md#resuming-a-delegation)). |
| `delegation_fork` | `id`, `task`, optional `model`, `thinking`, `routing`, `auto_exit`, `worktree` and `worktree_base` | Starts a new delegation from a copy of a direct child's context, leaving the original untouched (see [Forking a delegation](results-and-recovery.md#forking-a-delegation)). |

The `delegate` tool's description lists the current roster, one line per agent:
its name and any display name, description, then a parenthetical with what the
agent explicitly sets: a default model and fallbacks, thinking, auto-exit when
it is off, its tools (`no tools` for an empty `tools` field,
`this session's except …` for `-name` entries) and the fields it locks. An
agent that sets none of these prints no parenthetical, so the lines that do
name a model stand out; the roster heading says once that a model or thinking
level a line does not name is this session's.

```text
- scout "Recon" — Read-only recon (default provider/model-id, thinking low, auto-exit off, tools: read/grep, locked: model)
```

The model picks an agent from these lines without reading files. For a
routed role, selection comes from its routing profile and request metadata,
not the legacy model/fallback defaults. The description also tells the model
to turn `auto_exit` off when it means to keep
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

For status selection, outcome meanings and usage-limit marks, see
[Statuses](results-and-recovery.md#statuses).

## Explicit subtree close

`delegation_close` and the compact widget close action enumerate persistent
records and close the selected session and all its descendants, including work
whose coordinator is offline. Any ancestor may close; unrelated trees, siblings
outside the selected subtree and user windows remain untouched. Neither action
kills a companion tmux session wholesale.

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

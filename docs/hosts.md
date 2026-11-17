# Hosts and placement

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Install](#install)
- [Herdr support](#herdr-support)
  - [Choosing a terminal host](#choosing-a-terminal-host)
  - [Tabs](#tabs)
  - [Resume, fork and Herdr restarts](#resume-fork-and-herdr-restarts)
- [Rex support](#rex-support)
- [Paseo support](#paseo-support)
  - [Host capabilities](#host-capabilities)
- [Where delegate windows open](#where-delegate-windows-open)

## Install

You need:

- Pi 1.5.0 or later, on macOS or Linux (not Windows). Pi 1.5.2 is the version
  pi-squire is tested with. It provides configured keybinding hints for delegate
  results, blocked-input status for inline choice screens, and the extension
  APIs the package relies on. Pi supplies the peer dependencies
  `@earendil-works/pi-coding-agent` and `typebox`.
- tmux 3.2 or later, with the Pi session running in a tmux pane. That is the
  first version with `new-session -e`. Windows are placed
  relative to the pane's session (see [Where delegate windows
  open](#where-delegate-windows-open)), so a client attached elsewhere does
  not matter. Alternatively, run Pi in a [Herdr](#herdr-support) pane:
  pi-squire detects which one it is in. A [Rex terminal](#rex-support) is also
  supported. Or let [Paseo](#paseo-support) host
  the Pi session; you then need no terminal host.
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

The package has no build step. Its only runtime dependency is
`@getpaseo/client` 0.15.4, the Paseo SDK. pi-squire imports that SDK, and runs
the `paseo` command, only for Paseo operations; ordinary tmux/Herdr/Rex launches
need neither. Managed-worktree cleanup can check Paseo workspaces even from a
terminal coordinator. A receipt-less cleanup skips the SDK only on positive
daemon absence; ambiguous state keeps the item (see [Cleanup](workspaces.md#cleanup)).

## Herdr support

pi-squire works the same in [Herdr](https://herdr.dev) as in tmux: delegate,
status, close, resume, fork, nested delegates, the widget and
`/delegate-open`. It targets Herdr 0.9.5, protocol 22, on macOS/Linux with a
POSIX-compatible interactive shell (`sh -c` launch; tested with zsh).

### Choosing a terminal host

With no setting, each launch looks at the session's environment:

| Pi runs inside | pi-squire uses |
| --- | --- |
| tmux only (`TMUX` set) | tmux |
| a Herdr pane only (`HERDR_ENV=1` and its pane context), in a named or the default session | Herdr |
| a Rex terminal only (`REX_SERVER`, `REX_SESSION` and `REX_BLOCK` set) | Rex |
| more than one of tmux, Herdr and Rex | refuses, naming the setting |
| none | refuses, naming all three |

To choose, set `multiplexer` in `<agent dir>/squire/settings.json` (not Pi's
own settings):

```json
{ "multiplexer": "herdr" }
```

A Pi that Paseo hosts uses Paseo instead and never reads this setting (see
[Paseo support](#paseo-support)).

Outside Paseo, `"tmux"`, `"herdr"` or `"rex"` wins over detection in every case. The
setting is read at every launch, resume and fork, and the choice is frozen
before anything is created or mailed. If the chosen multiplexer is unusable
(not inside it, server down, incompatible API), the launch refuses; pi-squire
never falls back to another host. An invalid value refuses and names the file.
A delegate records the backend that opened it in `PI_DELEGATE_MULTIPLEXER`,
so its own delegates use the same one when no setting is present, even if its
environment shows several hosts. Existing delegations keep using the multiplexer they
started in, whatever the setting says now.

### Tabs

Each delegate opens as a named, unfocused **tab in the workspace the root Pi
started in**: nested delegates are flat tabs next to their parents, never
splits, and worktree launches are the same. `windowPlacement` and
`companionSuffix` affect only tmux placement. If you move a Pi's pane to
another workspace after it started, its launches refuse and name both
workspaces, since Herdr's pane context no longer says where to open; move it
back, or start Pi in the workspace you want. A moved delegate pane reads as
`unknown` (never gone) and is not closed. The tab runs in the selected
working directory with the parent's environment and `session:launch` additions;
parent/user-supplied `TMUX*` and `HERDR*` routing values are excluded, while
Herdr's newly assigned child context is preserved. Large arguments/environment
values travel through an owner-only staged launch file, not a typed shell line.
Like prompt files, these files remain until the operating system clears the
temporary directory; they can contain credentials from the launch environment.

Task/result delivery still uses the same `message:*` provider. Neither screen
text nor Herdr's agent status counts as a result. `delegation_status` uses
Herdr's tab/workspace vocabulary. Public result fields retain their names:
`windowId` is the tab id and `windowSession` is the workspace id.

`delegation_close` re-verifies the exact pane and terminal incarnation, then
closes **only the pane pi-squire created**. Herdr removes the tab when that was
its last pane; user-added panes remain. Failed probes are unknown, never assumed
gone. Restored/replaced terminals are treated as gone and left untouched; do
not use explicit close to remove a tab restored by Herdr after a restart.

A clean Pi exit closes its pane, even while you are viewing it. The tab goes
away only when that was its last pane; user-added panes remain. Error exits,
including failed starts, retain a shell and readable diagnostics for inspection;
`delegation_close` removes the owned pane. Delegates remain in Herdr's native
agent sidebar and show their delegate name through display metadata. That
metadata never controls lifecycle or hides other agents.

Widget Enter and `/delegate-open <id> --switch` focus the delegate's tab only
after re-verifying its terminal identity. `--peek` shows its pane's recent rows
without changing focus; `r` refreshes, Enter switches, and Escape returns to
the prompt. Error tabs that remain open can still be viewed. A delegate's
parent breadcrumb switches to its verified live parent, including a root Pi.
Switch confirmations name the originating tab in Herdr's tab bar so you can
return without assuming any configured keybinding.

### Resume, fork and Herdr restarts

`delegation_resume`, `/delegate-resume` and `delegation_fork` open a new tab.
A resume first closes its own exited, retained pane (exact terminal only), then
mails the task once the new tab is open.

Herdr restores tabs after a restart, keeping their pane and tab ids but with new
terminals, and relaunches Pi there with `pi --session <file>`. pi-squire treats
those as different terminals:

- delegations from before the restart show as gone; their results still come
  only through mail;
- restored tabs are never adopted, focused, read or closed by pi-squire;
- before any reservation, close or mail, resume asks Herdr whether a tab already
  runs the delegate's session file. If one does, it refuses and names the tab,
  for example `Herdr tab scout-ab12 (w1:t2) already runs delegation session …`.
  A restored tab that reports no session must show only its shell, or resume
  refuses too. If Herdr cannot be asked, resume refuses rather than risk two Pis
  writing one session. A delegation recorded in Herdr can only be resumed from
  Pi inside the same Herdr session. Quit or close the restored tab yourself, then
  resume again.

pi-squire's own session-owner check still refuses a session another Pi with
pi-squire has open. Herdr relaunches Pi panes whose session its Pi integration
reported. To stop it relaunching agents (delegates included) after a restart,
set `resume_agents_on_restore = false` in the `[session]` table of Herdr's
`config.toml` (see `herdr --default-config`); this applies to every agent in
Herdr, not only delegates. Reloading or restarting Pi does not change any of this: records and
their locators are durable, and the setting is read again at the next launch.

**Changed default for some tmux users.** Before this release pi-squire always
used tmux when no `multiplexer` was set. If your Pi runs in tmux and its
environment also has a Herdr pane context (for example Herdr started from a
tmux pane, or tmux started inside a Herdr pane), launches without the setting
now refuse instead of using tmux. Set `{ "multiplexer": "tmux" }` to keep tmux.
Apart from that, and the refusal wording when Pi runs in neither multiplexer,
tmux behaviour and its controls are unchanged.

## Rex support

Rex opens each delegate in a background window in the coordinator's Rex
session. Tested with Rex 0.1.0-preview.20, API revision 16; older API revisions
are refused. Run Pi in a Rex terminal with the `rex` CLI available. Detection
requires `REX_SERVER`, `REX_SESSION` and `REX_BLOCK`; set
`{ "multiplexer": "rex" }` explicitly when another terminal host is also
detected. Tmux placement settings do not apply.

Launches run a staged argv/environment file directly, without typing into a
shell. Like Herdr, Rex inherits the parent's environment except host routing
and previous delegation identity; the new terminal keeps its own Rex context.
The CLI always targets the recorded server endpoint with autostart disabled.
The coordinator's block must still belong to its original session.

Status, peek and navigation verify the server, session and block id, not the
window title. Moving a delegate's block between windows in the same session
does not change its identity. Navigation requires an attached Rex app.
Explicit close removes only the owned block, leaving user-added panes alone.

Auto-exit follows the same result-delivery and nested-work rules as tmux.
Rex normally removes a terminal when its program exits, but retains one after
a quick startup failure. Squire records the runner's exit separately so that
a retained failed terminal is not mistaken for running work; explicit close
can remove it.

Resume and fork use the ordinary terminal-host checks and open a new window.
Rex has no Herdr-style restored-session guard: its block ids are the identity
fence, and a missing block is gone. An unavailable server or a different
server/session is unknown, not proof of exit.

## Paseo support

Paseo can host the coordinator Pi, and then pi-squire starts each delegate as a
**Paseo agent** instead of a tmux window or a Herdr tab. Tested with Paseo
0.15.4. Squire currently selects this host only for a coordinator Pi that
Paseo started; this is Squire routing policy, not a Paseo requirement for
creating agents. The `paseo` command must be installed with its daemon running:
reading activity and explicitly closing an agent run that command.

- As on tmux and Herdr, delegates receive the parent's `PI_CODING_AGENT_DIR`
  and explicit `PI_SESSION_MAIL_ROOT` and `XDG_STATE_HOME` values (see
  [Configuration](configuration.md#configuration)). No API keys or other credentials are copied
  from the parent into Paseo's persisted agent environment.
- Each delegate is a Paseo child agent of its direct coordinator. A delegate
  in the coordinator's folder reuses that folder's existing workspace; a
  managed worktree keeps its own workspace and working directory without
  losing the parent link. That workspace joins the project of the worktree's
  main checkout when Paseo has the checkout open; otherwise it shows as a
  project of its own. Closing an agent leaves its workspace in place.
  Existing agents and delegation records are not relinked or moved.
- Paseo's parent link also affects lifecycle: archiving a parent archives its
  same-workspace children, except children with open agent tabs; cross-workspace
  and open-tab children detach instead. Do not archive or delete a coordinator just to move
  back to the terminal while its delegates still need to run. Use
  `delegation_close` for an explicit Squire subtree close.
- On launch, an internal `/delegate-turn` command lets Paseo poll the
  delegate's context-window usage during its first mailed run. It adds no
  message to the model's context and waits at most 10 seconds for that run
  to start; a timeout leaves launch and task delivery unchanged. Paseo may
  show the command in its timeline. Later autonomous runs (follow-up mail or
  a nested child's result), including resumed runs, refresh usage when they
  finish, not live while running. This first-run bridge is Squire behavior,
  not a Paseo limit on subsequent native turns. No prompt is sent into a
  delegate that is already running.
  This relies on Paseo 0.15.4 behaviour: a parent given as the
  `paseo.parent-agent-id` label keeps the parent link without Paseo wrapping
  the launch prompt, and Paseo keeps a slash-command turn open while the
  session is streaming. A Paseo that stops doing the second only loses the
  live display; one that wraps the prompt again would show `/delegate-turn`
  to the delegate's model as text.
  Paseo 0.15.4 drops its native usage display when an agent is archived;
  use `auto_exit: false` to keep it open and retain the final display, or
  read Squire's result/status usage after archive.
- `delegation_resume` and `/delegate-resume` reopen an **archived** Squire
  delegate with Paseo's public SDK `reload()`, keeping the same Paseo agent,
  Pi session file and conversation. Only its original Paseo-hosted direct parent
  may resume it. Squire checks the exact agent, native parent, Pi session id,
  file/header and cwd before reservation and again before reload, then verifies
  the actual returned runtime session id before mailing the follow-up. Deleted
  agents, moved/missing session files, changed identities/cwd, ambiguous daemon
  responses and routed delegates are refused; Squire never imports a new agent
  as a fallback. Older receiptless records can resume when these checks pass.
- Paseo resume accepts **only `id` and `task`**. Every explicit `model`,
  `thinking`, `auto_exit` or `routing` override is refused, even if unchanged.
  Paseo reuses the original launch settings (including tools, trust, prompt,
  fallback and environment); current roster launch-setting edits are not applied.
  Saved Squire auto-exit state and current roster admission/grants still apply.
  A native Paseo resume does not emit `session:launch`: Paseo reloads the agent
  with the arguments and environment the hook produced at its original launch.
  Normal identity notifications, completion holds, accounting and result delivery
  still run. A pre-reload refusal refunds the reservation. A reload rollback
  refunds it only after a definitive daemon answer (resolved reload with a
  mismatched identity, or a server RPC error) plus confirmed archive/closed
  readback, so a valid source can be retried. Timeouts, lost connections and
  other unknown reload outcomes keep the slot held even after confirmed archive,
  because reload might still finish later. Unconfirmed rollback also stays
  charged and needs inspection. If follow-up mail fails after a successful
  reload, Squire re-archives rather than deletes the original agent, but the
  shared started successor remains and blocks another Squire resume of that
  chain (the same limitation as terminal resume). Inspect or continue the
  preserved conversation manually in Paseo/Pi with only one writer, or start a
  fresh delegate; do not delete tracking history to force a retry.
  Fork remains unimplemented in Squire for Paseo hosts/sources;
  start a fresh delegation instead.
- On fresh launch, agents with `skills: false` or `context_files: false` are refused before
  reservations, task mail or managed-worktree creation. Paseo 0.15.4 cannot
  pass these Pi resource switches per agent; changing the child's prompt
  would not stop resource loading. Launch that agent from tmux, Herdr or Rex, or
  enable those resources in its agent file. Neither switch is silently dropped.
- Fresh Paseo launches honor the roster's and call's `auto_exit` (default on);
  native resume retains the original setting. After the
  final task reply is delivered and nested work is processed, auto-exit
  archives the delegate. It leaves the active agent list, but its transcript
  remains recoverable in Paseo. With `auto_exit: false`, after human takeover,
  or after a stopped run, it stays open. `delegation_close` still deletes the
  agent, including an archived one.
- Before automatic archive, Squire detaches surviving publicly discoverable
  native children so kept-open children are not archived by Paseo's parent cascade. Their
  Squire parent/root identity is unchanged. Paseo's SDK does not offer an
  atomic detach-and-archive operation: another client attaching a new child
  during cleanup can still expose that child to native cascade. Private
  native helper agents are outside public discovery. The supported listing can
  also omit dormant stored agents whose provider is unavailable; this protection
  does not cover them. A discovery, detach or archive failure is reported without
  discarding the delivered result or
  scheduling a cleanup retry. Auto-exit does not archive a workspace or remove
  its working directory; after merging, use `delegation_cleanup` for eligible
  Squire-created worktrees and Paseo workspaces (see [Cleanup](workspaces.md#cleanup)).
- Squire ignores the `"multiplexer"` setting for a Paseo-hosted Pi and always
  opens agents in Paseo; mixed-host launches are not implemented.
- A delegate has no terminal or pane to show. Paseo supports desktop navigation
  through `paseo agent open <id>`, but Squire has not implemented that action:
  its navigation reply tells you to open the agent in Paseo yourself. `windowId`
  is the agent id, and `delegation_close` deletes that agent.
- A pi-squire older than this support cannot read a Paseo delegation record, so
  it refuses that whole delegation tree. Upgrade every Pi that reads the tree
  instead of moving one back.

A delegate is itself a Paseo agent. Starting another Pi by hand from a Paseo
delegate's shell inherits that agent's identity; use Squire's `delegate` tool
for nested workers.

### Host capabilities

| Capability | tmux | Herdr | Rex | Paseo |
| --- | --- | --- | --- | --- |
| Fresh launch | Background window | Background tab | Background window | Child agent; coordinator must be Paseo-hosted |
| Nested delegates | With explicit grant and tree caps | Same | Same | Same; native parent link retained |
| Live usage | Pi in its terminal; result/status totals | Same | Same | Native context usage during first mailed run; later autonomous runs update at completion; result/status totals retained |
| Navigation | Verified terminal window/pane | Verified tab/pane in the same named session | Verified block in the same server/session | Squire gives manual app guidance; Paseo desktop-open command exists but is not wired up |
| Auto-exit | Closes its own pane after delivered result and processed nested work; window goes only if it was the last pane | Closes its own pane under the same conditions; tab goes only if it was the last pane | Closes its own block under the same conditions | Archives agent under the same conditions; explicit close deletes it; workspace stays |
| Resume | Exited direct child with session file and original cwd | Same, plus restore/session guard | Exited direct child with session file and original cwd | Archived direct child; same agent/Pi session/cwd; frozen settings, id/task only |
| Fork | Copies a direct child's history to a new session | Same | Same | Refused for Paseo hosts and sources; start fresh |
| `skills` / `context_files` switches | Pi flags honored | Same | Same | Defaults load normally; `false` refused before reservation/mail/worktree |
| `session:launch` flags | Passed to Pi | Passed to Pi | Passed to Pi | Fresh launch: supported fields translated; other flags refused. Native resume: no hook; original configuration retained |

Paseo translates `--session-id`, `--name`, `--model`, `--thinking`,
`--append-system-prompt`, `--session-dir`, `--tools` / `--no-tools` and
`--approve` / `--no-approve`. A hook-added unsupported flag is discovered
only after the hook runs with the final existing cwd, not during static
admission: no task is mailed or Paseo agent/workspace created, and a newly
created managed worktree and reservation are rolled back. A failed rollback
is retained and reported for recovery. Remove the unsupported flag or launch
from tmux, Herdr or Rex; the hook still runs once at its existing lifecycle point.

## Where delegate windows open

The rest of this section describes **tmux** placement.

By default a delegate's window opens in a shared **project companion session**
named `<project>-delegates` on your existing tmux server. The owning
root Pi session's project chooses it, not the parent tmux session or the
delegate's working directory. Launching into another repository or creating a
worktree there still uses the root's companion; resuming a delegate does too.

Nested launches inherit the original root project: A → coordinator in B →
worker in C all select A's companion. The preferred base name (for example,
`A-delegates`) is saved as `rootPlacement` in the existing durable
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
`Client-API-delegates`.

Multiple roots share a companion even across parent tmux sessions. Distinct
paths with the same basename, separate clones named alike, and names that
normalize identically intentionally share it. This groups windows only:
delegation records, task mail, results, limits and close-all remain scoped to
each root.

pi-squire verifies the tmux session option `@squire-companion` before reusing
an occupied name. An unmarked session is left untouched; numbered alternatives
start at `<project>-<suffix>-2`, skipping unmarked alternatives too.
Later launches reuse an existing managed alternative even if a lower name
becomes free. Unexpected duplicate managed candidates use the first in numeric
order, without moving windows or repairing sessions. Existing companions,
live windows and saved identities keep their names, including the former
`<project>-delegate-session` default. Nested launches and resumes retain the
saved preference; companions are not renamed or migrated.

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

To use a different suffix, set `companionSuffix` in
`<agent dir>/squire/settings.json`:

```json
{ "companionSuffix": "playpen" }
```

This names a new root's companion `<project>-playpen`. The default suffix is
`delegates`. A suffix must contain 1 to 32 ASCII letters, digits, underscores
or hyphens, with no leading or trailing hyphen. It cannot be entirely numeric
or end in a hyphen followed by digits, such as `2` or `x-10`, because those
names overlap with numbered alternatives. An invalid suffix refuses the launch
with an error naming the file, before the task is sent or a window opens.
The suffix is read with `windowPlacement` at launch. It does not replace a
saved root preference for nested launches or resumes.

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
(see [Resuming a delegation](results-and-recovery.md#resuming-a-delegation)). There is
no identity migration, directory relocation/rename tracking or companion repair.
The file is read at each launch. Any other value refuses the launch
with an error naming the file, before the task is sent or a window opens.

# Plan: delegate windows out of the way, and a way to reach them

Status: planned, not implemented. Research: [`docs/research/delegate-windows-ux.md`](../research/delegate-windows-ux.md).

## Decision

Delegates stop opening windows in the user's tmux session. They open in a
**companion session**, `<parent's tmux session>-squire`, created on demand.
The user reaches them from the parent through a **`/delegates` panel**: popup,
peek, switch, close and new. No surveyed Pi library jumps to a tmux window;
workmux (`mode: window|session`) is the precedent for the placement setting,
and Claude Code's `claude agents` (peek, attach, detach) for the panel.

- Placement is a setting, `companion` (default) or `current` (today's
  behaviour). No shared or per-parent sessions.
- tmux **3.2** becomes the minimum: `new-session -e` and `display-popup`
  both arrived in 3.2 (tmux `CHANGES`, "3.1c to 3.2").
- Commands and a shortcut only. The model gets no tool that moves the user's
  terminal or opens popups over it.
- Tests stay on the fake tmux; the real client is still exercised by hand.

Two pull requests: placement first (a release on its own), then navigation.

## PR 1: placement

### Setting

`<agent dir>/squire/settings.json`, beside `worktreeRoot`:

```json
{ "windowPlacement": "companion" }
```

- Values `companion` (default when absent) and `current`. Anything else
  refuses the launch with an error naming the file, as the worktree settings
  do (`worktree-placement.ts` `settingsError`).
- Read at call time, like the worktree settings. New module
  `src/window-placement.ts`; `node scripts/check-pack.mjs` for it.

### Companion session

- Name: the parent pane's session name (`#{session_name}` of `TMUX_PANE`)
  plus `-squire`. A parent whose session carries the user option
  `@squire-companion` = `1` (set when pi-squire created it) uses its own
  session, so a delegate that delegates does not make `work-squire-squire`.
  The parent's session and that option are read in one `display-message`
  (`#{session_id}\t#{@squire-companion}\t#{session_name}`, name last).
  *Changed after a live test:* the first design used the name suffix alone
  (a session already ending in `-squire` was taken as a companion), but the
  user's own session was named `pi-squire`, so delegates landed in it. A
  name proves nothing; the marker does, and `pi-squire` now gets
  `pi-squire-squire`.
- Targeted with an exact match, `=<name>:`, never a prefix match.
- Created on demand on every launch, since tmux destroys a session with its
  last window (probe):
  1. `new-window -d … -t =<name>:` as today.
  2. On `can't find session`: `new-session -d -s <name> -n <window> -c <cwd>
     -e … -P -F '#{window_id}' -- argv` followed, in the same tmux
     invocation, by `set-option -t =<name>: detach-on-destroy off` and
     `set-option -t =<name>: @squire-companion 1`. The delegate is the
     session's first window; no placeholder.
  3. On `duplicate session` (another launch won the race): step 1 once more.
- `detach-on-destroy off` on that session only: a user viewing it when its
  last delegate exits lands in their most recent other session instead of
  being detached from tmux (probe). The user's own sessions and global
  options are never touched.
- Certainty for `WindowOpenError`: `can't find session` from step 1 is
  `not-opened` (tmux resolves the target before creating anything); every
  failure after a create was dispatched stays `unknown`, as today.

### `TmuxClient`

| Method | Today | Becomes |
|---|---|---|
| `openWindow(spec)` | `new-window` in the pane's session, returns `@N` | `openWindow(spec, placement)`, returns `{ id, session }` (session name); `companion` runs the sequence above |
| `listWindows()` | `{ id, name, exited }` | adds `session` (`#{session_name}`), placed before the window name, which stays last |
| `version()` | — | new: parsed `tmux -V`, cached; launch and resume refuse below 3.2 |
| `kill(id)` | `kill-window -t @N` | unchanged |

Matching is unchanged: window ids are server-wide and survive `move-window`
between sessions (probe), so `ownWindow`, the poll, `delegation_close`,
resume's eligibility and its exited-window kill work in any session. Windows
already open in the user's session when they upgrade stay there and keep
working.

### Unchanged

- The auto-exit close: the delegate's Pi exits, its window closes; when it was
  the last one the companion session goes with it.
- Resume: it opens through the shared `openChild`, so it follows the setting.
  A resumed delegate of a `current`-era record opens in the companion session.
- The `session:launch` payload, its fence and its launch invariants. Where a
  window opens is not part of that contract.

### Where the session is shown

The session name is looked up, not stored: windows can be moved and sessions
renamed.

- Start message: `delegate: scout started in window scout-first in session
  work-squire` (command and tool text).
- `delegation_status`: the `window:` line reads `scout-first (@3) in session
  work-squire`; omitted when the window is gone.
- The delegate card (`render.ts`) shows it beside the window.
- Tool results and status details gain an optional `windowSession` (the
  `delegate` and `delegation_resume` schemas, status details). Additive.

### Docs

- README requirements: tmux 3.2 or later, and where windows open; a short
  "Where delegate windows open" section with the setting.
- CHANGELOG under `[Unreleased]`, **Changed**: delegates open in a companion
  session by default; tmux 3.2 required. A minor version.

### Tests (fake tmux)

`FakeTmux` gains sessions: a map of session name to window ids, a parent
session name, the `detach-on-destroy` set per session, a version, and a
switch to make `new-window` race (`duplicate session`) or fail after dispatch.

- Default placement creates `work-squire` with the delegate as first window,
  sets `detach-on-destroy off` on it, and records nothing in `work`.
- An existing companion session gets `new-window`; a vanished one is
  recreated on the next launch.
- The duplicate-session race retries once with `new-window`.
- A parent in a marked `work-squire` uses `work-squire`; a user's session
  named `pi-squire`, unmarked, gets `pi-squire-squire`.
- `windowPlacement: "current"` behaves exactly as today (existing tests run
  under it unchanged).
- An invalid value refuses before mail is sent or a window opens.
- tmux below 3.2 refuses launch and resume with the version in the message.
- A window moved to another session is still matched, closed and resumed.
- Status, start text and card show the session; `windowSession` is present.
- Certainty: `can't find session` with a failed create keeps `not-opened`
  only where nothing was dispatched.

## PR 2: reaching delegates

### Commands and shortcut

| Entry | Does |
|---|---|
| `/delegates` | opens the panel |
| `alt+shift+d` (`pi.registerShortcut`) | opens the panel; free in Pi's defaults and passes tmux without extended keys |
| `/delegate` with no arguments | opens the panel straight into the new-delegate steps |
| `/delegate-resume` with no arguments | opens the resume picker |
| `/delegate-open <id> [--popup\|--switch\|--peek]` | one action on one delegation; id completions from open delegations |

### The panel

Lists delegations whose window is open (running, or done with auto-exit off),
newest first, built from `results.list()` and one `listWindows` call. Keys,
shown in a hint line:

- `↑`/`↓` select; `esc` leaves.
- `enter` **open**: a popup, or a switch when the window is in the parent's
  own session (a popup of one's own session shows it inside itself and moves
  its current window).
- `p` **peek**: `capture-pane -p -t @N` snapshot in an overlay; `r`
  refreshes, `enter` opens, `esc` returns.
- `s` **switch**: `switch-client -c <client> -t @N`, then a notice "prefix L
  returns you". No tmux key bindings or options are added.
- `x` **close**: the `delegation_close` path; a confirm only while the
  delegation is running.
- `n` **new delegate** (below).

Empty list: "No open delegates · n new · esc close". New module
`src/navigator.ts`; the form in `src/new-delegate.ts`.

### Which client

Popup and switch act on the most recently active client attached to the
parent's session: `list-clients -t <session> -F
'#{client_activity}\t#{client_name}'`, highest activity. None attached:
popup and switch refuse with a notice; peek and close still work.

### Popup

- `display-popup -c <client> -E -w 90% -h 90% -T <window name>` running
  `tmux select-window -t @N \; attach-session -t <session id>`. The session
  id (`$N`) avoids quoting a user's session name in a shell string. Verify in
  the implementation that this lands on `@N`.
- `display-popup` returns only when the popup closes (probe), so it is spawned
  detached and not awaited, outside `runTmux`'s 10 s timeout.
- Inside the popup, `tmux attach` makes a nested client with `$TMUX` set and
  needs no workaround (probe, 3.7b). Detaching (prefix d) closes it.
- Closing it when the delegate goes: the parent remembers each popup it
  opened (window id, client). The poll keeps running while one is open and,
  when its window is gone, runs `display-popup -C -c <client>`. Up to 5 s
  late, accepted.

`TmuxClient` gains `clientFor(session)`, `switchTo(client, windowId)`,
`popup(client, window)`, `closePopup(client)` and `capture(windowId)`; the fake
records each and can fail each.

### New delegate

1. Pick an agent from the roster.
2. Task in the multi-line editor.
3. Optional label (one-line; empty means `<agent>-<short id>`), validated as
   `--label`.
4. A settings screen (pi-tui `SettingsList`), Start first, every row the
   agent's default:
   - Model: filterable list of the registry's available models, the agent's
     default selected.
   - Thinking: only the levels the selected model supports,
     `getSupportedThinkingLevels(model)`; changing the model clamps the
     level with `clampThinkingLevel`, visibly.
   - Auto-exit: on/off.
   - Working directory: text, prefilled with the parent's cwd, validated as
     `--cwd`.
   - Worktree: branch name, empty for none; mutually exclusive with a
     changed working directory. Base, source and fallbacks stay command-only.
5. Start launches through the same `launch` as `/delegate`, in the
   background, with the usual start message. No automatic popup.

`@earendil-works/pi-ai` joins `peerDependencies` (`"*"`, host-supplied per
Pi's `docs/packages.md`) and `devDependencies` (`1.3.0`, which exports both
functions). `/delegate --thinking`, `/delegate-resume --thinking` and the tools
keep accepting any level; the delegate's Pi clamps at start.

### Resume picker

`/delegate-resume` alone lists the delegations that pass **every** resume
check (`resume.ts` eligibility, with one `listWindows` for all), newest first.
Picking one opens the multi-line editor for the follow-up; model, thinking and
auto-exit are the delegation's. Then the same resume path as the command.

### Contract

README "Other extensions may rely on" gains `/delegates`, `/delegate-open`
and its flags, and the no-argument forms of `/delegate` and
`/delegate-resume`. `session:launch` and the `message:*` hooks are unchanged.

### Tests (fake tmux, scripted `ctx.ui`)

- Panel lists only open windows, newest first; empty state text.
- `enter` popups a companion window and switches for one in the parent's
  session; `--popup` behaves the same.
- Client choice: highest activity; none attached refuses popup and switch,
  not peek.
- Popup is not awaited; the poll closes it once its window is gone and keeps
  polling while one is open.
- Peek captures, refreshes, escalates to open.
- Close confirms only while running, and records the close.
- New delegate: the argv and record equal a `/delegate` with the same
  choices; thinking list per model and clamping on model change; cwd and
  worktree exclusive; invalid label and cwd refused before launch.
- `/delegate` and `/delegate-resume` with no arguments open their flows; with
  arguments, unchanged.
- Resume picker lists only eligible records and resumes the chosen one.
- `/delegate-open` parsing and completions.

`test/harness.ts` already scripts `select`, `editor` and `custom`; the panel
and form may need key-driven `custom` scripting added to it.

## Delivery

1. PR 1: `src/window-placement.ts`, `TmuxClient` and `FakeTmux` changes, the
   session in text and details, README, CHANGELOG (Changed), check-pack.
   Release as a minor version.
2. PR 2: `src/navigator.ts`, `src/new-delegate.ts`, the client, popup,
   switch and capture methods, the peer dependency, the commands and
   shortcut, README (contract list and a "Reaching delegates" section),
   CHANGELOG (Added), check-pack. Live test in tmux before merging: popup
   lands on the window, closes when the delegate auto-exits, switch and the
   return hint, a new delegate from the form.

## Open in the implementation

- That `select-window -t @N \; attach-session -t $N` in the popup shows
  `@N`, and what it does to other clients of the companion session.
- `switch-client` with several clients attached (only one was probed).

# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- Agents move to one file per agent in the agents folders Pi agent tooling
  shares: `<agent dir>/agents/<name>.md` and, when the project is trusted,
  `<cwd>/.pi/agents/<name>.md`, which replaces a global file of the same name.
  `<agent dir>/squire/agents/<name>/AGENT.md` is no longer read; while that
  folder exists, a warning says so. `squire/delegation_prompt.md` stays where
  it is.
- The body is now wrapped in `<agent_instructions>` lines by default
  (`prompt_mode: append`). `prompt_mode: replace` builds the delegate's prompt
  exactly as before.
- `exclude-tools` is removed; a file that still has it gets a warning and the
  delegate gets every tool. List the delegate's tools in `tools` instead.
- A `model` or `fallback` entry the model registry does not know is no longer
  skipped for the next candidate: it goes to the child's `--model` unchanged,
  and Pi reports it if it cannot resolve it.
- A delegate whose agent has no `tools` field now gets the parent session's
  active tools when the launch or resume starts, passed as `--tools`, instead
  of Pi's default tools. An empty `tools` field (`tools:` or `tools: []`) now
  means no tools except the `delegateTools` setting, and `--no-tools` when that
  is empty too; it used to mean the parent's tools.
- A delegate now gets exactly its selected tools, MCP tools included. Pi
  kept every MCP tool registered, callable from `codemode` and loadable by
  `tool_search`, unless a `--tools` entry started with `mcp__`; pi-squire now
  adds the entry `mcp__`, which names no tool, to a list with no such entry,
  so an MCP tool reaches a delegate only when its tools (or the parent's, for
  an agent without `tools`) name or match it. Name a server's tools, such as
  `mcp__docs__*`, to keep them. Tests changed with it: the argv tests in
  `test/agent-files.test.ts`, `test/delegate.test.ts` and
  `test/resume.test.ts` now expect the extra `mcp__` entry.
- Migration: move each `<agent dir>/squire/agents/<name>/AGENT.md` to
  `<agent dir>/agents/<name>.md`; add `prompt_mode: replace` to keep today's
  prompt; replace `exclude-tools: a, b` with a `tools` line naming the tools
  the delegate should have.

### Added

- An agent whose file is invalid is disabled: it is left out of the roster
  and of the `delegate` tool's description, a warning names the file and the
  reason when the session starts (and before a run, for a file that turns
  invalid meanwhile), and a call or resume that names it is refused with that
  reason instead of "no agent named".
- Every agent field is optional: `description` defaults to the name, an absent
  `model` or `thinking` runs on the parent session's current model or level,
  and an unknown `thinking` is dropped with a warning instead of leaving the
  agent out. `model` and `fallback` entries may be aliases such as `sonnet`,
  each resolving to one model; a `*` pattern makes the file invalid, so the
  agent is disabled. A body may be empty.
- New agent fields: `display_name` (shown on the delegate card, in
  `/delegates` and in the window title; it may hold only ASCII letters,
  digits, `-` and `_`, and any other value, a space, `#`, `.`, a non-ASCII
  letter or an empty value among them, makes the file invalid, so the agent is
  disabled), `enabled: false` (leaves the agent
  out; a project file hides a global agent of the same name), `locked` (`true`
  or a list of `model` and `thinking`: a call or resume that passes a locked
  field runs on the agent's value, and the result says which agent locked
  which field; passing the agent's own value is the same as passing nothing,
  so its fallbacks still apply; a resume runs a locked field on the file's
  current value, not on what the delegate last ran on) and `prompt_mode`.
  Keys pi-squire does not use, such as `max_turns` or another extension's
  policy, are ignored without a warning.
- The `delegateTools` setting in `<agent dir>/squire/settings.json`: tool
  names or `*` patterns added to every delegate's tools, from its agent's
  `tools` or the parent's, for the tools a `message:*` provider gives a
  delegate to reach its parent. Empty by default.
- A `tools` line of only `-name` entries (`tools: -bash, -write`) gives the
  delegate the parent session's tools less those (a `-name` entry may be a `*`
  pattern), then the `delegateTools` setting. A `+name` entry, or tool names
  and `-name` entries mixed, make the agent file invalid, so the agent is
  disabled. pi-squire always passes the child a plain `--tools` list.
- A `delegateTools` entry that starts with `+` or `-`, or holds a comma,
  refuses every launch and resume with an error naming the settings file,
  before the task is sent or a window opens.
- A `tools` or `fallback` YAML list entry holding a comma, such as
  `tools: ["read,-bash"]`, makes the agent file invalid, so the agent is
  disabled with a warning naming the file and the reason. A comma-separated
  line (`tools: read, bash`) and a list of single names still work.
- A resume without `thinking`, for an agent that does not lock it, now runs
  on the level the delegate last ran on, read from its session (the last
  thinking-level change on the active branch, such as a change the user made
  in the delegate's window or a clamp to a new model), instead of the level
  recorded when the delegation started; the recorded level remains the
  fallback when the session has none.
- A tool that only an agent's own `extensions` register reaches its delegate
  only when the agent's `tools` list or the `delegateTools` setting names (or
  matches) it. With no `tools` field, or only `-name` entries, the baseline
  is the parent session's active tools alone; pi-squire never loads an
  agent's extensions in the parent. (An unreleased change on this branch had
  loaded them in the parent to add their tools to that baseline; its tests in
  `test/agent-files.test.ts` and `test/pi-tools.test.ts` now pin this rule
  instead.)
- A running delegate that hits a usage limit now resolves a `fallback` entry
  that is an alias or bare id (such as `sonnet`) to one model with Pi's
  `--model` resolver, in the listed order, instead of skipping every entry
  that is not an exact `provider/id`. Each model is tried once, never the one
  that just failed.

### Removed

- The delegate popup: `enter` in `/delegates` and `/delegate-open --popup` no
  longer open a tmux popup, and the popup title from 0.13.1 (the close key in
  its title) goes with it. `--popup` is now an unknown-flag usage error. The
  poll runs again only while a delegation is running. The close hint was hard to
  see in some themes, and a switch covers the need.

### Changed

- `enter` in the `/delegates` panel, and in its peek, now switches your tmux
  client to the delegate's window (the notice says your tmux last-session key returns you); `/delegate-open
  <id>` with no flag switches too. The `s` key is gone. With no client attached,
  switch still refuses; peek and close still work. tmux 3.2 stays the minimum,
  for `new-session -e`.
- Tests changed with it: in `test/navigator.test.ts` the panel hint, `enter`,
  peek, no-client, failure, `/delegate-open` parsing, default and completion
  tests now expect a switch, and the popup lifecycle tests are replaced by one
  test that the poll runs only while a delegation does; `test/tmux.test.ts` no
  longer tests `popup` and `closePopup`, and `test/popup-parent.ts` and the
  fake's popup support are gone.
- Tests changed with the agent files: the harness writes `agents/<name>.md`
  and the retired fixture to `squire/agents/<name>/AGENT.md`; prompt
  assertions expect the `<agent_instructions>` wrapper; the roster, empty-roster
  and malformed-file tests in `test/delegate.test.ts` and `test/tools.test.ts`
  follow the optional fields and new location; the fallback render test skips
  a model without credentials rather than an unknown one; the `display_name`
  test names its agent `Code_Reviewer-2`, since a space is no longer accepted;
  and `test/exclude-tools.test.ts` becomes `test/agent-files.test.ts`.
- Tests changed with tools inheritance: the test that pinned an empty `tools`
  field as the parent's tools now pins it as no tools; the argv tests in
  `test/delegate.test.ts` expect the parent's tools as `--tools`; and an
  invalid `delegateTools` now refuses an agent without a `tools` field too.

## [0.13.1] - 2026-10-27

### Changed

- A delegate's popup title names the key that closes it, with your tmux prefix,
  for example `scout-first · C-b d to close`.

## [0.13.0] - 2026-10-26

### Added

- `/delegates`, also on `alt+shift+d`, opens a panel of the delegations whose
  window is open (newest first): `enter` opens one in a tmux popup, or switches
  to it when it is in your own session; `p` peeks at its pane in an overlay (`r` refreshes,
  `enter` opens); `s` switches your client to it; `x` closes it, asking only
  while it runs; `n` opens the new-delegate form. `/delegate-open <id> [--popup|--switch|--peek]` does one of
  these directly. Popup and switch act on the most recently active client of the
  parent's session; the parent closes a popup once its delegate's window is gone.
  Commands and a shortcut only: the model gets no new tool.
- `/delegate` with no arguments opens a new-delegate form: pick an agent, write
  the task, name it, then a settings screen for model, thinking level (only the
  levels the model supports, clamped, visibly, when the agent's default or a new model does not support it), auto-exit,
  working directory and worktree. It launches through the same path as the
  typed command. `/delegate-resume` with no arguments opens a picker of the
  delegations that can be resumed, then an editor for the follow-up. Typed
  commands and the tools are unchanged; the two commands no longer print
  their usage when typed bare.
- `@earendil-works/pi-ai` is now a peer dependency (`*`), supplied by Pi.

## [0.12.0] - 2026-10-26

### Changed

- Delegates open in a companion tmux session, `<your session>-squire`, instead
  of your own session, created on demand and removed by tmux with its last
  window. pi-squire marks the session it creates (tmux session option
  `@squire-companion`), so only a marked session counts as a companion: your
  own session called `pi-squire` gets `pi-squire-squire`. Set
  `"windowPlacement": "current"` in `<agent dir>/squire/settings.json` to open
  them in your session as before; any other value refuses the launch.
  The start message, `delegation_status` and the delegate card name the session,
  and the `delegate` and `delegation_resume` results and the status details gain
  an optional `windowSession`. `session:launch` is unchanged.
- tmux 3.2 or later is now required (it was 3.0); `/delegate`, `/delegate-resume`
  and the tools refuse an older tmux with its version.

## [0.11.0] - 2026-10-26

### Added

- The `session:launch` payload gains a read-only `toolCallId`, the ID of the
  `delegate` tool call that started the launch, so a listener can tie a
  delegate's window to that call. It is `undefined` for a launch from the
  `/delegate` command.
- `delegation_resume` and `/delegate-resume <id> [--model …] [--thinking …] [--auto-exit|--no-auto-exit] <task>` reopen an exited delegate's own session (`pi --session <path>`) in a new window with a follow-up task. The resume is recorded as a new delegation with `resumedFrom`; mail, replies and usage-limit marks use the delegation's session id, so records from before resuming read as before. A delegate whose working directory is gone, one still running, one whose window is open and an older delegation of a resumed chain are refused. `delegation_status` shows `resumed from` and `resumed as`, results and closed-without-a-result messages name `resumedFrom`, and the latter point to `delegation_resume`. The `delegate` tool's description mentions it, and `--session` joins the launch invariants listed for `session:launch`. A resume emits `session:launch`
  too, with `toolCallId` set to the `delegation_resume` call, or `undefined`
  from `/delegate-resume`; unlike a launch's, it comes before the task is sent,
  because a resume mails the task only once its window is open (mail for a
  window that never opened would otherwise reach the next resume as a second
  task; a failed send kills the new window). A resumed delegation is never
  reported closed without a result.

## [0.10.0] - 2026-10-24

### Added

- `/delegate --worktree-source <dir>` and the `worktree_source` input select another existing Git checkout as the frozen base and trust identity for managed worktrees. Unresolved protected resources in that planned checkout require the parent's decision before creation.

- `/delegate --worktree-base <commit-ish>` and the `worktree_base` tool input create managed branches from an explicitly resolved local commit. Resolution is frozen, never fetches, and supports valid explicit commits from an unborn source checkout.

- Managed worktree placement can be configured per call in
  `<agent dir>/squire/settings.json` with a global `worktreeRoot` template and
  canonical-main-repository `worktreeRootByRepo` overrides. Placement settings
  affect only worktree creation; inherited and `cwd` launches never read them.
- `/delegate --worktree <branch>` and the `delegate` tool's `worktree` input
  create a managed worktree from the source checkout's frozen committed HEAD,
  in the built-in sibling `{repo}-worktrees/{branch}` layout. Source dirty
  paths are summarized but never copied. Launch attempts are journaled before
  creation; known pre-window failures roll back only a proven pristine checkout
  and branch, while uncertain or changed resources are retained with recovery
  facts. Once a window opens, the workspace is retained. Managed workspace
  facts appear in results, status and expanded rendering.
- The `session:launch` payload gains a read-only `cwd`, the directory the
  delegate's window opens in. The window opens there whatever a listener
  assigns; appending args and adding env keys work as before. The README
  example and its test read it.
- Each delegation records its working directory and session-storage
  directory. The `delegate` tool's structured result carries `cwd` and
  `sessionDir`; `delegation_status`, result and closed-without-a-result
  messages and their expanded views show the working directory, and older
  records show it as `unknown (not recorded)`.

- `--cwd <dir>` on `/delegate` and `cwd` on the `delegate` tool run a
  delegate in an existing directory: relative to the parent's, `~`/`~/`
  expanded, symlinks resolved, refused before anything starts when it is
  missing, a file or cannot be entered. The directory's branch, index and
  files are never touched or cleaned up. Placeholder values (`null`, `""`,
  `"null"`, `"none"`, `"false"`, `"undefined"`) mean the parent's directory;
  other non-string values are refused. The delegate's prompt names the
  selected directory, and the start message names it when it differs.
- Project trust for a `--cwd` directory is decided in the parent: the parent's
  current trust inside its own repository (by Git common directory), else the
  saved decision for a linked worktree's main repository or for the directory,
  else `--no-approve` when it has no protected resources, else a parent
  dialog with Pi's five choices. Without a UI, after a cancel or an abort, or
  when the trust store cannot be read or written, nothing starts. Dialogs are
  asked one at a time.
- Each new delegation records a `workspace` (mode, cwd and Git checkout at
  launch: identity, branch or detached, launch commit, or non-Git, or unknown
  with a reason). The `delegate` tool's structured result, `delegation_status`,
  result and closed-without-a-result messages and their expanded views carry
  it; result and closed text gain a `Workspace:` line, and status text a
  `workspace:` line. The pinned record, result-text and completion tests
  change with it.

- Results and `delegation_status` report a snapshot of the delegation's
  checkout (`workspaceSnapshot`): branch or detached HEAD, head, launch
  commit, commits since launch, committed paths since launch, and staged,
  unstaged, untracked and conflicted paths, or non-Git, or unknown with a
  reason. A result keeps the snapshot taken when its reply arrived; status
  takes a fresh one each call. Lists are capped at 100 paths and 16 KiB with
  totals; Git gets 2 s per command, 5 s and 4 MiB per checkout, runs without
  optional index writes, and is asked only about the recorded checkout. A
  snapshot is an observation of the Git state at the recorded location, not
  proof of the same repository on disk, attribution or merge advice. Result text
  gains `Checkout when the result arrived:` lines and status text
  `checkout now:` lines; the pinned result entry, details and result-text
  tests change with it.

### Changed

- `/delegate` flag values may be double-quoted, with `\"` and `\\` escapes,
  so a path with spaces works; the task after the flags is kept byte for
  byte. A missing closing quote is refused before anything starts.
- Every delegate is launched with an explicit `--approve` or `--no-approve`
  from the parent's current project trust, so a global
  `defaultProjectTrust` cannot trust a project the parent does not.
- Every delegate is launched with `--session-dir` set to the parent's absolute
  session-storage directory. Session lookups for running, closed and late
  results use the directory recorded at launch, so they survive a parent that
  resumes with another storage directory, and a found session path is kept
  in the closed-without-a-result record. A parent whose session directory is
  not absolute refuses to launch before sending the task. The launch argv and
  record tests change with it.

## [0.9.5] - 2026-10-23

### Changed

- A delegation is drawn as one tool call that changes state, in the style of
  pi-interactive-subagents, replacing the 0.9.2 to 0.9.4 look: the `delegate`
  row shows `○` with the agent, label and task while the call runs, and one
  header, `● <name> (<model>) — started`, once the delegate starts; the result arrives as a
  finished tool row on Pi's tool success or error background, `✓ <name> (<model>) — done` or `✗` with the status,
  with a 5-line preview. The renderer tests change with it.

## [0.9.4] - 2026-10-23

### Changed

- The `delegate` tool's row is drawn in the same style as the result message:
  a call line naming the agent and label, then a ◐ header with the delegate's
  name and model, a task preview and any skipped fallback models; expanded,
  the whole task and the delegation id, window, thinking and auto-exit. The
  text the model reads is unchanged.

## [0.9.3] - 2026-10-23

### Changed

- A collapsed delegate result previews its first 3 non-blank lines, in a
  brighter color, with heading marks, backticks and bold stripped. Expanded,
  the result comes right after the task under a `Result` label, and the ids
  and files move to the end with the home directory shown as `~`. The
  renderer tests change with it.

## [0.9.2] - 2026-10-22

### Changed

- A delegate's footer shows its agent name in the theme's accent color.
- Delegate results and closed-without-a-result messages are drawn with a
  header (status icon, delegate name, model) and, collapsed, the first 3
  lines of the result; expanded, the ids and files, the quoted task and the
  result as Markdown. The text the parent model reads is unchanged apart from
  the model. Messages from before this change show as plain text. The
  renderer tests change with it.

### Fixed

- A delegate that finished on a different model than it launched on (a
  fallback, or `/model` in its window) is now shown as `launched → finished`
  in the result, the closed-without-a-result message and `delegation_status`,
  read from the delegate's session file. It used to name the launch model.

## [0.9.1] - 2026-10-22

### Changed

- A delegate's footer names its agent, as in `👦 worker delegate · auto-exit on`.
  The launch passes the agent name to the delegate as `PI_DELEGATE_AGENT`.

## [0.9.0] - 2026-10-21

### Breaking

- Agent definitions now live under `<agent dir>/squire/agents/<name>/AGENT.md`,
  and only there. The old `<agent dir>/agents/<name>/AGENT.md` location is no
  longer read, with no fallback or dual discovery, so an agent left there is
  neither listed nor launched.
- Pi 1.3.0 or later is now required. The raised floor supports structured
  per-run system-prompt sections and `before_agent_start` preparation for runs
  started by an idle custom-message result, so parent guidance and roster
  metadata are current before each new run.

### Added

- Optional parent delegation guidance: Markdown in
  `<agent dir>/squire/delegation_prompt.md` is inserted unchanged into the
  `squire_parent_delegation` system-prompt section before each new run, only
  while the `delegate` tool is active and not hidden. Missing, empty or deleted
  files add no guidance; a read failure warns with the path, removes stale
  guidance for that run, and leaves delegation working. The package ships no
  default delegation or approval policy.
- The `delegate` tool description now refreshes from the current roster before
  each new run, including a run woken by an idle delegate result. A changed
  agent description, addition or removal shows up in the run being prepared;
  unchanged metadata is not re-registered.

### Changed

- The `delegate` tool now says to keep working or end the turn rather than poll
  or send a blocking mail request merely to wait for a result, while a
  substantive follow-up remains supported.

## [0.8.1] - 2026-10-20

### Fixed

- A 429 whose text says the endpoint is unavailable, such as OpenCode Go's
  `429: Endpoint is unavailable`, no longer marks the provider as
  usage-limited. It is an outage, not a used-up quota, so `/delegate` keeps
  launching on the provider instead of refusing it for five minutes or more.
  Pi has already retried the request by then. A running delegate that hits
  it moves to its next fallback model and carries on, as it does on a usage
  limit.

## [0.8.0] - 2026-10-20

### Added

- A delegate's footer shows that it is a delegate and whether auto-exit is
  on: `👦 delegate · auto-exit on`, or
  `👦 delegate · auto-exit off`. It follows the
  setting as typing turns it off and `/auto-exit` turns it back on.

### Changed

- The parent's footer reads `👨 N delegates running` instead of
  `⇄ N running`. Each side picks its icon at random per session: 👨 or 👩
  for the parent, 👦 or 👧 for a delegate. The footer tests in
  `test/delegate.test.ts` change to match.

## [0.7.0] - 2026-10-19

### Added

- `delegate`, `delegation_status` and `delegation_close` declare an
  `outputSchema` and return matching `structuredContent`, so a codemode
  script gets objects instead of text. `delegation_status` gives each
  delegation its derived `state` (`running`, `done`, `gone`, `closed`,
  `window-closed` or `unknown`), also added to its details.
  `delegation_close` returns one shape on every path:
  `{ id, windowId, windowName, closed, alreadyClosed, killed }`; its details
  gain the fields each path lacked. The model-facing text is unchanged.
- The three tools declare MCP-style `annotations`: `delegation_status` is
  read-only and idempotent; `delegation_close` is destructive and idempotent;
  `delegate` is neither, and is the only one that reaches an open world,
  since the delegate it starts calls a remote model and runs tools
  unattended.

## [0.6.0] - 2026-10-15

### Added

- Every delegate now starts with `PI_UNATTENDED=1` in its environment, a
  general signal that no human is watching the session. Delegates run as a
  full TUI, so extensions that open a dialog, such as a handoff gate or an
  approval prompt, waited on nobody and stalled the delegate; they can read
  this variable to skip the dialog instead. The test that pins the child's
  exact environment now includes it.

## [0.5.1] - 2026-10-14

### Changed

- The `delegate` tool's description now tells the parent to keep working or
  end its turn while a delegate runs, since the result starts its next turn
  on its own; the launch message says the same in place of pointing at
  `delegation_status`. GPT parents asked their own delegates for the result
  with `session_mail_ask`, so each report arrived twice.
- The `delegation_status` description now says to call it to check on a
  delegation that seems stuck or to find its files, not to wait for a result,
  which arrives as a message on its own.

## [0.5.0] - 2026-10-13

### Changed

- A delegate is now told to put its findings in its final message and to
  message the parent before then only with a question it cannot continue
  without. Delegates mailed progress and findings that the result then
  repeated, so the parent read the same report twice.
- A delegate's result now reaches a busy parent as a steer, after its current
  tool calls and before its next model call, instead of as a follow-up once
  its run ends. Queued until then, the result arrived after the parent had
  read the envelope itself and answered, and cost a redundant turn.
  `delegation_status` now says a done result arrives as a message on its own.
  `test/delegate.test.ts` pins `steer` in place of `followUp`.

## [0.4.0] - 2026-10-13

### Added

- A delegate whose run ends on a usage limit now switches to the agent's next
  fallback that has credentials and is not marked, and continues the task in
  the same session instead of failing. The parent passes the candidates after
  the launched model as `PI_DELEGATE_FALLBACK`; an explicit `model` passes
  none. A `done` result from such a delegate carries the `Usage limit:` line,
  saying it finished on a fallback.

### Changed

- A delegate message in the chat now shows collapsed, as its first two
  lines, and expands with the tool-output toggle (Ctrl+O), in step with tool
  output. The model still gets the whole message.
- With auto-exit on, a delegate whose run fails on any provider error now
  closes its window, as after a normal completion; before, only a usage-limit
  failure did. The parent still gets the `failed` reply and the session file
  stays. Only a run the user stopped keeps the window open.
  `test/auto-exit.test.ts` and `test/harness.test.ts` change with it.
- Refusing an explicit `model` that is usage-limited now names the agent's
  models that are still open, so the caller can omit `model` and let the
  fallbacks apply.

### Fixed

- ChatGPT's "The ChatGPT user has reached their Subscription Sharing usage
  limit" error now counts as a usage limit, so it records a mark and later
  launches skip the provider. Before, it recorded nothing.

## [0.3.2] - 2026-10-09

### Added

- Agent frontmatter `extensions` lists extension paths loaded only by that
  agent's delegate, each passed to its Pi as `-e` on top of its normal
  extensions. `~` expands and relative paths resolve against the `AGENT.md`'s
  directory; a path that does not exist leaves the agent out with a warning.
- Agent frontmatter `tools` lists the delegate's visible tools, passed as
  `--tools`. Without discovery tools such as `codemode` or `tool_search`, only
  listed tools are visible; Pi can keep unlisted MCP tools registered unless
  the list includes an `mcp__` entry, and discovery tools can expose them.
  Names are not checked against the parent's tools, and `exclude-tools` still
  applies alongside.

### Fixed

- The `delegate` tool treats `null` or the string `"null"` in `model`,
  `thinking` or `label` as unset, so the agent's defaults apply. Before, a
  `null` model crashed the call and `"null"` was refused as not provider/id.

## [0.3.1] - 2026-10-03

### Changed

- With auto-exit on, a delegate whose run ends on a usage-limit error now
  closes its window, as after a normal completion. The parent still gets the
  `failed` reply and the session file stays. Other failures still leave the
  window open. `test/harness.test.ts` now fails its run with a `400` instead
  of a `429`, since a `429` is a usage limit and now exits.

## [0.3.0] - 2026-10-03

### Added

- A delegate whose run ends on a usage-limit error (a quota message, or a
  `429` that survived Pi's retries) records a mark in
  `pi-squire-limits.json` in Pi's agent directory. Every Pi session then
  refuses to launch a delegate on a marked model until the mark clears.
- A usage-limit mark clears at the reset time in the failed response's headers
  (`retry-after`, `anthropic-ratelimit-*-reset`, `x-ratelimit-reset-*`) when
  Pi reports them, ahead of the time in the error text.
- An agent's `fallback:` frontmatter (comma-separated or a YAML list of
  `provider/id`) names models to launch on, in order, when its `model` is
  usage-limited or unusable. The tool result and the command notice name the
  substitute and the skipped model; the call is refused only when every
  candidate is skipped. An explicit `model` is never substituted.
- A `failed` result from a delegate that recorded a usage-limit mark gets a
  `Usage limit:` line after `Status:`, naming the scope and clear time.
  `delegation_status` ends with a `Usage-limit marks:` block of the active
  marks, and its details gain `marks`.
- `/delegate-clear <all|provider|provider/model>` removes usage-limit marks and
  their repeat-hit history. An argument matching no active mark changes
  nothing and lists the active marks. No tool can clear marks.
- Before a launch on a paid `opencode-go` model, pi-squire reads the OpenCode
  Go quota (cached for 60 seconds). A window at 100% or `rate-limited` skips
  the model and records a `proactive` mark that clears at the window's reset
  time. A failed reading never blocks a launch: the result and notice say
  "Could not read opencode-go quota: …; launched without a proactive check.",
  and `delegation_status` shows the error in `readingErrors` until a later
  reading succeeds. `/delegate-clear` also drops the cached reading. A proactive
  mark that cannot be written does not stop the launch.
- Before a launch, pi-squire reads Claude Code's usage cache for an
  `anthropic` candidate on a Claude subscription login and skips it when its
  5-hour or 7-day window is at 100%, or its model-scoped week is and names that
  model. A stale cache is refreshed in the background with
  `claude -p /usage`, at most every 5 minutes, without delaying the launch.
- A usage-limit mark clears early when a launch considers the marked
  `opencode-go` or OAuth `anthropic` candidate and a re-check (at most every
  10 minutes per provider) shows every window under 100% and a window cycle
  that began after the mark was recorded. Headroom alone never clears a mark,
  and a model-scoped mark on `opencode-go` never clears early.
- `delegation_status` shows how long ago a running delegate last wrote its
  session file, at the end of its `state:` line (`last active 12 min ago`),
  and adds the same moment to its details as `lastActiveAt`. A long gap may
  mean the delegate is stuck but does not prove it.

### Fixed

- A tmux call that hangs now fails after 10 seconds with
  `tmux <subcommand> timed out after 10 s`, instead of hanging `delegate`,
  `delegation_status`, `delegation_close` and the background poll.

## [0.2.2] - 2026-10-02

### Fixed

- The README links `CONTRIBUTING.md` on GitHub, since it is not in the npm
  package and its relative link 404s on pi.dev.

## [0.2.1] - 2026-10-02

### Fixed

- A delegate's task now arrives as a user prompt labelled `[delegate]` instead
  of a `[mailbox]` message. Pi 1.0.0 started the injected message's turn
  without the system prompt, so a fresh delegate saw no context files, skills
  or role paragraph until after its first tool call, and could reject them as
  an injection (earendil-works/pi#5581).

## [0.2.0] - 2026-10-02

### Breaking

- A model without configured credentials is refused, by `/delegate` and the
  `delegate` tool alike, instead of failing in the delegate's window.
- A reply counts as a delegation's result only when it comes from the delegate
  (`envelope.from` equals the delegation's id); a reply to its request from any
  other sender is left to the provider as ordinary mail.
- Providers must set `envelope.from` to the sender's address.
- The `reply()` fixture in `test/poll.test.ts` now sends the delegation id as
  `from` instead of `"d"`, to match.

### Changed

- The sources moved to `src/`, so load the package directory (`pi -e .`), not
  `index.ts`. Installs through npm or git are unaffected.
- Each check (a poll tick, a `delegation_status` call, a `delegation_close`
  call) asks tmux once, however many delegations run, instead of once per
  delegation.
- The appended system prompt reaches the delegate as a path to a private file
  under the system temporary folder, so its text stays off the command line
  and out of `ps`. A `session:launch` listener now sees that path where the
  prompt text was. The argv tests in `test/delegate.test.ts` read the prompt
  from the file instead of from argv, a deliberate behaviour change.

### Fixed

- `delegation_status` details name a labelled delegation's session
  (`scout-roster`), as its text does, instead of `<agent>-<first 8 of the id>`.
- A recycled tmux window id is no longer mistaken for a delegate's window, nor
  killed: a window counts as the delegate's only when its id and its name both
  match.
- A delegate whose program exited in a window kept open (`remain-on-exit`)
  reads as gone instead of running.

### Added

- `session:launch` payloads carry the agent's name as `agent`.
- The README's Install section names its requirements: tmux 3.0 or later, Pi
  0.80.5 or later, the first installable release with `agent_settled` (tested
  with Pi 1.0.0), macOS and Linux, and
  `pi install npm:pi-session-mail` as an example `message:*` provider.
- A README "Compatibility" section names the contracts other extensions rely
  on, the below-1.0 rule that breaking one bumps the minor version, and what a
  `message:*` provider must do.

## [0.1.0] - 2026-10-02

The first public release. Before this repository the package lived in its
author's dotfiles; the changes below are against that copy.

### Added

- Published to npm as `pi-squire`.
- MIT license and package metadata, including `engines` (Node 22.19 or later).
- CI on Node 22.19 and 24: lint, typecheck, tests, and a check of the
  published file list.

### Fixed

- The published file list includes `child.ts`, which `index.ts` imports.

[Unreleased]: https://github.com/gvanderclay/pi-squire/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/gvanderclay/pi-squire/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/gvanderclay/pi-squire/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/gvanderclay/pi-squire/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/gvanderclay/pi-squire/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/gvanderclay/pi-squire/compare/v0.9.5...v0.10.0
[0.9.5]: https://github.com/gvanderclay/pi-squire/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/gvanderclay/pi-squire/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/gvanderclay/pi-squire/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/gvanderclay/pi-squire/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/gvanderclay/pi-squire/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/gvanderclay/pi-squire/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/gvanderclay/pi-squire/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/gvanderclay/pi-squire/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/gvanderclay/pi-squire/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/gvanderclay/pi-squire/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/gvanderclay/pi-squire/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/gvanderclay/pi-squire/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gvanderclay/pi-squire/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/gvanderclay/pi-squire/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/gvanderclay/pi-squire/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/gvanderclay/pi-squire/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/gvanderclay/pi-squire/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gvanderclay/pi-squire/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gvanderclay/pi-squire/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gvanderclay/pi-squire/releases/tag/v0.1.0

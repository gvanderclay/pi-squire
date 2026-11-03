# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- `delegation_close` records the close without posting a cancellation message or
  waking the model. UI closes still wake the model. The tool close regression in
  `test/tools.test.ts` now expects silence, and the stopped-root cancellation test
  in `test/subtree-close.test.ts` uses the UI close path to retain its wake check.
- Enter in the focused compact delegate widget switches straight to the selected
  delegate's verified tmux window. A dim hint explains how to focus the list;
  focused hints show the selected row's keys. Widget navigation and rendering
  tests now expect direct switching instead of the details panel. Ancestor and
  activity layout tests include the new hint; the nested widget test replaces
  removed branch-detail browsing with a direct switch assertion.

## [0.20.1] - 2026-11-02

### Changed

- `delegation_fork` warns when its effective model differs from the source's
  last model: copied context will be written to a new cache, with an approximate
  token count when source usage is available. The model parameter and README
  explain the cost; same-model forks retain their cache behavior. New fork tests
  cover changed/same models, effective model locks and missing or invalid usage.

## [0.20.0] - 2026-11-02

### Added

- `delegation_fork({ id, task })` starts a new delegation from a direct child's
  session context using `pi --fork`, leaving the original session and window
  untouched. It runs in the child's folder or a new managed worktree, inherits
  resume-style model/thinking/auto-exit defaults, and reapplies current roster,
  nesting, capacity and trust checks. New records, status and results carry
  `forkedFrom`; replies use the new session's own address. The metadata budget
  test increases from 10,000 to 12,000 characters to cover the fifth tool.
  Managed forks report their cwd, branch, base and uncopied changes, and their
  prompt directs them away from the original checkout; non-isolated forks warn
  about sharing a folder with a running source. Dashboard details show the
  source id, foreign callers get an explicit direct-parent refusal, and the
  fork tool declares its destructive-operation hint.

## [0.19.1] - 2026-11-02

### Removed

- Fresh sessions no longer report other sessions' running delegates at
  startup, and the "owner discovery unavailable" and "discovery is limited"
  warnings are gone with that check. A session only ever reports its own tree;
  to collect the delegates of a session you closed, reopen that session. The
  tests that pinned the startup notices now pin that a fresh session reports
  nothing, and the notice-budget tests are removed.

## [0.19.0] - 2026-11-02

### Changed

- **Breaking:** Pi 1.5.0 or later is now required. Delegate result expand hints use Pi's
  configured keybinding, and the inline delegate dashboard and new-delegate
  settings form report that Pi is waiting for a choice. The render tests now
  require the configured key in the hint instead of accepting a missing key;
  dashboard and form tests pin their blocked-input status. The active-tools
  test fake now preserves retained tools' order, matching Pi 1.5.

## [0.18.4] - 2026-11-02

### Fixed

- Fresh-session owner discovery no longer warns that tmux could not be asked
  when tmux answered but a busy startup held its answer past the 200 ms notice
  budget. Discovery now runs after `session_start` returns instead of holding
  it, the tmux listing is bounded by the tmux client's own timeout, and the
  200 ms budget covers only the registry scan after it. The warning now carries
  tmux's error message, and the newest-tree sort reads each registry's
  modification time once. Tests that read discovery notices now wait for them.

## [0.18.3] - 2026-11-01

### Changed

- Model-facing delegate completion messages link the task copy instead of
  quoting it, omit the workspace launch summary, and keep only the checkout
  summary without path categories. Result bodies, errors, identity and file
  pointers are unchanged. Task previews, workspace facts, and full snapshots
  remain in saved message details and the expanded view. Tests that pinned the
  previous model-facing wording now assert this shorter projection.

## [0.18.2] - 2026-11-01

### Fixed

- Agents without a `tools:` field inherit available deferred and codemode tools
  from root sessions, just as they already did from nested delegates. Inactive
  direct tools and hidden tools remain excluded. Pi initially declares the
  selected tools in the child; extensions that enable optional tools on demand
  must deselect them during child startup. This can increase initial declarations
  for root-launched delegates whose extensions do not deselect those tools.
- Creating a companion session no longer saves the first delegate's environment,
  including `PI_UNATTENDED` and API keys, into the session for later windows to
  inherit. Each delegate still receives its own launch environment. Existing
  polluted sessions are not changed. The fresh-companion argument test now pins
  window-local environment delivery instead of session-level `-e` options.
  Launches still pass only Squire's environment and `session:launch` additions,
  never a copy of the parent's full process environment.
- tmux failures report a bounded subcommand error instead of raw process errors
  or stderr that could expose launch arguments or environment values. The two
  failed ownership-recheck tests now expect the bounded error wording.
- The discovery-count regression uses a controlled clock so additional parallel
  test load does not turn its structural count assertion into a timing failure.
  The separate real-time discovery deadline test and 200 ms product bound are
  unchanged.

## [0.18.1] - 2026-11-01

### Changed

- The delegation tools put about 70% less text in a model's context: in a
  codemode root their declarations drop from about 5,100 estimated tokens to
  about 1,400. The descriptions and parameter notes are shorter, and the output
  schemas carry no field descriptions. `workspace`, `workspaceSnapshot`, and a
  workspace attempt's `plan` and `attempt` are declared by their discriminant
  and directory only, with their other fields left open; the structured data
  itself is unchanged. Tests that pinned the old wording are updated.
- A delegate's appended prompt is its agent body and working-directory line
  only. The paragraph naming the parent's address and the final-message rule
  are in the per-run `squire_delegate_task` section alone, where they were
  already repeated.

## [0.18.0] - 2026-11-01

### Changed

- New root companion sessions deliberately default to `<project>-delegates`
  instead of `<project>-delegate-session`. Set `companionSuffix` in
  `<agent dir>/squire/settings.json` to use another suffix, such as `playpen`.
  Existing companions and saved identities keep their names, including for
  nested launches and resumes.

## [0.17.0] - 2026-11-01

### Breaking

- Nested launches and resumes no longer cap a child's tools to its direct
  parent's. A nested child gets the tools its own agent file gives, as at top
  level, and `session:launch` additions are no longer cut back afterwards; the
  `allow_nested_delegation` list is the boundary. A read-only child started by
  a writable parent now keeps tools such as `grep` that the parent lacks. The
  "Nested tool ceiling" notices are gone. Tests that pinned the ceiling now pin
  the new behaviour.

### Added

- `toolBundles` in `squire/settings.json` names shared tool lists; an agent's
  `tools` field uses one as `$name`, for example `tools: [$readonly, pstack_models]`.
  An unknown bundle, a `-$name` entry or an invalid setting disables the agent
  that uses it.

## [0.16.0] - 2026-11-01

### Breaking

- `delegation_close` now closes a persistent descendant subtree rather than one
  local window. Its structured result adds `complete` and per-member outcomes;
  partial failures return `isError:true` with details rather than discarding
  successful members in a thrown tmux error. Close requires a readable shared
  fence before kills. Old single-window wording/schema, direct-close-on-corrupt-
  registry, panel/poll/placement text assertions deliberately change; local
  genuine result publication remains warning-only. Unknown/foreign/obsolete
  target ids refuse before effects. Canceling unfinished children now requires
  direct-parent processing rather than silently releasing the task barrier.
- Delegations recorded without the required original-root placement identity
  can no longer be resumed after this update, including pre-nesting and
  identity-less records even when reopened by their original root. Resume tools,
  commands and picker refuse before trust, mail, exited-window kill, reservation
  or spawn effects. No legacy identity synthesis or migration is provided.
  The subtree-close identity-less resume fixture now asserts this refusal when
  composed with root placement; its earlier fallback expectation is superseded.

- Require pi-session-mail 0.6.0 or another provider of all four message hooks.
  Upgrade mail and squire together: squire now owns delegate task settlement
  through `message:reply`; mail no longer automatically answers task requests.

- Agent frontmatter now uses `auto_exit` (boolean, default true).
  Old `auto-exit` and `extensions` fields are silently ignored, with no
  warnings or validation. In particular, old `auto-exit: false` now leaves
  auto-exit on unless `auto_exit` or a call override disables it.
  Agent-specific extension path resolution and launch arguments are removed
  for both launch and resume; normal Pi extension loading and `session:launch`
  customization remain. CLI flags, commands, internal fields and environment
  variables keep their names. Updated agent-file, auto-exit, delegate, real-Pi
  tool-selection, resume and hook tests for this deliberate contract change.

### Changed

- Complete branch-focused widget entry in the same dashboard: initial details
  retain their Escape-to-compact-list behavior, while `b` opens only the selected
  branch's descendant/resume history and worker details return to that list.
  Overall `/delegates` stays scoped to the invoking session's whole subtree.
  Root close-all remains explicitly all root subtrees, not only displayed rows.
- Dashboard switch/peek and `/delegate-open` now reuse positively verified
  current pane/server/owner locators for reattached latest sessions, without
  rewriting historical launch/result facts or changing close authority.
  A lost or replaced current locator never falls back to an old still-open
  window; peek captures the exact verified Pi pane. Details distinguish launch
  and current windows and reflect native session titles and actual outcomes.
  Verified live latest rows remain navigable even before historical disappearance
  is polled. Closing live navigation rows confirms the separate durable control
  scope; telemetry never retargets a kill, and reattached windows may remain open.
  Post-switch ownership loss reports the completed switch honestly.
  Add `test/navigator-current.test.ts`, extend `test/dashboard.test.ts` and
  `test/widget-nesting-final.test.ts` for deliberate branch-list behavior,
  current-window races, title composition and direct-parent resume refusal.
- Compose the shared widget/dashboard actions with context-aware subtree close:
  selected close reports aggregate partial errors, and the root retains confirmed
  `a` close-all from the same dashboard, including empty/history views. Keep
  direct-widget activity/focus and direct-parent resume checks unchanged; no
  second panel or row-by-row close authority. Add combined coverage in
  `test/widget-nesting-final.test.ts` and root action intent coverage in
  `test/dashboard.test.ts`; extend `test/dashboard-actions.test.ts` control stubs.
- Make the direct-delegate widget keyboard-navigable and reuse one dashboard for
  widget Enter, `/delegates` and its shortcut. Down at an empty built-in prompt
  selects children; stable selection scrolls through the cap. Enter opens details,
  and Escape returns to list then prompt. Dashboard list Enter now opens details
  before a second Enter switches (a deliberate navigation change); peek, close,
  new and authorized resume remain behind existing action/ownership checks.
  Custom editors, autocomplete, dialogs and unknown focus pass through unchanged.
  The isolated Pi-internals adapter was tested with installed Pi 1.4.0 in both
  regular and fullscreen modes; no Pi change or editor/footer replacement.
  Protect the empty prompt while a widget-opened dashboard is loading or
  re-listing between actions, without intercepting real dashboard/dialog input.
  Update `test/navigator.test.ts` for the deliberate two-Enter details/switch
  flow and `test/tree-restore.test.ts` to inspect metadata in details.
- The interactive direct-delegate overview deliberately replaces only Squire’s
  running-count entry when its cap is positive, preserving custom footers/editors
  and the own-delegate badge. Cap zero and non-TUI hosts retain the running count.

### Added

- Nested delegate overview: root-to-parent ancestor rows with direct live-window
  navigation, parent-first Down and cap-zero ancestor navigation plus the existing
  direct-child count. Same-id reopens use owner-correlated current pane/server/
  window metadata, independent of strict task activity launch correlation.
- All-depth descendant **task/launch-id** summaries beneath direct coordinator
  rows, preserving failed/stopped/missing outcomes and failures across resumes.
  Read-only semantic provenance and coverage keep registry accounting distinct
  from actual replies; unknown/partial coverage is explicit. Summaries share one
  secondary line with factual activity and take priority at narrow widths.
  The former cap-zero empty-widget assertion deliberately changes for delegates;
  async ancestor metadata tests now wait for the observable refreshed frame.
  Corrupt descendant owner facts show unavailable counts without freezing fresh
  ancestors/direct rows. Hidden/empty child views skip locator I/O, and unchanged
  positive locator observations do not rewrite telemetry snapshots.
  No task/control policy, result barrier, provider contract or second tree index.
- Factual live direct-delegate activity from actual concurrent/nested tool-call
  ids and bounded assistant response text, propagated across Pi processes by
  disposable owner-only snapshots. Launch correlation separates resumed tasks
  from stable sessions; lifecycle cleanup and known task results/close clear
  activity independently of task delivery. No thinking, tool results, inferred
  intent/waits, extra model calls, counters or stale-state timer. Uncorrelated
  manual reopen has no task-row activity. The common launcher now includes a
  private stable-session/launch correlation environment value; launch-wire tests
  deliberately account for this per-launch field.
- Live, passive direct-delegate overview in interactive Pi: running children
  first, then finished-open children, newest within each group, with stable
  session keys, mutable native titles and actual failure/stopped outcomes.
  Native file-backed renames and unflushed title mirrors refresh without naming
  tools or model calls. Responsive themed tree rows clamp narrow/wide text and
  omit model then file-age metadata as space shrinks.
- `delegateWidgetPlacement` (above/below, default above) and
  `delegateWidgetMaxEntries` (default three) in the existing Squire settings.
  Independent observation continues after task completion and is cleaned up on
  reload; no focus keys or tree accounting semantics change.

- Provider-neutral process-local completion holds: active exact-session Squire
  runtimes advertise support in the versioned `pi.completion-holds.v1` data
  table. External holds gate new final task replies, tree completion and
  auto-exit until every current-session entry is ready. Host registrations are
  runtime-owned and removed on every shutdown; provider holds survive reload
  but are not durable across process restart.

- Synchronous `squire:identity` lifecycle notification with a frozen,
  exact-session root/delegate/invalid observation, emitted after identity
  restoration and persistence and before later asynchronous startup work.
  Consumers can observe ordinary reopen and runtime replacement without
  treating launch environment variables as identity authority.

- Explicit ancestor-scoped subtree close and root-only confirmed panel close-all.
  Shared admission/own-entry dispatch fences precede effects, including root
  reservations. Already-dispatched unknown creates remain charged/fenced and
  partial; bounded explicit retries never guess no-start. Current verified
  id+name locators include manually reattached same-id coordinators. Per-member
  errors preserve successful closes; shared companions, branches and worktrees
  are retained, and ordinary runtime exit never cascades.
- Confirmed closes are imported only by the direct-parent semantic owner as
  durable canceled/missing child outcomes. Offline restoration and settlement
  retain the processing barrier, root replay-stop behavior and genuine
  mid-close/late worker replies. Completed fences allow a new authorized,
  lifetime-counted direct-parent resume without reviving canceled descendants.
- Restore exact-session delegation trees without recreating live workers,
  including offline child/coordinator replies, pending result processing and
  concurrency for a manually reopened unfinished coordinator. Shared registry
  ancestry drives descendant status/navigation; each direct parent's local
  results/outcome inbox remains authoritative.
- Single Squire process owner per Pi identity, using the existing bakery lock.
  Already-claimed Squire input is durably staged for the sole owner across
  duplicate scans and delayed startup. Losing/stale runtimes cannot act or
  clear a replacement token; ordinary parent exit never closes children.
- Bounded fresh-session notices explain reopening direct owners without
  adoption: current agent/session directory, newest 64 registry files, at most
  10 owners, 1 MiB per tree, one 200 ms cooperative notice budget, and explicit
  unavailable/truncated scope.
- Shared per-root tree registry and atomic cross-process launch reservations.
  `maxConcurrentDelegates` and `maxDelegatesPerRoot` default to 16/64 with
  maxDepth > 1, remain unlimited when absent at depth 1, and accept zero for
  unlimited. Settings changes affect subsequent launches/resumes; refusals
  report count/limit without queues or killing existing work. Resumes spend
  new launches; completed open windows free concurrency, not lifetime count.
- Publish worker terminal accounting independently of the parent's process,
  retaining 03's local result-processing authority and durable reply retries.
  Preserve failed-versus-uncertain launch/resume handling, recover child window
  locators after lost tmux responses, reconcile disappeared workers and retain
  ambiguous reservations until positive evidence exists. Counts survive
  ordinary root/coordinator restarts. Separate Node-process contention/crash
  fixtures are reusable by the later subtree-close slice.

- Nested unresolved project trust goes directly to the attended root's squire,
  outside model questions and task mail, with agent-chain, requester and
  directory/source context. Root-local and remote prompts share a serialized
  queue, including while the root is busy. Preserve scoped/source-worktree
  resolution and explicit approval/denial flags on launch and resume.
- Bound ordinary trust requests to ten minutes including queue wait. Cancellation,
  disconnect, expiry and either runtime's replacement stop the pending launch
  and dismiss its question; late approvals and old requests after restart cannot
  save trust or revive work. Persistent choices are saved only by a live
  requester; launch-only choices remain unsaved. Unavailable/unattended roots
  refuse without opening delegate UI. Squire uses owner-token loopback control,
  without provider internals, permission inheritance or pending-request replay.
  Deliberately replace the interim nested-trust refusal tests with root-choice
  behavior, real-provider isolation and separate-process kill/restart coverage.
- Nested launch/resume tools are capped by the direct parent’s actually available
  operations, including codemode/deferred and active model-only tools. Requested
  patterns become exact registration grants after `session:launch` customization;
  neither `delegateTools` nor hook-added extensions can widen them. Launch/resume
  notices report removed tools and restricted patterns; top-level selection stays
  unchanged. Real Pi 1.3 execution and isolated CLI launch/resume tests cover the
  deliberate nested-only behavior.
- Complete nested-grant validation: false and empty lists grant none, malformed
  values disable the agent, duplicates are removed, and unavailable child names
  warn without disabling known entries. An agent with a permission map warns
  when a listed child lacks one, including `true` grants over the current roster.
  This heuristic does not compare policies or inherit permission authority;
  tool restrictions and permission rules do not provide filesystem isolation.
- Unreleased nested-worker lifecycle: `maxDepth` (default 1), current-agent
  `allow_nested_delegation` grants and bypass-resistant launch/resume admission,
  including trusted project-agent shadowing. Coordinators get all four
  delegation tools even with an explicit tools list; listing tools alone warns
  and grants nothing. Nesting remains an incomplete integration milestone:
  full integrated real-model and permission-forwarding validation remains required
  before production use.
- Persist parent/root/depth/agent/chain identity and auto-exit state for manual
  same-session reopening. Expose read-only parent/root/depth/frozen chain on
  `session:launch`, alongside existing mutable args/env customization.
- Durable direct-child task completion and result-processing barrier. No
  intermediate coordinator reply/exit while children run; out-of-order results
  and rolling fan-out finish only after a later processing run settles. Results
  arriving during final settlement force processing before completion.
  Coordinators can recover after fallback exhaustion while workers run; their
  final run determines success/failure. Confirmed disappearance produces the
  existing missing-result outcome; unknown tmux state does not release work.
- Separate coordinator identity/auto-exit and running-child footer keys, retain
  parent delegation guidance in coordinators, and keep trust questions out of
  unattended UI. Update deliberate single-level-only
  registration, hook shape, footer and persistence expectations in tests;
  execute the expanded README hook example and real-mail multi-instance
  lifecycle coverage.

### Fixed

- Keep factual activity end/settlement observation live when Squire task-owner
  processing fails or owner-record reads are unavailable, without granting action
  authority. Check publication ownership only at startup, not on each text delta.
- Normalize process-start observation to C locale and UTC for live activity and
  native-title mirrors, so differing parent/delegate time zones or locales do not
  hide metadata or falsely delete a live activity snapshot.
- Preserve the original root project companion preference through nested
  cross-project launches, same-id coordinator restarts without launch environment,
  and direct-parent resumes while the root is absent. Save one `rootPlacement`
  base in existing identity/local/shared tree records, keeping call-time
  current/companion mode and marked/unmarked alternative selection separate.
  Malformed or conflicting required placement identity fails closed; nested
  parent-preference contradictions are refused before target trust resolution.
  Identity-less resume refusal is declared above under Breaking; no relocation
  or repair system is added.
  Existing synthetic identity fixtures and full-identity assertions deliberately
  include this required field. Add real-provider/Git cross-project coverage and
  actual coordinator process shutdown/SIGKILL/reopen with root-absent resume.
- Incomplete transcript/child-identity restoration now fails closed for both
  completion and admission, retains known own child obligations and refuses
  incidental saves until repair/reopen. Foreign copied history stays excluded.
- Stage matching input atomically without waiting for a contended owner lock;
  only the token owner drains, with callbacks outside that mutex. Preserve
  timestamp/path order, avoid idle lock writes, and report unpersistable input
  explicitly instead of silently falling through to plain mail. Ready owners
  can use normal direct processing when staging alone is unwritable.
- Always run runtime shutdown cleanup after input/owner failures, closing old
  trust controls/timers before replacement. Persist explicit root user stops
  without automatic replay on reopen; fresh live results/gone outcomes still
  wake normally and clear that replay hold. Ordinary crash recovery remains.
  Root continuations use response wording rather than coordinator task reports.
- Ownership errors name the PID/file; discovery reports owner-read/tmux failures
  once and shares one total latency budget. Document ordinary-mail/ask and
  shared running-record consequences of duplicate provider processes.

- Restrict resume execution and picker authority to the original direct parent,
  retaining root/depth, live-session/obsolete-chain protections and current
  grants, caps, tool ceiling and trust resolver. Fork/clone copies are history,
  not authority; inherited launch environment no longer assigns identity.
- Deliberately change the delegates panel to retain hierarchical history and
  details rather than only open windows; only verified windows support
  navigation. Descendant close stays with the separate explicit-close slice.
  Reattachment tests now reopen the same id after shutdown rather than copying
  starts into a fresh/live duplicate session. Root outcomes retain processing
  durability with a non-displaying recovery wake instead of a repeated final.

- Keep durable local result/gone delivery, coordinator wakes and close tracking
  working when shared fact publication fails; warn and reconcile those saved
  facts at the next admission. Worker frozen-terminal publication remains
  mandatory before transport. A confirmed window open stays successful and
  locally tracked even if accounting publication fails, and refund failures
  preserve the original tmux certainty/error. A refused concurrent resume no
  longer releases another call\'s in-flight guard.
- Retain frozen answers when task context is unavailable rather than bypassing
  terminal accounting, and skip failure-cleanup transactions after successful
  resumes. Clarify malformed-settings behavior and unresolved-launch refusals.

- Refuse launches/resumes on malformed, unreadable or non-object shared squire
  settings instead of silently losing configured cap limits. Deliberately
  update window-placement/worktree-setting tests that previously allowed
  inherited/cwd launches with an unreadable settings file; readable unrelated
  creation settings still do not affect those launches.

- Preserve default leaf task guidance and takeover wording; only effective
  coordinators receive child-first reporting instructions, including after a
  current grant change. Refuse unhealthy durable child-task storage before
  launch/resume effects rather than reporting failure after a child starts.
  A task-wording lookup failure uses the original leaf wording before ownership
  is recorded, so invalid depth configuration cannot strand an unprompted task;
  launch admission still refuses invalid configuration.

- Persist owed delegate task answers and frozen reply retries across reload,
  restart, resume and same-session manual reopening. Bounded startup retries
  tolerate delayed mail initialization; remaining reply write failures are
  visible and block auto-exit. Stops hold tasks through failed runs; successful
  recovery, final failure, fallback and no-answer wording are preserved.
  Updated `test/auto-exit.test.ts` for consumer-owned reply/exit behavior and
  added real-provider task-reply and correlation regression coverage.
- Correlate every request id in a batched reply and suppress duplicate final
  results even when a transport retry writes a fresh reply envelope.

### Changed

- Default companion placement now groups delegate windows by the owning root
  project's main-checkout basename (or root working-directory basename outside
  Git), using `<project>-delegate-session`. Roots, same-named projects and
  normalization collisions intentionally share managed companions without
  sharing delegation ownership. Unmarked sessions are left untouched; numbered
  alternatives are reused, including across parallel launches. Git inspection
  failures report a basename fallback notice. Launch and resume use the root's
  project even for cross-project tasks; `current` placement and delegate window
  names are unchanged. Existing companions and live windows are not migrated.
  Updated the tmux, window-placement, tools, navigator, delegate-render,
  workspace, and worktree ticket 04/05 tests for the deliberate placement
  behavior change; added project-companion and real-tmux regression coverage.
- Broken `.git` pointers now report Git state as unknown rather than as a
  confirmed non-Git directory. This shared Git detection applies to workspace
  records, status, snapshots and worktree-source errors, as well as companion
  placement fallback notices.

## [0.15.0] - 2026-10-30

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
- `exclude-tools` is removed: a file that still has it gets a warning and the
  field is ignored, so the delegate's tools follow the usual rules (its
  `tools` line, or the parent session's active tools when there is none, plus
  the `delegateTools` setting) with nothing taken off. List the delegate's
  tools in `tools` instead.
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

## [0.14.0] - 2026-10-27

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

[Showing lines 1-838 of 1180 (50.0KB limit). Use offset=839 to continue.]
# Resuming an exited Pi subagent: how other libraries do it

## Question and short answer

How do Pi subagent/delegation libraries resume a subagent whose process has exited: same session file or a fork, same id or a new one, what stops two writers, which working directory, and how is the follow-up result tied to the right run?

**Every library that offers a resume of an exited subagent reopens the same session file.** None of the ones audited forks (`--fork` / `SessionManager.forkFrom`) to resume. Fork appears only at *launch*, as a way to hand a child the parent's context (`context: "fork"`, `--fork` on `/run`). Reopening is done by `pi --session <file>` in a new pane/tab (edxeth, giuseppecrj, HenryQW) or by `SessionManager.open(file)` in-process (nicobailon, tintinweb, gotgenes, bermudi, championswimmer, doompi-team).

Almost all of them give each resume a **new tracking id** (a run id) while the **session file stays the same**. The two that keep the id are in-process libraries that mutate one record (tintinweb, gotgenes). Guards against two writers are thin: only nicobailon has an on-disk lease (pid and start-identity check) and HenryQW has a lease file plus a check that the saved turn is terminal. The rest rely on an in-memory registry or on documentation.

The deleted-cwd problem is known and handled by **refusing**, **overriding the cwd**, or **validating and failing before launch**. No library found surfaces Pi's interactive "cwd does not exist" picker to an unattended window. Details, pins and unknowns follow.

## Date, versions, method

Checked **2026-10-26 UTC** against Pi `@earendil-works/pi-coding-agent` **1.3.0** (`node_modules/`, this repo). Library source is a shallow clone of each default-branch HEAD at the commit below (HEAD, not necessarily the published npm version). Claims cite `repo@sha:path:line` for that commit. Tests were not run; behaviour is read from source and docs.

Discovery: `search_pi_packages` for `subagent` (398 matches), `subagents` (294), `delegate` (67), each first page (top 25 or 15 by downloads). Repository list from `docs/research/parent-waiting-guidance.md` was added. A ripgrep for `--session`, `--fork`, `SessionManager.open|forkFrom|continueRecent`, `resume`, `continueFrom`, `revive`, `restore` was run over each clone's non-test source. A search that finds nothing does not prove absence.

| Library (npm) | Pin |
| --- | --- |
| edxeth/pi-subagents | [`cf6dbf41`](https://github.com/edxeth/pi-subagents/tree/cf6dbf41c17986f3882e6804a68e8fb8282d25e6) |
| nicobailon/pi-subagents (`pi-subagents`) | [`d9c5ca29`](https://github.com/nicobailon/pi-subagents/tree/d9c5ca29d881ee173681cafb66af1cc774285276) |
| tintinweb/pi-subagents (`@tintinweb/pi-subagents`) | [`ca93a524`](https://github.com/tintinweb/pi-subagents/tree/ca93a5247e72e7053fcd10bea7125d6c4205f949) |
| gotgenes/pi-packages, `packages/pi-subagents` | [`109efb72`](https://github.com/gotgenes/pi-packages/tree/109efb7244e89e8cd6d7e2e1f0aba54f7f053e6f) |
| bermudi/pi-delegate (`@bermudi/pi-delegate`) | [`24fc88c0`](https://github.com/bermudi/pi-delegate/tree/24fc88c06a4f3d9715f2d99f072de4dca914edf6) |
| giuseppecrj/pi-herdr-agents | [`8864764e`](https://github.com/giuseppecrj/pi-herdr-agents/tree/8864764e65a469f7d90f9a0deb39ec3f0b26befc) |
| HenryQW/pi-harness, `extensions/pi-subagent` (`@henryqw/pi-subagent`) | [`18d2c7b8`](https://github.com/HenryQW/pi-harness/tree/18d2c7b8f39a4a3b87444099527df7c7e32cbdd8) |
| championswimmer/pi-subagent-manager | [`51f1645c`](https://github.com/championswimmer/pi-subagent-manager/tree/51f1645ccc45aa1adb9582fa0082574cd8b481dc) |
| AgiFlow/doompi, `layers/team/doompi-team` | [`c3f057ab`](https://github.com/AgiFlow/doompi/tree/c3f057ab58a94667fb6f5c1e94c5a31e43bf84cf) |
| QuintinShaw/pi-dynamic-workflows | [`3a52f19a`](https://github.com/QuintinShaw/pi-dynamic-workflows/tree/3a52f19ab1f01e09535b6b3e1d8200b6f3bcb63a) |

Short names below drop the owner: `edxeth`, `nicobailon`, `tintinweb`, `gotgenes`, `bermudi`, `herdr-agents`, `henryqw`, `championswimmer`, `doompi-team`, `qs-workflows`.

Not audited in depth (no resume feature found by the search above, or not a Pi-session resume): kvidzibo/pi-delegate, asermax/herdr-subagents, mavam/pi-agents, ismailsaleekh/pi-background-tasks, purboo/pi-durable-subagents (crash-safe workflow journal, not a session reopen; unknown), jjuraszek/pi-cohort (appears to be a fork of nicobailon; same file names), 1aboveio/pi-better-harness (`pi-better-subagents` starts every run with a fresh `--session-id`, `index.ts:1786-1787`), boadij/pi-herdsman (uses `SessionManager.open` only to read provenance, e.g. `extension/lead-runtime.ts:7363`), comput-sh/pi-intercom (launcher passes an optional `--session <id>`, `src/launcher.ts:36`; semantics unknown).

## What Pi 1.3.0 itself does (the constraints)

- `--session <path|id>` opens the file with `SessionManager.open(path, sessionDir)` and **no cwd override**, so the cwd is the header's stored cwd. `dist/main.js:296-321`, `dist/core/session-manager.js:1326-1345`. An id that matches a session of another project asks "Fork this session into current directory?" through `promptConfirm` (stdin), `main.js:311-321`: a second blocking prompt.
- After the session manager is built, `getMissingSessionCwdIssue` checks that the stored cwd exists (`dist/core/session-cwd.js:2-15`). **Interactive**: a startup selector "Continue in current cwd / Cancel" (`main.js:556-563`). **Non-interactive** (`-p`, json, rpc): prints `MissingSessionCwdError` and `process.exit(1)` (`main.js:565-568`). So the hang is interactive-only; a `-p` resume fails fast.
- `SessionManager.open(path, sessionDir, cwdOverride)` accepts a cwd override (`session-manager.js:1326`); the interactive prompt itself uses it (`main.js:563`). The CLI flag path does not expose it. SDK callers (nicobailon, championswimmer) use it.
- `--session-id <id>` **reopens** an existing session with that id when `findById` finds it (`main.js:345-348`), otherwise warns and creates a new session with that id (`main.js:349`). With an explicit `--session-dir`, `findById` also filters on the header cwd matching the launch cwd (`session-manager.js:1421-1435`), so a session whose stored cwd differs from the launch cwd is "not found" and a *second* file with the same id is created. `--session-id` cannot combine with `--session`, `--continue`, `--resume` (`docs/cli.md:107`).
- `--fork <path|id>` calls `SessionManager.forkFrom(source, cwd, sessionDir, {id})` (`main.js:291-302`): new file in the *current* cwd, header `parentSession` points to the source, all non-header entries copied (`session-manager.js:1374-1410`). `--fork` with `--session-id <existing>` exits with "Session already exists" (`main.js:291-294`). `forkFrom` never checks the source's stored cwd.

## Per-library findings

### edxeth/pi-subagents: `subagent_resume`

1. **Yes.** Tool `subagent_resume` with `sessionFile` (required), `task`, `name`, `agent`, `model`, `thinking`, `mode` (`src/tools/resume-tool.ts:60-113`). Also a `/subagents` overlay (`resume-service.ts:199-207`).
2. **Same session file, new run id.** `pi [-p] --session <file>` (`src/launch/resume.ts:128-130`); interactive mode in a new mux pane, background mode as a detached `-p` child (`resume-service.ts:465-555`). The tracking id is a fresh `Math.random().toString(16)` (`:437`); `PI_SUBAGENT_SESSION` carries the file (`:430`).
3. **Guard: in-memory only.** Rejects when another running record in this process has the same resolved session file (`resume-service.ts:314-323`) and takes a spawn-width slot (`:224-229`). No pid or file lock; a second Pi process, or a child that outlived a crashed parent, is not detected. Unknown whether anything else covers it.
4. **cwd: stored launch cwd.** `getResumeCwd(metadata) = metadata?.cwd` (`resume.ts:38-40`), taken from the first launch-metadata entry (`resume-service.ts:279, 346`); passed as `spawn(..., {cwd})` or as `cd <cwd> && pi ...` in the pane (`src/launch/shell-command.ts:63`). No override parameter. No existence check in the resume code I read; a missing directory would make `spawn` fail or the shell `cd` fail (inferred, not read). Deliberate refusal for worktree-backed sessions: sessions from an `llm-as-a-verifier` run are non-resumable because "their worktree workspace is deleted after selection, so a resume would resurrect a session whose cwd no longer exists" (`resume-service.ts:212-223`; README:650).
5. **Bookkeeping.** Each resume is a new `RunningSubagent` with its own id, `launchEntryCount = getEntryCount(sessionFile)` taken before launch (`:325, 459`), and results are read from entries after that offset (`src/runtime/background-watch.ts:96, 318, 371`; `interactive-watch.ts:398`). That is the dedupe against earlier runs' output. Exit and timeout sidecars of the previous run are cleared before the new run (`:326-334`).
6. **Config: saved by default, model/thinking overridable.** Mode, agent, cwd, tools, extensions, deny-tools, env, budgets are replayed from launch metadata (`:279-413`; README:648 "should continue as the same child, even if the agent file changed"). Spawn grants are only narrowed, "first metadata entry is authoritative" (`:183-197`; README:856). `model`/`thinking` apply unless the agent has `allow-model-override: false`, then they are recorded as ignored (`:136-181`; `resume-tool.ts:91-106`). Time limits are re-armed from the same budget (`:414-427`; README:386).
7. **Delivery.** Follow-up `task` is written to stdin (background) or a `@file` argument (interactive, `:480-482, 525-528`). Result is a steer message to the parent ("Do not poll", `resume-tool.ts:69-71`); in a parent without UI the resume is forced synchronous (`resume-tool.ts:44-52`).
8. **Pitfalls documented.** Refuses sessions that ended on the context-warning policy (`resume-tool.ts:20-30`), and `on-timeout: block-resume` (`:31-42`). Resume line omitted for those. No CHANGELOG in the repo.

### nicobailon/pi-subagents: `subagent({action: "resume", id, message})`

1. **Yes**, the most developed. `resume` (alias "revive") on paused, completed or failed async/foreground children; also `steer` with `mode: "follow_up"` to queue text for the next resume; workflow `runs.run(key, {resume: runId, task})` (`docs/tool-reference.md:374-383, 195-199`). Stopped runs are refused (`src/runs/background/async-resume.ts:493`). Parameters include `id`, `message`, `options.index`, `output`, `timeoutMs`.
2. **Same session file, new run id, in-process SDK.** Docs: "Revive starts a new child session from the old session context; it does not resume the live session" (`tool-reference.md:381`). Mechanically the revived run is a new runner with `sessionFile: revivalSessionFile` (`src/runs/foreground/subagent-executor.ts:2348-2353`) and the child calls `SessionManager.open(file, undefined, launch.cwd)` (`src/runs/shared/child-session.ts:602-603`). The new run records `revivedFrom` (`src/runs/background/subagent-runner.ts:2080`). The follow-up is wrapped by `buildRevivedAsyncTask`: "Use the stored session context as background … Do not assume the original child session is still running" (`async-resume.ts:647-660`).
3. **Guard: on-disk session lease.** The runner calls `acquireSessionLease` before opening (`src/runs/background/subagent-runner-bootstrap.ts:145-149`). The lease dir is keyed by the canonical session path hash and holds pid, hostname, process-start identity, writer state (`src/runs/shared/session-lease.ts:15-45, 202`). A lease is reclaimed only when "demonstrably stale": same host, owner pid gone (or start identity changed), and writer pid gone (`session-lease.ts:162-182`). Unreadable owner metadata blocks ("Refusing to reclaim it without proof that the owner is stale", `:156`). Start identity is read only from `/proc` on Linux (`:68-80`), so on macOS staleness rests on `kill(pid, 0)` alone. Live async runs are also reconciled from status.json against dead pids (`async-resume.ts:471-480`, `stale-run-reconciler.ts:487`). A `live` target is never revived; resume does not interrupt a running child (`tool-reference.md:376`).
4. **cwd: recorded cwd, validated; managed worktree preferred.** `resumeCwd = validateResumeCwd(managedWorktreeCwd ?? status.cwd ?? result.cwd ?? recoveryDescriptor.cwd)` (`async-resume.ts:588-590`); a missing path throws "required cwd does not exist" before launch (`:458-466`). Retained worktrees are looked up from the parallel-handoff record (`:587-589`). Cleanup refuses to delete a worktree that "has been resumed" or is a resume candidate (`CHANGELOG.md:389`). Placed (remote) children can't be resumed (`CHANGELOG.md:26`). No override parameter found.
5. **Bookkeeping.** New run id per resume with `revivedFrom`/lineage; keyed workflow resumes chain lineage `[original, revived, …]`, capped at 16 (`tool-reference.md:195`). Output file: a resume without its own `output` writes to `<name>.<runid8>.<ext>` so the first report is not overwritten (`CHANGELOG.md:266`). `/subagent-cost` once dropped every round after the first as a duplicate (`CHANGELOG.md:448`). A repeated external-job resume no longer sends the follow-up twice (`CHANGELOG.md:580`).
6. **Config: saved.** "The revived child keeps its stored agent, model, and tool contract" (`tool-reference.md:199`); a recovery descriptor holds model, thinking, tools, extensions, system prompt, launcher (`async-resume.ts:615-645`). Per-run overrides: `timeoutMs` only (checked, `CHANGELOG.md:542`). Nothing in the descriptor means "fail closed" (`CHANGELOG.md:627`; children launched before the layout change "still can't be resumed", `:214`).
7. **Delivery.** Detached background-run receipt, result arrives as an async completion; `steer` for live children, `resume` for finished ones (`tool-reference.md:376`).
8. **Changelog entries on resume bugs** (`CHANGELOG.md`): `:214` coordinator could not resume its own finished child ("session file is not under that nested run's session directory", #2924/#2932); `:266` resume overwrote the earlier report (#2837); `:158-159` steer after finish gave an unhelpful error; `:74` foreground run cut off by a crash was not resumable by id; `:488` revived failed child not visible in the workflow (#2579); `:193-194` a handoff session can resume the old session's runs; `:370` a session reopened with `pi --session <id>` confused a capacity counter (#2698).

### tintinweb/pi-subagents (and gotgenes fork): `Agent({resume})`, `@handle`

1. **Yes.** `Agent` tool `resume: <agentId>` (optionally `run_in_background`); `@handle message` resumes a finished agent; "an agent can only be resumed once its current run has finished — use `steer_subagent` to reach one mid-run" (`src/index.ts:1799-1801`; `CHANGELOG.md:166-168, 196`).
2. **Same session, same agent id; reopens from disk after eviction.** While the record is in memory, `manager.resume(id, prompt)` prompts the live `AgentSession` (`src/agent-manager.ts:1173-1260`, `resumeAgent` in `src/agent-runner.ts:1278`). After the record is evicted (10 min) a tombstone lets the mention reopen the file as an ordinary spawn with `resumeSessionFile`, which calls `SessionManager.open(file, sessionDir)` with **no cwd override** (`src/index.ts:1000-1060`, `src/agent-runner.ts:1126-1130`). `rememberAgents` must be on for the file to exist (`CHANGELOG.md:163`).
3. **Guard: status check on the in-process record.** A resume of a `running`/`queued` record is refused rather than replacing the live run's abort controller (`agent-manager.ts:1198`; `CHANGELOG.md:196`). Reopen-from-disk checks the file still exists and the agent type is still available (no fallback to another type, `index.ts:1012-1029`). No cross-process guard (inferred; the library is in-process).
4. **cwd: header cwd on reopen.** The file's header carries cwd and parent; "none of the create-time options apply" (`agent-runner.ts:1127-1129`). A comment lists "an unusable cwd" among spawn-time failures that land in the catch (`index.ts:1055-1058`). Behaviour on a deleted cwd beyond that is unknown. An in-memory resume keeps the record's existing tree.
5. **Bookkeeping.** One record, reset in place on resume (`result/error/completedAt` cleared, `agent-manager.ts:1199-1205`). The history fallback is bounded to the current invocation so a failed resume cannot return the previous turn's answer (`CHANGELOG.md:262`, #144); a resumed run gets a fresh `max_turns` budget (`CHANGELOG.md:16`, #368); transcript output is appended, not truncated (`:196`).
6. **Config: from the record, type re-resolved.** "Resume ignores subagent_type (the record keeps the type it was spawned with)" (`index.ts:1503`); `resumeAgent` cannot re-apply a model or thinking level (`CHANGELOG.md:124`). After eviction "only the definition is re-resolved, so a continuation runs under the type's current frontmatter" (`CHANGELOG.md:168`).
7. **Delivery.** Foreground resume returns the settled record inline; background resume detaches and notifies like a spawn (`CHANGELOG.md:196`).
8. **gotgenes** (fork) models each resume as a new `SubagentRun("resume")` replacing `currentRun`, with the prior run `markReplaced()` so its late result is ignored (`packages/pi-subagents/src/lifecycle/subagent.ts:573-604`, `subagent-run.ts:295`; changelog: "keep a stopped run's late result off the resume that replaced it", #1051, `CHANGELOG.md:54`; "refuse a second resume while one waits for a concurrency slot", #1013, `:42`).

### bermudi/pi-delegate: `delegate({tasks:[{resumeFrom, prompt}]})`

1. **Yes.** Task field `resumeFrom` = absolute path to a `.jsonl` transcript; `prompt` optional (defaults to `continue`) (`src/validation.ts:347-367`, `src/host.ts:382`). Failed/cancelled tasks print a copy-paste hint, only when the transcript holds at least one message (`src/format.ts:70-118`).
2. **Same file, new task.** `SessionManager.open(task.resumeFrom)` inside `createSubagentSession` (`src/host.ts:506-509`). The ticket journal marks the resumed task with a tag from the transcript name (`↻`, `docs/history/V1-V2-MAP.md:144`).
3. **Guard: in-process admission, exclusive per canonical transcript.** "One writer per transcript"; symlinks canonicalised; a second task on the same transcript in one call fails, and across calls the current owner blocks until it settles (`src/admission.ts:337-364`; `src/sessions.ts:309-311`). Dead writers are *not* quarantined: "a dead writer no longer mutates the file" (`docs/history/V1-V2-MAP.md:143`). Cross-process: not covered.
4. **cwd: the new task's cwd (default parent cwd), existence-checked.** `task.cwd` is resolved for the new call and `existsSync` fails with "cwd does not exist" (`src/host.ts:326-328`); `createAgentSession({cwd: task.cwd, sessionManager})` gets that cwd (`:524`). The header cwd is not used for the tool cwd. Both non-shared workspace modes (scratch, isolated) reject `resumeFrom` (`validation.ts:352-356`; README:155), since their filesystem is discarded.
5. **Bookkeeping.** Each resume is a new task in a new ticket; no run counter.
6. **Config: from the new task (profile, model, tools).** Not saved from the old run. (`createAgentSession` takes `task.model`/`task.tools`, `host.ts:527-529`; no saved-config path found.)
7. **Delivery.** Ordinary ticket result (poll/wait/wake).
8. Pitfall noted in the history doc: header-only transcripts are "real on disk but give a resume no prior context", so no resume hint (`format.ts:70-80`).

### giuseppecrj/pi-herdr-agents: `subagent_resume`

1. **Yes.** `subagent_resume({sessionPath, message?, name?, autoExit?})` (`docs/tools.md:241-246`). Ordinary children only: persistent specialists "do not revive in v1" (`maestro/adapters/pi/launch.ts:1016-1027`), tool overrides unsupported (`pi-harness-adapter.ts:289`).
2. **Same file, new pane.** `pi --session <abs path> [--tools …] -e subagent-done.ts [@messagefile]` in a new ordinary pane; new random id (`launch.ts:1003-1100`). The session path is resolved once to absolute because "Pi resolves `--session` against the pane's cwd, not the caller's" (`:1007-1013`).
3. **Guard: documentation, plus refusal of managed-worktree sessions.** "Managed-worktree children … continue there only after the previous process has exited; do not use `subagent_resume` or start a concurrent writer" (`docs/configuration.md:396-400`). Persistent specialists stopped after confirmation of process exit (`docs/tools.md:183`). No lock found in the resume path.
4. **cwd: header cwd of the session.** `cwd = header.cwd ?? process.cwd()`; pane created with that cwd (`launch.ts:1038-1040`). **Managed-worktree sessions are rejected** with "Use its retained managed-worktree workspace instead" (`launch.ts:1016-1020`, `docs/tools.md:248, 269`, `README.md:184`). A plain-session deleted cwd: unknown.
5. **Bookkeeping.** New id and activity file per resume (`launch.ts:1018-1019, 1044-1046`); old watchers do not survive a full process restart (`docs/tools.md:173`).
6. **Config: saved.** A versioned launch-policy sidecar next to the session restores the tool allowlist and denied tools "rather than looking up the current role, so later role changes cannot widen a child"; missing/malformed/unknown-owner policy "fails closed before a pane is created" (`docs/tools.md:248`; `launch.ts:1014-1030`; changelog "preserve capabilities across resume" #26, `CHANGELOG.md:288`).
7. **Delivery.** Follow-up written to a file and passed as `@file`; result returns as a `subagent_result` message (`README.md:118`).
8. Changelog: `fix(subagents): preserve capabilities across resume (#26)`, "Fix subagent lifecycle, resume permissions, and failure reporting (#30)" (`CHANGELOG.md:284-288`).

### HenryQW/pi-harness `@henryqw/pi-subagent`: `continueFrom`

1. **Yes**, two forms. `continueFrom: "D7.1"` on a single/parallel/chain task continues a finished direct worker; `subagent_resume` is a different thing (retry/verify/finalize of a saved orchestration wave) (`extensions/pi-subagent/docs/orchestration.md:120-124, 391`; `README.md:42`).
2. **Same session, new agent reference.** "The worker resumes its saved Pi session in a new Herdr tab… The new tab gets a new agent name and reference. Its record points to the same session and private lease file" (`orchestration.md:122-123`). Launch: `herdr agent start … -- --session <file>` (`src/direct-herdr.ts:408`).
3. **Guard: lease file plus proof the saved turn is terminal, plus one continuation per worker.** The tab carries `PI_SUBAGENT_PROCESS_LEASE` (`direct-herdr.ts:386`), and every prompt ends with `Turn identity: <turn>`; `assertSettledDirectSession` refuses to continue unless the saved session contains that exact prompt, a terminal assistant stop reason for it, and no later user turn: "…the worker may still be running" (`direct-herdr.ts:104-121`, `exactFinalTurn:62-102`). "A request can continue each worker only one time… continue the newest reference. The extension refuses an older reference" (`orchestration.md:124`). "A productive lease prevents concurrent execution or resumption" (`orchestration.md:381`).
4. **cwd: same checkout only.** "only from the checkout and Herdr workspace where the worker ran" (`orchestration.md:124`); the tab is created with `--cwd workingDir` and the pane's reported cwd is verified equal (`direct-herdr.ts:386-396`).
5. **Bookkeeping.** New reference per continuation; handle and result say "continued from D7.1"; only the newest reference may be continued (`orchestration.md:123-124`).
6. **Config: same `role`.** "It uses the same `role` that the worker ran with… Access, admission, write rules, and model routes are the same as for a new task" (`orchestration.md:122-123`). No override found.
7. **Delivery.** `herdr agent prompt <name> <prompt>`; answer read from the session file ("Pi's native session is the exact answer channel", `direct-herdr.ts:376`).
8. Pitfalls: none searched (no CHANGELOG in the package directory).

### championswimmer/pi-subagent-manager: `agent_steer`

1. **Yes**, folded into steering: `agent_steer({path, message?, timeoutMs?})` "queues/resumes"; paused/completed/stopped agents "resume their retained session" (`docs/tools-and-ui.md:16, 85`). Reaped agents cannot be resumed (`:65`).
2. **Same session file and agent path.** `SessionManager.open(path.resolve(file), sessionDir, ctx.cwd)` (`src/orch/runtime.ts:307`), optionally on a chosen leaf (`:308-311`).
3. **Guard: ownership metadata.** The file must be a `.jsonl` directly inside this root's session dir (or the legacy dir) and its transcript must carry the same `rootId` and thread path (`runtime.ts:132-157`). No process check found; "running agents receive queued input" instead of being reopened, so the steer/resume split is the guard (unverified at code level).
4. **cwd: current parent cwd (override).** The third argument to `open` is `ctx.cwd`, so the stored cwd is ignored (`runtime.ts:307`). This avoids the missing-cwd problem by construction; it also silently moves the child to another directory.
5. Bookkeeping: same agent path/record; unknown beyond that.
6. Config: unknown (not read).
7. Delivery: queued steering into the retained session; results also return to the main agent (`README.md:37`).

### AgiFlow/doompi `doompi-team`: `subagent({action: "restore", id})`

1. **Yes**, for runs suspended by a Pi session shutdown. Restore is offered, never automatic ("spawn N processes and start spending tokens on tasks that may be days stale", `src/services/suspendedRuns/index.ts:11-15`). `subagent({action:"suspended"})` lists them.
2. **Same session file, new run id, same identity.** The suspended record keeps `sessionFile`; a restore spawns a new run with that file and the original `identity`, `task`, `model`, `cwd`; "opens it through `SessionManager.open` when `sdk.sessionFile` is set" (`suspendedRuns/index.ts:48-62`; `subagentTool/index.ts:415-460`). Outcome text: "Restored 'old' as 'name' (newRunId), continuing its transcript", with `restoredFrom` (`:469-472`). The suspended record is cleared on success (`:467`).
3. Guard: only the suspended-record list in this scope (single owner). Not a process check; unknown.
4. **cwd: recorded `cwd`** passed as both `single.cwd` and `cwd` (`subagentTool/index.ts:429-445`). Missing-dir handling: unknown.
5. Bookkeeping: `restoredFrom`; identity reclaimed to avoid minting a second one (`:443-445`). A record without a readable session file is refused ("not_resumable … Submit a new explicit run", `:424-431`; `suspendedRuns/index.ts:149-165` check `R_OK` on the file).
6. Config: record's agent/model replayed; unknown beyond that.
7. The original `task` is re-sent; no new follow-up parameter found.

### Other mechanisms (not session resume)

- **qs-workflows / tintinweb / nicobailon workflows**: resume means replaying a journal of finished `agent()` calls and running the rest live in a *new* run (`resumeFromRunId`, `resumeMode`; qs-workflows `README.md:80`; tintinweb `CHANGELOG.md:94`; nicobailon `docs/workflows.md:40`). Not a model-visible subagent session; irrelevant to the A/B choice except as a result-cache precedent.
- **Fork at launch**: nicobailon `context: "fork"` and tintinweb `inherit_context`/`--fork` copy the parent's context into a new child. Not used for resume.
- A fork-based resume (design B) was **not found** in any library audited.

## Comparison

| Library | Resume of exited subagent | Mechanism | Id on resume | Two-writer guard | cwd on resume | Missing cwd |
| --- | --- | --- | --- | --- | --- | --- |
| edxeth | `subagent_resume` | `pi --session` in new pane / `-p --session` | new run id | in-memory registry | stored launch cwd | not checked in resume code; worktree-backed sessions refused |
| nicobailon | `resume` / `steer follow_up` | `SessionManager.open(file, undefined, cwd)` | new run id, `revivedFrom` | on-disk lease (pid, host, start id on Linux), status reconcile | recorded cwd or retained worktree | validated, error before launch |
| tintinweb | `Agent({resume})`, `@handle` | live session; reopen via `SessionManager.open(file, dir)` | same id | status check on record | header cwd | "unusable cwd" lands in catch; details unknown |
| gotgenes | `resume` | same, run objects replace each other | same id | status check; refuses 2nd queued resume | as tintinweb (unverified) | unknown |
| bermudi | `resumeFrom` | `SessionManager.open(file)` | new task | in-process per-transcript admission | new task cwd (default parent) | validated: "cwd does not exist" |
| herdr-agents | `subagent_resume` | `pi --session` in new pane | new id | docs only | header cwd | managed-worktree sessions refused |
| henryqw | `continueFrom` | `herdr agent start -- --session` | new reference | lease file + terminal-turn proof + one continuation | same checkout only | n/a (must be same checkout) |
| championswimmer | `agent_steer` | `SessionManager.open(file, dir, ctx.cwd)` | same agent path | ownership metadata | current cwd (override) | avoided by override |
| doompi-team | `restore` | `SessionManager.open` via SDK | new run id, same identity | suspended-record scope | recorded cwd | unknown |

## Cross-cutting observations

1. **Same file everywhere; id semantics split.** Libraries that track runs (edxeth, nicobailon, herdr-agents, henryqw, doompi-team, bermudi) mint a new run id per resume and keep the session file, usually with a back-pointer (`revivedFrom`, `restoredFrom`, "continued from"). Libraries that model "an agent" (tintinweb, gotgenes, championswimmer) keep the id and replace the current run. The late-result problem is solved in two ways: by a per-run id with the parent reading only entries after an offset (edxeth `launchEntryCount`), or by marking the old run replaced (gotgenes). Both cost a counter.
2. **A dead process is assumed, not proved, in most.** The libraries that check at all check differently: lease with pid liveness (nicobailon), session-file contents proving the last turn finished (henryqw), status of an in-process record (tintinweb, gotgenes, edxeth). A pid check without a start identity is weak on macOS; nicobailon reads start identity only on Linux.
3. **Worktree-backed sessions are the known failure.** edxeth, herdr-agents and nicobailon (cleanup keeps a worktree that may be resumed) all single out managed worktrees: refuse, or continue only in the retained workspace. championswimmer sidesteps by overriding cwd. Pi 1.3.0's own behaviour confirms why: interactive prompt vs non-interactive exit 1.
4. **Config is stored, not recomputed.** edxeth, herdr-agents, nicobailon, henryqw persist tool allowlist, deny lists, model and grants at launch and reuse them, with an explicit rule that a resume cannot widen authority. Overrides are narrow (model/thinking when allowed; timeout). bermudi recomputes from the new task.
5. **Delivery reuses the first-run path.** The follow-up travels as a prompt (stdin, `@file`, `herdr agent prompt`, `session.prompt`) and the result as the same notification kind as a first run.

## Implications for pi-squire

Facts about this repo come from the task description, not re-verified: delegation id = session id (`--session-id`), session file in the parent's session dir, task and result as mail, the cwd can be a removed managed worktree.

**Design A (reopen the same file, `pi --session <path>`)** is what every audited library does, so the mechanics are well trodden. What the evidence says about its three costs:

- *Two writers.* Only nicobailon proves the old process is gone, and its proof is a pid check (with start identity on Linux only). For a tmux window, the tmux side gives a cheaper and stronger proof: pi-squire owns the window and can check it is gone (and the Pi pid dead) before relaunch. henryqw's second proof is also available: read the session file and require that the last entry is a terminal assistant turn with no later user entry. Combining the two is stronger than any single library.
- *Per-run state on the parent's record.* Libraries keep it by minting a run id per resume and reading results after an entry offset, or by marking the old run replaced. pi-squire's id is the session id, so it needs a run counter (or `resumedAt` entry offset) on the record instead of a new id; late replies from an earlier run must be dropped by that counter. This is the part with no existing library to copy directly, since the id-keeping libraries are in-process.
- *Missing cwd.* Pi 1.3.0 hangs only the interactive window (`main.js:556-563`); `-p` exits 1 (`:565-568`). Handle it **before launch** as nicobailon does (`statSync` on the stored cwd, fail with a clear error) rather than depending on Pi's behaviour, and decide the policy for removed worktrees: refuse (herdr-agents, edxeth, "continue in the retained workspace"), or override the cwd (championswimmer's `SessionManager.open(file, dir, ctx.cwd)`). The CLI has no flag for an override, so an override from tmux needs either an SDK launcher or a pre-step that rewrites the header cwd (the latter edits the file a second writer must not touch, and is unverified). Do not use `--session-id <id>` as a resume trick: with a differing launch cwd and a `--session-dir`, `findById` misses and Pi creates a second file with the same id (`session-manager.js:1421-1435`, `main.js:345-349`).

**Design B (fork, `pi --fork <old> --session-id <new>`)** removes the three costs: the old file is only read (no writer conflict, `forkFrom` does not look at the stored cwd), the new session starts in the current cwd, and a new id keeps runs apart (late replies from the old id cannot be mistaken for the new run). The price is the one the task names: a new id and duplicated history, plus the extra `resumedFrom` linkage. **No audited library resumes by forking**, so B has no precedent to copy and no field experience; the libraries that use fork use it for launch-time context. It also changes what "the delegate" is: a continuation would be a different session with a copy of the history, so anything keyed on the old session id (mail addresses, the parent's record) needs the link. Also unverified: how a long history copied into the fork interacts with compaction entries and with `parentSession` trees in Pi's picker; the copy is verbatim (`session-manager.js:1403-1410`).

**What the evidence favours.** A, with fail-fast guards. Nine of nine audited resumers reopen the file; the problems that bite (worktree cwd, concurrent writer, late results) each have a known countermeasure in at least one library, and the cwd case is the only one A cannot repair with a guard alone. Concretely:

1. Resume only when the tmux window is gone, no Pi process holds the session, and the saved last turn is terminal.
2. Stat the stored cwd first; if it is missing, refuse with a message pointing at the options, or relaunch in a chosen cwd through B for that case only.
3. Keep the delegation id; add a per-run counter or entry offset on the parent record and drop late mail from earlier runs.

B is the better **fallback for the removed-cwd case** than a refusal (it needs no cwd repair and no header rewrite), and the better default if the two-writer proof cannot be made reliable. If a single mechanism is wanted, the question to settle first is whether a removed managed worktree should be resumable at all: herdr-agents and edxeth chose "no, continue in the retained workspace", which would make A sufficient.

## Unknowns

- Behaviour of edxeth, tintinweb, gotgenes, herdr-agents and doompi-team when the stored cwd is missing, beyond the cited code. Not tested.
- Whether herdr-agents or edxeth stop two writers across Pi processes. No lock found; absence of a search hit is not proof.
- championswimmer's per-run bookkeeping and config reuse (not read).
- Whether pi-cohort (jjuraszek) differs from nicobailon in resume behaviour (not read).
- Real-world incidence of two-writer corruption on a session file, and of Pi's behaviour when two processes append to one `.jsonl`: no source found in this survey.
- Pi's own docs on `--session` semantic changes between versions; only 1.3.0 was read.

Local clones used for this survey are under `.scratch/tmp/` (untracked, not part of the change).

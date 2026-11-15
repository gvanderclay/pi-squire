# Nested delegation

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Nested delegation (experimental)](#nested-delegation-experimental)
  - [Tree-wide launch budgets](#tree-wide-launch-budgets)

<a id="nested-delegation"></a>

## Nested delegation (experimental)

Experimental: shipped, not production-validated. Descendant inspection and
explicit subtree close are implemented, but full integrated real-model and
permission-forwarding validation remains incomplete. Use only isolated
development fixtures until that milestone is validated.

The default `maxDepth` in `<agent dir>/squire/settings.json` is **1**: root
(depth 0) → delegate (depth 1), with no grandchildren. Set `maxDepth: 2` for
root → coordinator → worker. A readable value must be a positive safe integer;
a missing settings file uses defaults. A malformed, unreadable or non-object
file uses the safe depth-1 default only when deciding whether to expose tools;
launch/resume refuses that broken file, naming it, rather than risk silently
losing configured tree caps. An invalid `maxDepth` value refuses exposure too
(see [Configuration](configuration.md#configuration)).

A coordinator's agent file opts in with
`allow_nested_delegation: [worker, reviewer]`, or `true` for any current roster
agent. Absent, false or an empty list grants no nesting. A list names exact
agent identities; duplicates are removed. Other values (including null, empty
scalars, quoted booleans, malformed lists and patterns) disable the agent with
a path-specific warning. Unknown or unavailable names warn and cannot launch;
known entries remain usable, and later roster changes apply normally.
Below the limit the grant adds `delegate`,
`delegation_status`, `delegation_close`, `delegation_resume` and `delegation_fork` even with an
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
root directly, outside model task mail (see [Project trust](workspaces.md#project-trust)).
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

# pi-squire

Hand a task to a named Pi agent, keep working, and get its result back in your
parent session. Squire runs background delegates in **tmux windows, Herdr tabs
or Paseo agents**, with optional managed Git worktrees for separate checkouts.
It keeps task/result tracking across reopening, asks the attended user about
unresolved project trust, and refuses cleanup when safety cannot be proved.
It is orchestration, not a permissions sandbox.

**Start here:** [Install](#install) → [First use](#first-use) →
[One setting](#one-setting). Need help? [Recovery](#recovery),
[troubleshooting](docs/troubleshooting.md), [update/uninstall](#update-and-uninstall).

## Install

Requirements: **macOS or Linux**, **Pi ≥1.5.0** (tested on 1.5.2), and one host:
**tmux ≥3.2** with Pi in a pane, **Herdr 0.9.5 / protocol 22** with Pi in a pane,
or a **Paseo 0.15.4-hosted Pi** with its CLI installed and daemon running.
You also need a provider of all four `message:*` hooks, including
`message:reply`: [pi-session-mail](https://github.com/gvanderclay/pi-session-mail)
**≥0.6.0** supplies them (tests pin 0.7.1). Without it, Squire refuses to launch.

```bash
pi install npm:pi-session-mail
pi install npm:pi-squire
```

These are personal installs; add `--local` to both for trusted project settings.
Restart or reload parent and delegate sessions after upgrading both packages.
For Git installs, runtime dependencies, host detection and environment handling,
see [Hosts](docs/hosts.md).

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

Every field is optional: for a legacy agent, without `model` and `thinking`
the delegate runs on your session's, and without `tools` it has your session's
tools (see [Agents](docs/agents.md#agents)). A bound role uses its routing policy instead;
see [Role/task routing](docs/routing.md#role-task-routing). The roster is read at
call time, so no reload is needed. Delegation guidance
for the parent is optional: save Markdown as
`<agent dir>/squire/delegation_prompt.md`, and it is read before each run.
Then, from a Pi session running in tmux, hand it a task:

```text
/delegate scout --label first Which files define the command-line entry point?
```

A detached tmux window named `scout-first` opens in your working directory.
When the delegate finishes, its answer reaches the parent as one `[delegate]`
message that links the task copy (see [Results](docs/results-and-recovery.md#results)), and the delegate then
closes its own window ([auto-exit](docs/results-and-recovery.md#auto-exit)).

Use `/delegate` with no arguments for the new-delegate form. Watch the compact
**Delegates** tree above the editor; at an empty prompt, Down selects a row,
Enter switches to its verified terminal, and x confirms subtree close.
`/delegate-open <id> --peek` previews a terminal without switching. Paseo has
no terminal: open the agent in its app. See [navigation](docs/delegation.md#navigation).

## One setting

To keep tmux delegates in your current session rather than the default shared
`<project>-delegates` companion, save this as
`<agent dir>/squire/settings.json` (not Pi's own settings file):

```json
{ "windowPlacement": "current" }
```

It applies on the next launch; existing windows do not move. Herdr and Paseo
ignore tmux placement. [Configuration](docs/configuration.md) gives every
setting's type, default, scope, read time and invalid-value behavior.

## Commands and tools

| Command | Purpose |
| --- | --- |
| `/delegate [<agent> … <task>]` | Start in the background, or open the form with no arguments. |
| `/delegate-open <id> [--switch\|--peek]` | Switch to or preview a verified terminal. |
| `/delegate-resume [<id> … <task>]` | Continue an exited direct child's session, or open the picker. |
| `/delegate-cleanup` | Preview managed resources and confirm eligible cleanup or narrow overrides. |
| `/delegate-clear <all\|provider\|provider/model>` | Clear stale usage-limit marks explicitly. |
| `/auto-exit` | Inside a delegate, re-enable exit after its next completion. |

| Tool | Purpose |
| --- | --- |
| `delegate` | Start a named agent and return its delegation id immediately. |
| `delegation_status` | Inspect task, window, workspace, usage and result paths; `all: true` shows the full inventory. |
| `delegation_close` | Fence and close a descendant subtree; keep its files and worktrees. |
| `delegation_cleanup` | Remove proved-safe merged, unused managed worktrees and local branches. |
| `delegation_resume` | Continue an exited direct child's existing session with a new task. |
| `delegation_fork` | Start a new delegation from a copy of a direct child's context. |

Fork and cleanup are deferred when a discovery tool is active. See the
[full tool reference](docs/delegation.md#tools) and
[launch syntax](docs/delegation.md#how-a-delegation-works).

## Recovery

Results arrive automatically as one `[delegate]` message; do not poll merely to
wait. If work appears stuck, use `delegation_status` for the id, session path,
mail envelope and fresh checkout observation. **An open window is not success;
an unknown host state is not disappearance.** A stopped task is held for later
successful completion; a failed reply is an outcome, not a successful task.

Reopen the same parent Pi session with the same agent directory to recover its
tracking and pending results. Open a delegate directly with the absolute session
path shown by status: `pi --session /absolute/path/<file>.jsonl`. Keep only one
Pi process per exact session id. To assign follow-up work to an exited direct
child, use `/delegate-resume <id> <task>` on tmux or Herdr; for Paseo start fresh.
See [results and recovery](docs/results-and-recovery.md) for resume/fork checks,
held results, outbox retries, usage and storage repair; use the
[symptom checklist](docs/troubleshooting.md) before deleting or retrying anything.

## Safety boundaries

- Agent tool lists restrict tool names, not arbitrary extension code or filesystem
  access. Permission policy remains each agent's permission provider's job;
  there is no permission inheritance. [Agents](docs/agents.md).
- Every delegate gets an explicit trust flag. Unresolved cross-project trust
  asks the attended root user; context files still load without project trust.
  [Project trust](docs/workspaces.md#project-trust).
- Managed worktrees separate checkouts, not permissions. Close does not remove
  worktrees. Cleanup refuses dirty, unmerged, live, foreign or uncertain resources
  unless a documented interactive override applies. **Ignored files inside a
  removed worktree are deleted too**, including `.env`, `.scratch/` and
  `node_modules/`. Checks reduce races, not exclude external users.
  [Cleanup and race limits](docs/workspaces.md#cleanup).
- Quitting/reloading a coordinator does not cascade through Squire; explicit close
  does. Paseo native parent archive can cascade: do not archive/delete a parent
  just to leave its app while children need to run. [Hosts](docs/hosts.md).
- Nesting and role routing are **experimental: shipped, not production-validated**.
  The default `maxDepth: 1` permits direct delegates only; deeper launches need
  agent grants and a higher limit. Keep nested use to isolated development
  fixtures pending integrated validation.
  [Nesting](docs/nesting.md), [routing](docs/routing.md).

## Host support

| Capability | tmux | Herdr | Paseo |
| --- | --- | --- | --- |
| Background delegate | Window | Tab in root workspace | Child agent; Paseo-hosted coordinator required |
| Navigation | Verified terminal switch/peek | Verified tab/pane switch/peek | App only; no terminal |
| Auto-exit | Closes owned pane; window goes only if last pane | Same for tab | Archives agent; explicit close deletes it; workspace stays |
| Resume / fork | Supported with checks | Supported with restore/session guards | Refused for hosts and sources; start fresh |
| `skills: false` / `context_files: false` | Honored | Honored | Refused before dispatch |
| Launch hook flags | Passed to Pi | Passed to Pi | Only supported fields translated; others refused |

[Full host matrix, versions and restrictions](docs/hosts.md#host-capabilities).
With both tmux and Herdr detected, set `multiplexer` explicitly; there is no
fallback from an unusable host. A Paseo-hosted Pi always uses Paseo.

## Update and uninstall

Use `pi list` to check the configured source and scope. For unpinned npm installs:

```bash
pi update npm:pi-session-mail
pi update npm:pi-squire
```

Or use `pi update --extensions` for all installed packages (plain `pi update`
updates Pi itself). Pinned versions/refs stay pinned: reinstall the desired
source/version with `pi install`, adding `--local` if that declaration is in
project settings. See [upgrading](docs/upgrading.md) **before** changing versions.
Restart or reload both parent and delegate runtimes together.

Before removal, inspect status, close tasks explicitly, and merge/back up then
clean eligible managed resources while Squire is still loaded. Then:

```bash
pi remove npm:pi-squire
```

Add `--local` for a project install; use the Git source instead if installed
from Git. Reload/restart to unload it. Uninstall is **not** permission to delete
agent files, running delegates, worktrees/branches, tree/outbox records, session
files or mail. Preserve those records for recovery, shared mail and user agent
files unless you explicitly choose otherwise. Removing pi-session-mail is a
separate decision: other sessions/extensions may need it.

## Reference

| Read when… | Page |
| --- | --- |
| Changing a setting or launch environment | [Configuration](docs/configuration.md) |
| Defining agents, tool bundles or locks | [Agents](docs/agents.md) |
| Configuring role/model policy | [Routing](docs/routing.md) |
| Choosing a host, placement or handling Herdr restart | [Hosts](docs/hosts.md) |
| Using forms, tools, navigation or explicit subtree close | [Delegation](docs/delegation.md) |
| Changing directory, trusting projects or cleaning worktrees | [Workspaces](docs/workspaces.md) |
| Inspecting results, statuses, usage or resuming/forking | [Results and recovery](docs/results-and-recovery.md) |
| Configuring nesting, grants or tree-wide budgets | [Nesting](docs/nesting.md) |
| Diagnosing a refusal, held result or missing task | [Troubleshooting](docs/troubleshooting.md) |
| Upgrading old configuration or durable records | [Upgrading](docs/upgrading.md) |
| Integrating hooks or checking compatibility/testing limits | [Integrations](docs/integrations.md) |

## Hooks

These three named JavaScript fences are executable contracts: `test/hooks.test.ts`
runs them unchanged. The examples receive `pi` (the extension API) and `assert`
(the test assertion library). See [integration contracts](docs/integrations.md#hooks)
for the full payloads, restrictions, lifecycle and provider requirements.

### `session:launch`

Synchronously append unrelated Pi arguments/environment keys; do not change
Squire's chosen cwd, trust, session identity or storage. Routed and nested
launches enforce additional restrictions. [Full contract](docs/integrations.md#sessionlaunch).

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

A synchronous frozen identity snapshot at exact-session startup; observe it,
do not treat labels or copied history as authority. Register before Squire;
there is no replay or veto. [Full contract](docs/integrations.md#squireidentity).

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

Trusted in-process providers can hold completion until their work is processed.
Check the current session's host map before promising a hold; this is not
durable recovery or an authorization API. [Full contract](docs/integrations.md#process-local-completion-holds-v1).

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

## Contributing

See [CONTRIBUTING.md](https://github.com/gvanderclay/pi-squire/blob/main/CONTRIBUTING.md) to set up, run the tests and open a pull
request. Changes by release are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, as stated in [LICENSE](LICENSE).

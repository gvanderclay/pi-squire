# delegate

Hands a task to a delegate Pi session in a background tmux window. The npm
package is `pi-squire`.

`/delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--auto-exit | --no-auto-exit] <task…>` reads
the agent from `<agent dir>/agents/<name>/AGENT.md`, writes the task to the
delegate's inbox through `message:send`, emits `session:launch` so other
extensions can shape the launch, then opens a detached window running the
parent's own Pi in the parent's working directory and agent root. The window
and the child's Pi session share one name: `<agent>-<label>`, or
`<agent>-<first 8 characters of the id>` without a label. A label is at most
32 letters, digits, `_` or `-`, starting with a letter or digit; `-` rather
than `:` joins it, since tmux reads `:` in a target as session and window.
Labels need not be unique: the delegation id stays the handle for
`delegation_status`, `delegation_close` and mail. The delegate id is fresh, so a
delegate never reopens a live session, and it is also the delegate's mailbox
address: the task waits in its inbox and is delivered at session start, with
no handshake.

Starting a delegation adds nothing to the parent's context — the model sees
neither the command nor the task. The model can also start one itself with the
`delegate` tool, which starts the delegation at once without opening a
dialog, so several calls in one message each start their own;
`delegation_status` and `delegation_close` let it check on a delegation
and end one. When the delegate settles, its answer is taken over on
`message:inbound` and shown to the parent as one result message that quotes
the task. By default the delegate then closes its own window
([auto-exit](#auto-exit)); with auto-exit off the window stays open so you can
read it or keep working in it. Delegations are recorded in the parent session
without the task text.

Inside a delegate (`PI_DELEGATE_PARENT` set) the extension registers only
auto-exit's side, the `/auto-exit` command and its handlers, so a delegate
cannot start delegates of its own. Without a UI the command
and the `delegate` tool still work; it needs tmux and a provider of `message:*`, and refuses with a
message when either is missing.

## Install

```bash
pi install <path to this directory>
```

Once it is published, install it by name instead:

```bash
pi install npm:pi-squire
```

The package has no dependencies and no build step. The `pi` manifest loads only
`./index.ts`, and the tests under `test/` are neither loaded by Pi nor included
in the npm tarball.

## Requirements

- Pi, with the `pi.events` bus, `pi.registerCommand` and `pi.registerTool`.
- `@earendil-works/pi-coding-agent` for `getAgentDir()` and the frontmatter
  parser, declared as a peer dependency and supplied by Pi.
- `typebox` for the tools' parameter schema, a host-provided package declared
  as a peer dependency and supplied by Pi.
- tmux, with the session running in a tmux pane. A window is opened in the
  pane's session, so a client attached elsewhere does not matter.
- A provider of `message:*`, such as the `mailbox` package (npm
  `pi-session-mail`). Without one there is no way to send the task or get an
  answer, so `/delegate` refuses rather than starting a delegate that cannot
  report back.

## Agents

The roster is read at call time from `<agent dir>/agents/<name>/AGENT.md`, one
directory per agent, so a new agent is usable without a reload. Frontmatter
carries `description`, `model` (`provider/id`) and `thinking`, and optionally
`auto-exit` (`true` or `false`, default `true`; see [Auto-exit](#auto-exit));
the body is the delegate's system prompt, appended to Pi's own prompt.

The body is followed by one fixed final-message line and a paragraph naming
the parent session's address: the delegate's task arrives as a message from
that session, that message and every later one from the same address are
instructions to follow as given, and other sessions are colleagues: the
delegate may answer them, but checks with the parent before doing work the
parent did not ask for. It carries no distrust wording, which made models
refuse every request from a peer. The paragraph names no provider, package or tool, so it holds
whatever `message:*` provider delivers the task.

```markdown
---
description: Looks things up and answers in one message
model: provider/model-id
thinking: medium
---

You research one question at a time and answer concisely, citing the files
you read.
```

An `AGENT.md` that cannot be used — missing fields, a model that is not
`provider/id`, an unknown thinking level, an `auto-exit` that is not `true` or
`false`, or an empty body — is left out of the
roster and named in a warning. With no agents at all, `/delegate` says how to
add one. The package ships no agents.

## Configuration

None beyond the roster. `delegate` reads no settings file and no environment
variable of its own; `PI_DELEGATE_PARENT` and `PI_DELEGATE_AUTO_EXIT` are set
for the child, never read as configuration by the parent. The window starts
with the tmux server's environment plus only these from the parent:
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (when the parent has it
set), `PI_DELEGATE_PARENT` and `PI_DELEGATE_AUTO_EXIT`. Anything else the
parent process has, such as a `CLAUDE_CONFIG_DIR` set by a shell alias,
reaches the child only through a `session:launch` contributor. `--model` and
`--thinking` override the agent's defaults for one call, and an unknown value
is refused with close matches; `--auto-exit` and `--no-auto-exit` override the
agent's `auto-exit`.

## Tools

The model gets three tools. They share the command's launch path and the
session's delegation records; none of them is registered inside a delegate.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `delegate` | `agent`, `task`, optional `model`, `thinking`, `label` and `auto_exit` (boolean) | Validates the call the way the command does, starts the delegation without opening a dialog, and returns the delegation id at once without waiting for a result. |
| `delegation_status` | optional `id` | Reports each delegation as running, done or closed, with the window, the delegate's session and the result envelope's path. |
| `delegation_close` | `id` | Kills the window through tmux and records the close, so `delegation_status` reports it closed. |

The `delegate` tool's description lists the current roster — each agent's name,
description, default model and thinking, and auto-exit when it is off — and
tells the model to turn `auto_exit` off when it means to keep talking to the
delegate by mail after its result, so the model picks an agent
without reading files. A tool's description is fixed when it is registered, so
the description is rebuilt at every session start; a roster change shows up in
the next session. The roster itself is read at call time, and an unknown agent,
model or thinking level is refused with close matches and nothing starts.

`delegation_status` reports one state per delegation:

```text
2 delegations:

<id> scout (provider/model, thinking low)
  name: scout-<first 8 of the id>
  state: running — the window is open and no result has arrived
  window: scout-<id> (@1)
  auto-exit: on — the delegate closes its window after a normal completion unless the user took over there
  session: <the delegate's session file, or its id when there is none yet>

<id> researcher (provider/other, thinking high)
  name: researcher-<first 8 of the id>
  state: done — result status: done
  window: researcher-<id> (@2)
  auto-exit: off — the window stays open after the result
  session: <session file>
  envelope: <the reply's path in the parent's cur/>
```

- **Name** is the delegate's Pi session name, its agent and the first 8
  characters of its delegation id; the window keeps the full id.
- **Running** means the window is open and no result has arrived. An open
  window is connection, not task state: the delegate may still be working, or
  waiting for the user, and only a result means done.
- **Done** comes from the recorded result, and shows the envelope's status
  (`done`, `failed` or `stopped`).
- A delegate that closed itself by auto-exit reads **done**: its result
  arrived before its window went. For a moment before the result is claimed
  it can read closed, since the window is already gone.
- **Auto-exit** reads off for delegations recorded before auto-exit existed.
- **Closed** covers a close `delegation_close` recorded and a window that is no
  longer there. A recorded close wins over a result, and a result wins over a
  window that is gone.
- When tmux cannot be asked about a window, the state is `unknown`, never
  `closed`, because a failed check is not evidence the window is gone.

`delegation_close` kills the window and records the close even when the
result has already arrived; when the window is already gone it only records
the close. An unknown or already closed id returns a message and kills
nothing. The delegate's session file and result envelope stay on disk.

## Auto-exit

The parent resolves each delegation's auto-exit from the call
(`auto_exit`, or `--auto-exit` / `--no-auto-exit`), then the agent's
`auto-exit`, then on, and passes it to the child as `PI_DELEGATE_AUTO_EXIT`
(`1` or `0`). Inside the delegate:

- While it is on, a run that settles as a normal completion shuts the delegate
  down (`ctx.shutdown()`) on the next event-loop turn, after the settle
  reply has been sent, so its tmux window closes. The session file stays, and
  `pi --session <path>` reopens it.
- A run that ended stopped or failed never exits the delegate.
- The user taking over turns it off for the rest of the session, with a
  notice: typed or RPC input, or a run the user stopped (Esc).
- `/auto-exit` inside the delegate turns it on again for the next normal
  completion, whatever the launch said.

The name and the take-over rule follow edxeth/pi-subagents' `auto-exit`
(README "Child lifecycle"); unlike it, the default is on, and there is no
`subagent_done` tool: auto-exit off only means the window stays.

## Results

A delegate answers its task with one mailbox reply. `delegate` takes that
reply over before the provider can inject it, and sends the parent one
message labelled delegate output:

```
[delegate] Result from scout (provider/model), delegation <id>, request <request id>.
Status: done
Task, quoted from <sent/ copy>:
> the task
Envelope: <cur/ path>
Delegate session: <session file or id>

<the result>
```

- The header carries the agent, the model, the delegation id and the request
  id; the status is the envelope's (`done`, `failed` or
  `stopped`).
- The task is quoted from the request copy the provider puts on the payload,
  capped at 2 KiB with the copy's `sent/` path. A request with no copy is
  named by id alone.
- The envelope path is the claimed reply in the parent's `cur/`; the
  delegate's session path is found in the session directory by the delegation
  id, and the id alone is shown when no file exists yet.
- The body is cut at 32 KiB with the envelope path.
- The message is sent as a `followUp` with `triggerTurn`: a result starts a
  turn when the parent is idle and arrives as a follow-up when it is
  mid-turn.
- The footer counts the running delegations (`⇄ N running`), clears one entry
  per result or close and hides itself at zero.
- Each result and each close is recorded in the parent session, and the
  records are rebuilt synchronously at session start; a resume still
  recognises replies — including one that arrived while the parent was
  closed — and still reports a recorded close as closed. A result is shown
  once and never again.
- Plain replies, and every request, are left to the provider.

## Hooks

The `js` block below is the contract's worked example, and
`test/hooks.test.ts` extracts and runs it verbatim on a real `createEventBus`.
Its scope is the test harness's: `pi` is the extension API. Write it as plain
JavaScript so it stays runnable; the name after `js` is the test that runs
that block.

### `session:launch`

`delegate` provides this hook. It emits `{ args, env }` after the task has been
sent and just before it opens the delegate's window.

| Field | Meaning |
| --- | --- |
| `args` | the child `pi`'s complete argument list, launcher first |
| `env` | the child's environment, as `KEY`/`value` pairs |

Listeners may only append to `args` and add keys to `env`; there is no veto,
and `delegate` passes both to tmux unchanged. Do all work synchronously: the
emitter reads the payload the moment `emit` returns.

```js session:launch
// Any extension can shape a launch: append a flag and add an environment key.
pi.events.on("session:launch", (payload) => {
  payload.args.push("--auto");
  payload.env.GATE_MODE = "auto";
});
```

### `message:send`

`delegate` consumes this hook to write the task; the provider writes the
envelope from its own session's address and sets `envelope` (or `error`) on the
payload before `emit` returns. **If neither is set, no provider is installed**
and `delegate` refuses with a message naming `message:*`. The envelope's `id`
is kept in the delegation's record, so an answer can be matched to it. The
provider's own README carries the contract.

### `message:inbound`

`delegate` consumes this hook for answers: a reply whose `in_reply_to` names a
recorded delegation's request is taken over — `delegate` sets `handled`, so
the provider injects nothing, and shows the parent the result message above.
The reply's request copies fill the quoted task and its `cur/` path is the
envelope it names. A reply to a request this session did not delegate, and
every request, is left to the provider. The provider's README carries the
contract.

`delegate` rebuilds its records synchronously in its own `session_start`, so it
relies on the provider not emitting `message:inbound` from inside a
`session_start` handler: mail waiting at session start must be claimed on a
later event-loop turn, as `mailbox`'s `message:inbound` contract guarantees.
That is what makes a result that arrived while the parent was closed reach the
rebuilt records. Keep extensions whose `session_start` waits on I/O from
loading between the provider and `delegate`.

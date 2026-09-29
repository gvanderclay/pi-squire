# delegate

Hands a task to a delegate Pi session in a background tmux window. The npm
package is `pi-squire`.

`/delegate <agent> [--model <provider/id>] [--thinking <level>] <task…>` reads
the agent from `<agent dir>/agents/<name>/AGENT.md`, writes the task to the
delegate's inbox through `message:send`, emits `session:launch` so other
extensions can shape the launch, then opens a detached window named
`<agent>-<id>` running the parent's own Pi in the parent's working directory
and agent root. The delegate id is fresh, so a delegate never reopens a live
session, and it is also the delegate's mailbox address: the task waits in its
inbox and is delivered at session start, with no handshake.

Starting a delegation adds nothing to the parent's context — the model sees
neither the command nor the task. When the delegate settles, its answer is
taken over on `message:inbound` and shown to the parent as one result message
that quotes the task; the window stays open after it so you can read it or
keep working in it. Delegations are recorded in the parent session without
the task text.

Inside a delegate (`PI_DELEGATE_PARENT` set) the extension registers nothing,
so a delegate cannot start delegates of its own. Without a UI the command
still works; it needs tmux and a provider of `message:*`, and refuses with a
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

- Pi, with the `pi.events` bus and `pi.registerCommand`.
- `@earendil-works/pi-coding-agent` for `getAgentDir()` and the frontmatter
  parser, declared as a peer dependency and supplied by Pi.
- tmux, with the session running in a tmux pane. A window is opened in the
  pane's session, so a client attached elsewhere does not matter.
- A provider of `message:*`, such as the `mailbox` package (npm
  `pi-session-mail`). Without one there is no way to send the task or get an
  answer, so `/delegate` refuses rather than starting a delegate that cannot
  report back.

## Agents

The roster is read at call time from `<agent dir>/agents/<name>/AGENT.md`, one
directory per agent, so a new agent is usable without a reload. Frontmatter
carries `description`, `model` (`provider/id`) and `thinking`; the body is the
delegate's system prompt, appended to Pi's own prompt.

```markdown
---
description: Looks things up and answers in one message
model: provider/model-id
thinking: medium
---

You research one question at a time and answer concisely, citing the files
you read. Ask no questions: work from the task you were given.
```

An `AGENT.md` that cannot be used — missing fields, a model that is not
`provider/id`, an unknown thinking level or an empty body — is left out of the
roster and named in a warning. With no agents at all, `/delegate` says how to
add one. The package ships no agents.

## Configuration

None beyond the roster. `delegate` reads no settings file and no environment
variable of its own; `PI_DELEGATE_PARENT` is set for the child, never read as
configuration. `--model` and `--thinking` override the agent's defaults for
one call, and an unknown value is refused with close matches.

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
  id; the status is the envelope's (`done`, `failed`, `stopped` or
  `needs-input`).
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
  per result and hides itself at zero.
- Each result is recorded in the parent session, so the same reply is never
  shown twice; the records are rebuilt at session start, so a resume still
  recognises replies — including one that arrived while the parent was
  closed.
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

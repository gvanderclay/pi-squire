# pi-squire

Starts a delegate Pi session in a background tmux window and shows you its result.

You give a task to a named agent with the `/delegate` command, or the model does
it with the `delegate` tool. The delegate works in its own tmux window and
answers with one message, which the parent session shows as a result.

## Install

You need:

- Pi 0.80.5 or later, on macOS or Linux (not Windows). Pi 1.0.0 is the version
  pi-squire is tested with. The floor is the first installable release with
  the `agent_settled` event (added in 0.80.4, which was never published to
  npm); `--exclude-tools` needs 0.77.0 and `--session-id`
  0.76.0. The extension uses the `pi.events` bus, `pi.registerCommand` and
  `pi.registerTool`; Pi supplies the peer dependencies
  `@earendil-works/pi-coding-agent` and `typebox`.
- tmux 3.0 or later, with the Pi session running in a tmux pane. That is the
  first version with `new-window -e`. A window is opened in the pane's
  session, so a client attached elsewhere does not matter.
- A provider of `message:*`;
  [pi-session-mail](https://github.com/gvanderclay/pi-session-mail) is one
  example. Without a provider there is no way to send the task or get an
  answer, so `/delegate` refuses rather than start a delegate that cannot
  report back.

With pi-session-mail as the provider, for example, install both from npm:

```bash
pi install npm:pi-session-mail
pi install npm:pi-squire
```

To follow the latest commit of pi-squire instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-squire
```

The package has no runtime dependencies and no build step.

## First use

The package ships no agents, so create one first. `<agent dir>` is Pi's agent
directory: `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when that is set. Save this
as `<agent dir>/agents/scout/AGENT.md`, replacing `provider/model-id` with a
model your Pi can use:

```markdown
---
description: Looks things up and answers in one message
model: provider/model-id
thinking: medium
exclude-tools: edit, write
---

You research one question at a time and answer concisely, citing the files
you read.
```

The roster is read at call time, so no reload is needed. Then, from a Pi
session running in tmux, hand it a task:

```text
/delegate scout --label first Which files define the command-line entry point?
```

A detached tmux window named `scout-first` opens in your working directory.
When the delegate finishes, its answer reaches the parent as one `[delegate]`
message that quotes the task (see [Results](#results)), and the delegate then
closes its own window ([auto-exit](#auto-exit)).

## How a delegation works

`/delegate <agent> [--model <provider/id>] [--thinking <level>] [--label <name>] [--auto-exit | --no-auto-exit] <task…>`
reads the agent from `<agent dir>/agents/<name>/AGENT.md`, writes the task to
the delegate's inbox through `message:send`, emits `session:launch` so other
extensions can shape the launch, then opens a detached window running the
parent's own Pi in the parent's working directory and agent root. The agent's
prompt reaches the child as a path to a private file under the system
temporary folder, not as text on the command line.

- The window and the child's Pi session share one name: `<agent>-<label>`, or
  `<agent>-<first 8 characters of the id>` without a label. A label is at most
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
  the delegate then closes its own window ([auto-exit](#auto-exit)). With
  auto-exit off the window stays open so you can read it or keep working in it.
- Delegations are recorded in the parent session without the task text.
- Inside a delegate (`PI_DELEGATE_PARENT` set) the extension registers only
  auto-exit's side, the `/auto-exit` command and its handlers, so a delegate
  cannot start delegates of its own.
- Without a UI the command and the `delegate` tool still work. They need tmux
  and a provider of `message:*`, and refuse with a message when either is
  missing. In print mode (`pi -p`) Pi does not show the refusal notices, so
  the refusal is silent there.

## Agents

The roster is read at call time from `<agent dir>/agents/<name>/AGENT.md`, one
directory per agent, so a new agent is usable without a reload. Frontmatter
carries `description`, `model` (`provider/id`) and `thinking`, and optionally
`auto-exit` (`true` or `false`, default `true`; see [Auto-exit](#auto-exit)),
`exclude-tools` and `fallback`. The body is the delegate's system prompt,
appended to Pi's own prompt; it reaches the child as a path to a private file
under the system temporary folder, so the text stays off the command line. The
[first-use example](#first-use) is a complete `AGENT.md`.

`exclude-tools` names the tools the delegate goes without, as a
comma-separated list (`exclude-tools: edit, write`) or a YAML list
(`exclude-tools: [edit, write]`). It reaches the child as
`--exclude-tools edit,write`, which Pi subtracts from the tools it would
otherwise turn on. It is a denylist only: without it the delegate gets every
tool, and no flag is passed. There is no per-call override. Each name is
checked against the tools the parent session has registered
(`pi.getAllTools()`), since Pi ignores an unknown name without a word. The
delegate's result reaches the parent through the `message:*` provider's reply
when its run settles, not through a tool, so excluding tools cannot stop it
answering.

`fallback` lists models to try, in order, when the agent's `model` is
usage-limited (see [Usage limits](#usage-limits)), as a comma-separated list
or a YAML list of `provider/id`. An entry that is not `provider/id` is dropped
with a warning; the agent still loads.

The body is followed by one fixed final-message line and a paragraph naming the
parent session's address. The delegate's task arrives as a message from that
session, and that message and every later one from the same address are
instructions to follow as given. Other sessions are colleagues: the delegate
may answer them, but checks with the parent before doing work the parent did
not ask for. The paragraph names no provider, package or tool, so it holds
whatever `message:*` provider delivers the task.

An `AGENT.md` that cannot be used is left out of the roster and named in a
warning. That covers missing fields, a model that is not `provider/id`, an
unknown thinking level, an `auto-exit` that is not `true` or `false`, an
`exclude-tools` that is not a list of names or names a tool the session does
not have, and an empty body. With no agents at all, `/delegate` says how to
add one.

## Configuration

None beyond the roster. `pi-squire` reads no settings file and no environment
variable of its own. `PI_DELEGATE_PARENT` and `PI_DELEGATE_AUTO_EXIT` are set
for the child, never read as configuration by the parent. The window starts
with the tmux server's environment plus only these from the parent:
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (when the parent has it
set), `PI_DELEGATE_PARENT` and `PI_DELEGATE_AUTO_EXIT`. Anything else the
parent process has, such as a `CLAUDE_CONFIG_DIR` set by a shell alias,
reaches the child only through a `session:launch` contributor. `--model` and
`--thinking` override the agent's defaults for one call, and an unknown value
is refused with close matches, and so is a model with no configured
credentials. An API key that exists only as an environment variable in the
parent's shell does not reach the delegate, so log in through Pi or make the
variable part of the tmux server's environment. `--auto-exit` and `--no-auto-exit` override the
agent's `auto-exit`.

## Tools

The model gets three tools. They share the command's launch path and the
session's delegation records. None of them is registered inside a delegate.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `delegate` | `agent`, `task`, optional `model`, `thinking`, `label` and `auto_exit` (boolean) | Validates the call the way the command does, starts the delegation without opening a dialog, and returns the delegation id at once without waiting for a result. |
| `delegation_status` | optional `id` | Reports each delegation as running, done, closed or closed without a result, with the window, the delegate's session and the result envelope's path. |
| `delegation_close` | `id` | Kills the window through tmux and records the close, so `delegation_status` reports it closed. |

The `delegate` tool's description lists the current roster, one line per agent:
its name, description, default model and thinking, auto-exit when it is off,
and its excluded tools.

```text
- scout — Read-only recon (default provider/model-id, thinking low, auto-exit off, no edit/write)
```

The model picks an agent from these lines without reading files. The
description also tells the model to turn `auto_exit` off when it means to keep
talking to the delegate by mail after its result. A tool's description is
fixed when it is registered, so the description is rebuilt at every session
start, and a roster change shows up in the next session. Pi cannot list the
session's tools while extensions load, so the description built then skips the
`exclude-tools` check, and the one built at session start applies it. The
roster itself is read at call time, and an unknown agent, model or thinking
level is refused with close matches and nothing starts.

`delegation_status` reports one state per delegation:

```text
2 delegations:

<id> scout (provider/model, thinking low)
  name: scout-<first 8 of the id>
  state: running — the window is open and no result has arrived
  window: scout-<first 8 of the id> (@1)
  auto-exit: on — the delegate closes its window after a normal completion unless the user took over there
  session: <the delegate's session file, or its id when there is none yet>

<id> researcher (provider/other, thinking high)
  name: researcher-<first 8 of the id>
  state: done — result status: done
  window: researcher-<first 8 of the id> (@2)
  auto-exit: off — the window stays open after the result
  session: <session file>
  envelope: <the reply's path in the parent's cur/>
```

- **Name** is the delegate's Pi session name, its agent and the first 8
  characters of its delegation id.
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
- **Closed without a result** is what the poll records when a window is gone
  and no reply arrived (see [Results](#results)). A result outranks it, so a
  late reply turns it into **done**; a close from `delegation_close` outranks
  both.
- When tmux cannot be asked about a window, the state is `unknown`, never
  `closed`, because a failed check is not evidence the window is gone.

`delegation_status` also ends with a `Usage-limit marks:` block, one line per
active mark: its scope, source (`reactive` or `proactive`), clear time and
reason (cut to about 120 characters), then one line per provider whose last
quota reading failed. The block is left out when there is neither, and shows
even when no delegation is recorded. The details gain a `marks` array of
`{ scope, source, reason, clearsAt }` and a `readingErrors` array (see
[Usage limits](#usage-limits)).

`delegation_close` kills the window and records the close even when the
result has already arrived. When the window is already gone it only records
the close. An unknown or already closed id returns a message and kills
nothing. The delegate's session file and result envelope stay on disk.

## Usage limits

When a delegate's run ends on a usage-limit error, it records a mark in
`pi-squire-limits.json` in Pi's agent directory, which every Pi session on the
machine reads. Quota messages count, and so does a `429` that survived Pi's
retries; overloaded and `5xx` errors do not. A mark covers the failing
model's whole provider, except for a free model (an id ending in `-free`, or
zero cost in Pi's registry), which is never covered by a provider mark and,
when it is the one that failed, is marked alone.

A mark clears at the reset time the error states ("try again in 30 minutes",
`resets_at`), otherwise after 5 minutes, doubling on each repeat hit up to 6
hours. When the failed response's headers state a reset (`retry-after`,
`anthropic-ratelimit-*-reset`, `x-ratelimit-reset-requests` or `-tokens`),
that time wins over the error text. Until then `delegate` and `/delegate`
refuse a marked model passed as `model` / `--model`, and say when it clears.

Without an explicit model, the delegation launches on the agent's model, or
else on the first of its `fallback` models that has credentials and is not
marked. The tool result and the command's notice then say, for example, "Used
fallback opencode-go/b because alpha/fast-model is usage-limited until …", and
the result details list the skipped models under `skipped`. When every
candidate is marked or unusable, the call is refused with one line per
candidate and why it was skipped.

Before a launch, pi-squire also reads the OpenCode Go quota for a paid
`opencode-go` candidate (`GET https://opencode.ai/zen/go/v1/usage`, with the
provider's API key). A window at 100% or more, or one the provider reports as
`rate-limited`, skips the candidate and records a `proactive` mark on
`opencode-go`, for example "Go 5h window at 100%", that clears at that window's
reset time (the 5-minute cooldown when none is given). A reading is reused for
60 seconds. Free models and other providers are never read, and a candidate that
is already marked is skipped without a read. The key is sent only to
`https://opencode.ai`, with redirects refused: a provider or model base URL on
another origin means no request at all.

For an `anthropic` candidate used through a Claude subscription (an OAuth
login; API-key users get no proactive check and rely on reactive marks),
pi-squire reads Claude Code's own usage cache, the `cachedUsageUtilization`
field of `$CLAUDE_CONFIG_DIR/.claude.json` (`~/.claude.json` when the variable
is unset). It never calls Anthropic's usage endpoint. A 5-hour or 7-day window
at 100% or more records a `proactive` mark on `anthropic`, cleared at that
window's reset time. A model-scoped weekly window at 100% (for example Opus)
marks only the `provider/model` candidates whose name or id contains the scope
name, so other Anthropic models stay usable. The check reads the cache as it
stands and never waits: when the cache is missing or older than 5 minutes,
pi-squire starts `claude -p /usage --no-session-persistence` in the background
(in a temporary directory, output discarded, killed after 30 seconds) so Claude
Code rewrites it, at most once every 5 minutes per Pi process. A missing `claude`
binary or config directory is ignored.

A failed reading (for Go: no key, a base URL off the Go origin, a non-2xx answer, an
unreadable body, a timeout, a network error; for Claude: a missing or unreadable cache) never blocks a launch. The tool
result and the command's notice gain "Could not read <provider> quota:
<reason>; launched without a proactive check.", and `delegation_status` lists the
provider's last reading error and its time under the `Usage-limit marks:` block
and in a `readingErrors` array of `{ provider, reason, at }`.

A mark can be stale (the quota came back, or the plan changed). Only you clear
one, with `/delegate-clear <target>`: `all`, a provider (its mark and every
model mark under it), or `provider/model` (that model's mark and the provider
mark covering it). Clearing also forgets the repeat-hit history, so the next
hit starts at 5 minutes again, and drops the cached quota reading so the next
launch reads it afresh. With no argument, or one matching no active
mark, it changes nothing and lists the active marks. No tool clears marks.

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

There is no `subagent_done` tool: auto-exit off only means the window stays.

## Results

A delegate answers its task with one reply through the `message:*` provider.
`pi-squire` takes that reply over before the provider can inject it, and sends
the parent one message labelled delegate output:

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
- Stopping a delegate's run (Esc) sends no result: the provider holds the
  task, so the delegation stays running while the user steers it. The next
  run that completes sends the result, `done`, and its body opens with a note
  that the user took over partway.
- A `failed` reply from a delegate that recorded a usage-limit mark (see
  [Usage limits](#usage-limits)) gets one more line right after `Status:`,
  for example `Usage limit: the delegate hit a usage limit on provider
  opencode-go; it is marked until 2026-10-03T12:05:00.000Z and later
  delegations skip it.` (a model scope reads `on model provider/id`; a mark
  that has since cleared reads `it was marked until …`). A failed reply with
  no such mark is unchanged.
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
  records are rebuilt synchronously at session start. A resume still
  recognises replies, including one that arrived while the parent was
  closed, and still reports a recorded close as closed. A result is shown
  once and never again.
- Plain replies, and every request, are left to the provider.

While any delegation is running (no result, no close), the parent polls every
5 seconds; the timer does not keep the process alive and stops when nothing is
running and on `session_shutdown`. Each tick first emits `message:scan`, so the
provider claims waiting replies, and then lists the tmux windows once and
matches each still-running delegation to a window by id and name (window ids
restart with every tmux server). A window whose program has exited counts as
gone. A delegation whose window is gone and still has no result after that
scan is recorded as closed without a result, a record separate from
`delegation_close`'s, and the parent gets one `[delegate]` message naming the
delegation, with the delegate session path when one is found, sent as a
`followUp` with `triggerTurn`. A tick declares nothing when nobody answers
`message:scan` or when tmux reports an error. A reply that arrives later is
still delivered and makes the delegation done. A resumed session polls again
for every delegation it restores as running.

## Hooks

The `js` block below is the contract's worked example, and
`test/hooks.test.ts` extracts and runs it verbatim on a real `createEventBus`.
Its scope is the test harness's: `pi` is the extension API. Write it as plain
JavaScript so it stays runnable; the name after `js` is the test that runs
that block.

### `session:launch`

`pi-squire` provides this hook. It emits `{ args, env, agent }` after the task
has been sent and just before it opens the delegate's window.

| Field | Meaning |
| --- | --- |
| `args` | the child `pi`'s complete argument list, launcher first |
| `env` | the child's environment, as `KEY`/`value` pairs |
| `agent` | the agent's name, as in `<agent dir>/agents/<name>/AGENT.md`; read it, do not change it |

Listeners may only append to `args` and add keys to `env`; there is no veto,
and `pi-squire` passes both to tmux unchanged. Do all work synchronously: the
emitter reads the payload the moment `emit` returns.

```js session:launch
// Any extension can shape a launch: append a flag and add an environment key.
pi.events.on("session:launch", (payload) => {
  payload.args.push("--auto");
  payload.env.GATE_MODE = "auto";
});
```

### `message:send`

`pi-squire` consumes this hook to write the task; the provider writes the
envelope from its own session's address and sets `envelope` (or `error`) on the
payload before `emit` returns. **If neither is set, no provider is installed**
and `pi-squire` refuses with a message naming `message:*`. The envelope's `id`
is kept in the delegation's record, so an answer can be matched to it. The
provider's own README carries the contract.

### `message:inbound`

`pi-squire` consumes this hook for answers: a reply whose `in_reply_to` names a
recorded delegation's request is taken over. `pi-squire` sets `handled`, so
the provider injects nothing, and shows the parent the result message above.
The reply's request copies fill the quoted task and its `cur/` path is the
envelope it names. A reply to a request this session did not delegate is left
to the provider.

Inside a delegate, `pi-squire` also takes over the task: a `request` whose
`from` is the parent's address. It sets `handled` and sends the task as a user
prompt labelled `[delegate]`, so the run starts the way a typed prompt does.
Pi 1.0.0 starts a turn for an injected custom message without preparing the
system prompt, so a fresh delegate's first request would otherwise carry no
context files, skills or role paragraph
([earendil-works/pi#5581](https://github.com/earendil-works/pi/issues/5581)).
The provider still arms the automatic answer for a request a listener took
over. Every other message to the delegate is left to the provider. `pi-squire` reads `from` and requires
it to be the sender's address, which for a delegate is its session id; a reply
from any other sender is left to the provider, even when it answers a recorded
request. The provider's README carries the contract.

`pi-squire` rebuilds its records synchronously in its own `session_start`, so it
relies on the provider not emitting `message:inbound` from inside a
`session_start` handler: mail waiting at session start must be claimed on a
later event-loop turn, as pi-session-mail's `message:inbound` contract guarantees.
That is what makes a result that arrived while the parent was closed reach the
rebuilt records. Keep extensions whose `session_start` waits on I/O from
loading between the provider and `pi-squire`.

### `message:scan`

`pi-squire` consumes this hook on every poll tick (see Results): it emits `{}`,
and the provider claims the mail waiting in its inbox, emitting each reply as
`message:inbound`, before setting `scanned` to `true` on the payload and
returning from `emit`. Only then does `pi-squire` check windows, so a reply
written just before a window closed is never mistaken for no reply. **If
`scanned` is not set, nobody answered**, and the tick declares nothing closed,
because a waiting reply cannot be ruled out. The provider's README carries the
contract.

## Compatibility

While pi-squire is below 1.0, breaking any contract below bumps the minor
version and is listed under "Breaking" in [CHANGELOG.md](CHANGELOG.md).

Other extensions may rely on:

- the `session:launch` payload `{ args, env, agent }`, emitted synchronously
  after the task is sent and before the window opens (see [Hooks](#hooks));
- the `message:send`, `message:inbound` and `message:scan` hooks, consumed as
  their sections document;
- the `delegate`, `delegation_status` and `delegation_close` tool names and
  parameters;
- the `/delegate` syntax and flags;
- the `[delegate]` result text and the closed-without-a-result text;
- `AGENT.md`'s frontmatter keys and its location,
  `<agent dir>/agents/<name>/AGENT.md`;
- the child environment variables `PI_DELEGATE_PARENT` and
  `PI_DELEGATE_AUTO_EXIT`.

A `message:*` provider must:

- implement `message:send`, `message:inbound` and `message:scan` as documented
  under [Hooks](#hooks);
- set a reply's `from` to the sender's address, so the delegate's reply can be
  matched to its task;
- reply on its own when the delegate's run settles, since that reply is what
  becomes the result.

## Contributing

See [CONTRIBUTING.md](https://github.com/gvanderclay/pi-squire/blob/main/CONTRIBUTING.md) to set up, run the tests and open a pull
request. Changes by release are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, as stated in [LICENSE](LICENSE).

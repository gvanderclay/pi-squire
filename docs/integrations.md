# Integration contracts

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Hooks](#hooks)
  - [session:launch](#sessionlaunch)
  - [squire:identity](#squireidentity)
  - [Process-local completion holds (v1)](#process-local-completion-holds-v1)
  - [message:send](#messagesend)
  - [message:reply](#messagereply)
  - [message:inbound](#messageinbound)
  - [message:scan](#messagescan)
- [Testing limits](#testing-limits)
- [Compatibility](#compatibility)

## Hooks

The executable worked examples remain in [README.md](../README.md#hooks), where
`test/hooks.test.ts` extracts and runs them verbatim. The API in those examples
is `pi`, with `assert` supplied by the test harness.

### `session:launch`

`pi-squire` provides this hook. It emits
`{ args, env, agent, cwd, toolCallId, parent, root, depth, chain }`
just before it opens the delegate's window. Legacy launches send the task first;
resumes send it once the window is open (see [Resuming a
delegation](results-and-recovery.md#resuming-a-delegation)). Routed launches validate the hook's
protected values before any task is sent, regardless of whether the host would
otherwise open before delivery.

| Field | Meaning |
| --- | --- |
| `args` | the child `pi`'s complete argument list, launcher first |
| `env` | the child's environment, as `KEY`/`value` pairs |
| `agent` | the agent's name, as in `<agent dir>/agents/<name>.md` or `<cwd>/.pi/agents/<name>.md` (never its `display_name`); read it, do not change it |
| `cwd` | the directory the window opens in, the parent's or the resolved `--cwd`; read it, do not change it |
| `toolCallId` | the ID of the `delegate`, `delegation_resume` or `delegation_fork` tool call that started the launch; absent when started from the `/delegate` or `/delegate-resume` command; read it, do not change it |
| `parent` | Read-only direct parent session id. |
| `root` | Read-only root session id; retained on resume. |
| `depth` | Read-only numeric child depth, root = 0; retained on resume. |
| `chain` | Read-only frozen array of roster agent names ordered root downward, including the current child last; no session ids. |

Listeners may only append to `args` and add keys to `env`. For ordinary
legacy launches there is no veto, and top-level launches pass both through to
tmux. For routed launches, pi-squire validates the final values and refuses a
hook change to model/thinking, session identity/storage or trust/consent; it
also refuses broader tools or removal of a routing-required tool. Routed hooks
may add unrelated flags/environment keys or narrow tools, and validation occurs
before task delivery. For nested launches and resumes, after all listeners
return, pi-squire resolves the final tool selection and appends an authoritative
exact-name `--tools` registration allowlist bounded by the direct parent. This
limits which tool names the child can register and reach, including names
provided by hook-added extensions, late registrations and MCP. It does not
limit extension code or implementations registered under allowed names;
unrelated arguments/environment keys survive. For nested launches and resumes,
final customized arguments that Pi cannot parse refuse the launch before the
window opens.
An empty final set also receives `--no-tools` and an empty allowlist so earlier
selection flags cannot restore tools. Do all work synchronously: the emitter
reads the payload the moment `emit` returns.

Environment additions are not a secret transport. They can be visible in tmux
command arguments and a fresh companion's first pane start command to anyone
with access to its socket. pi-squire never copies the parent's full process
environment into these arguments.

`cwd`, the trust flag (`--approve` or `--no-approve`), `--session-dir` and the
session choice (`--session-id` for a new delegate, `--session` for a [resumed](results-and-recovery.md#resuming-a-delegation)
one, `--fork` with `--session-id` for a [fork](results-and-recovery.md#forking-a-delegation)) are launch invariants that `pi-squire` chooses. The window opens in its own `cwd`,
whatever a listener assigns to the payload. A listener must not add another
trust flag, `--session-dir`, `--session`, `--fork` or `--session-id`, or a working-directory change to `args`, since
that would launch a child whose trust or session storage the parent did not
choose and cannot find; append only unrelated settings. Routed launches also
protect model, thinking, consent and selected tools as described above.

See the executable [session:launch example](../README.md#sessionlaunch).

### `squire:identity`

`pi-squire` emits this synchronous, read-only notification from its identity
restore handler in `session_start`, before its later asynchronous startup work.
The payload is `{ sessionId, status, identity? }` for the active exact session id:

- `status: "delegate"`: its saved identity passed Squire's validation and was
  successfully persisted again. `identity` contains only
  `{ parent, root, agent, chain, depth }`, with the same meanings as
  `session:launch`.
- `status: "root"`: no identity record exists for that exact id. This is absence
  of Squire delegate identity, not proof that the session is an original root.
- `status: "invalid"`: reading, validating or persisting its identity failed.
  No prior identity or raw error is included; Squire's existing restore error
  and launch/completion refusal remain in effect.

The payload, identity projection and copied `chain` array are frozen. Internal
placement and auto-exit state are not exposed. Environment variables, display
labels and copied transcript entries are not identity authority.

Pi 1.3 and 1.4 recreate the extension runtime and dispatch `session_start`
after new, fork/clone and session switch/import; reload also dispatches it.
Each restore reads only the destination's exact id, so a new/forked session
without its own record reports `root`, not the source's delegate identity.
This event does not adopt sessions or migrate records.

Register listeners before Squire loads and do all observation synchronously.
The bus does not replay notifications, await asynchronous listeners, acknowledge
listener success or veto later startup; listener exceptions are reported by Pi.
Consumers own resetting their state at session shutdown/replacement, matching
`sessionId` to their current context, and handling missing or invalid
notifications. A consumer that must initialize before another extension's
`session_start` must load its listener before Squire, and Squire before that
extension. This is an observation seam, not an authorization gate or a provider
integration.

See the executable [squire:identity example](../README.md#squireidentity).

### Process-local completion holds (v1)

Squire composes external work with its existing completion predicate through a
provider-neutral data table at `globalThis[Symbol.for("pi.completion-holds.v1")]`:

```ts
{
  version: 1,
  hosts: Map<sessionId, Map<hostName, runtimeToken>>,
  holds: Map<sessionId, Map<holdId, { provider: string, ready: boolean }>>
}
```

An active Squire runtime registers `"pi-squire"` with a fresh string runtime token
only during its exact session's `session_start`, after process ownership is
acquired. A losing duplicate does not advertise support. Every
`session_shutdown`, including reload, removes only that runtime's matching host
token. Stale shutdown cannot remove a replacement's registration.

Providers must check for a well-formed, nonempty host map for the current exact
session before promising a hold. Register a unique hold id with `ready:false`
atomically before launching the work; refund only that provisional entry if
launch fails. Keep accepted entries across reload, including while the provider
is unavailable. Set `ready:true` only after the terminal result has been observed
and successfully processed; the provider owns that decision and its normal-run
commit, before Squire reads readiness at `agent_settled`. Squire neither observes
external output nor decides whether an operation succeeded.

All current-session holds must be well formed and ready before Squire sends a
new final task reply, marks its tree entry finished, or auto-exits. An absent
table or no holds preserves normal completion. A malformed table/version or
malformed current-session host/hold entry blocks completion; Squire does not
overwrite it to repair storage. Other sessions' holds do not block this session.
An absent host does not invalidate already-ready entries; it refuses promises
of new holds. Providers clear only their own holds at non-reload teardown;
Squire never removes provider entries.

This is trusted in-process extension data, not a model-callable release API,
cross-process registry, durable reopen block, or authorization boundary. There
are no callbacks in the table, fake child tasks, polling/continuation loops, or
automatic model calls to keep a session alive. Ordinary shutdown cancels the
provider's work; reopening does not recover these holds. Already-frozen reply
outboxes retain their existing retry semantics.

This executable observer loads after Squire and checks only the host contract:

See the executable [completion-holds:v1 example](../README.md#process-local-completion-holds-v1).

### `message:send`

`pi-squire` consumes this hook to write the task; the provider writes the
envelope from its own session's address and sets `envelope` (or `error`) on the
payload before `emit` returns. **If neither is set, no provider is installed**
and `pi-squire` refuses with a message naming `message:*`. The envelope's `id`
is kept in the delegation's record, so an answer can be matched to it. The
provider's own README carries the contract.

### `message:reply`

After the final run settles (including fallback continuations and the durable
child-first processing barrier), squire emits
`{ to, inReplyTo, body, status }`: the direct parent's address, the owed request
ids in batches of at most 50, the exact result text, and `done` or `failed`.
The provider must synchronously set `envelope` or `error`; neither means no
provider. Squire keeps the task owed until the write succeeds and completion
is recorded. The provider's README owns the transport contract.

For task/identity/child-task storage, frozen-answer retries and at-least-once
transport, see [Delivery and durable state](results-and-recovery.md#delivery-and-durable-state).

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
Squire durably records its parent and request id before starting the task;
it owns the answer through `message:reply`. The provider arms no automatic
request answer. Every other message to the delegate is left to the provider.
`pi-squire` reads `from` and requires
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

## Testing limits

The automated tests drive the extension through fake Pi lifecycles. The
reusable `test/mail-harness.ts` runs multiple independent extension instances
with the real, exactly pinned pi-session-mail 0.7.1 over an isolated shared
mail root. Protocol tests cover correlation, asks, stops, fallback, pending
answers, retries and duplicate delivery after the write/completion crash
window. These are not real model runs or real process-crash tests. They check
the registered tool definitions, the structured prompt options a simulated run
preparation receives, file handling, visibility gating and the existing launch
and result paths. They do not prove actual Pi event scheduling, final provider
requests, compaction, cache behavior, or model obedience. The idle-result wake
is simulated by dispatching the next preparation; the suite does not assert
that the runtime emits it.

Working-directory and trust tests use real temporary Git repositories and
Pi's real trust store under a temporary agent directory, but a fake tmux. The
existing-directory/inherited launch evidence does not verify startup for a
managed worktree or prove that a real delegate loads the selected checkout's
instructions and settings; actual Pi/tmux startup and resource loading remain
unverified. Snapshot tests use real repositories and,
for hung, failing or flooding Git, a scripted `git` on `PATH`.

## Compatibility

While pi-squire is below 1.0, breaking any contract below bumps the minor
version and is listed under "Breaking" in [CHANGELOG.md](../CHANGELOG.md).

Other extensions may rely on:

- the `session:launch` payload
  `{ args, env, agent, cwd, toolCallId, parent, root, depth, chain }`, emitted
  synchronously before the window opens (legacy launches send the task first;
  routed launches validate protected values before task delivery; resumes send
  after the window is open), with `cwd`, the trust flag and `--session-dir`
  chosen by `pi-squire` (see [Hooks](#hooks));
- the `message:send`, `message:reply`, `message:inbound` and `message:scan` hooks, consumed as
  their sections document;
- the `delegate`, `delegation_status`, `delegation_close`, `delegation_resume` and `delegation_fork` tool names,
  parameters, the recorded `workspace` shape and the `workspaceSnapshot`
  shape in results and status;
- the `/delegate` and `/delegate-resume` syntax and flags, and their
  no-argument forms: `/delegate` opens the new-delegate form and
  `/delegate-resume` the resume picker;
- `/delegate-open <id>` with its `--switch` and `--peek` flags;
- the `[delegate]` result text and the closed-without-a-result text;
- the agent file's frontmatter keys, including opt-in `routing_profile`, and
  its locations, `<agent dir>/agents/<name>.md` and, in a trusted project,
  `<cwd>/.pi/agents/<name>.md`; plus the v1 `<agent dir>/squire/routing.json`
  policy and per-call `routing` metadata contract;
- the `maxDepth`, `maxConcurrentDelegates`, `maxDelegatesPerRoot`, `delegateTools`, `toolBundles`,
  `multiplexer`, `windowPlacement`, `companionSuffix`, `worktreeRoot`, `resultBodyKiB`,
  `delegateWidgetPlacement` and `delegateWidgetMaxEntries` settings in
  `<agent dir>/squire/settings.json`;
- the optional `<agent dir>/squire/delegation_prompt.md` file and the
  `squire_parent_delegation` system-prompt section;
- the child environment variables `PI_DELEGATE_PARENT`, `PI_DELEGATE_ROOT`,
  `PI_DELEGATE_DEPTH`, `PI_DELEGATE_AGENT`, `PI_DELEGATE_CHAIN`,
  `PI_DELEGATE_AUTO_EXIT`, `PI_DELEGATE_MULTIPLEXER`, `PI_DELEGATE_FALLBACK` and
  `PI_UNATTENDED=1`.

A `message:*` provider must:

- implement `message:send`, `message:reply`, `message:inbound` and `message:scan`
  as documented under [Hooks](#hooks);
- set a reply's `from` to the sender's address, so the delegate's reply can be
  matched to its task;
- write explicit request replies through `message:reply`, without automatically
  answering requests at settle; asks remain separately owned by the provider.

# Troubleshooting

[Home](../README.md) · [Results and recovery](results-and-recovery.md) · [Configuration](configuration.md)

- [Delegate doctor](#delegate-doctor)
- [Task or result never arrives: mail namespaces](#task-or-result-never-arrives-mail-namespaces)
- [Cleanup is kept: stale Paseo daemon descriptor](#cleanup-is-kept-stale-paseo-daemon-descriptor)
- [Window state is unknown, or navigation is unavailable](#window-state-is-unknown-or-navigation-is-unavailable)
- [Launch refuses a model, or the child reports missing credentials](#launch-refuses-a-model-or-the-child-reports-missing-credentials)
- [A stopped task or held result does not complete](#a-stopped-task-or-held-result-does-not-complete)
- [“This Pi session is already open in another process”](#this-pi-session-is-already-open-in-another-process)
- [Resume is refused after an upgrade](#resume-is-refused-after-an-upgrade)

Start with `delegation_status` for one id (or `all: true` for the full inventory).
Keep the delegation id, request id, session path, envelope path and the exact
refusal. Inspect records read-only before retrying; an unknown observation is
not permission to delete records or launch another copy.

## Delegate doctor

Run `/delegate-doctor` before a first launch or after a prerequisite refusal.
It reports the selected tmux/Herdr/Rex/Paseo host and selection source (Paseo host,
explicit Squire setting, launcher inheritance or environment), the selected
adapter’s availability preflight, usable agent count and paths, agent parse
warnings, project-agent trust, Squire/Pi settings parsing, and Pi’s reported
session directory. A parsed settings object is not validation of every value;
a reported directory is not proof of writability.

Mail has no handler-listing or version-negotiation API. Doctor sends separate
**invalid-input** `message:send` and `message:reply` probes, which a conforming
provider rejects synchronously before writing. It reports only whether a
handler answered, not that mail can be delivered or replied to. It does not
scan/claim waiting mail, send a real task, open a host resource, change trust,
or repair files. Missing handlers name `pi install npm:pi-session-mail` and
reloading/restarting parent and delegate sessions; a tool result instead asks
the user to install one. A missing roster names the interactive starter or the
exact user-agent directory.

In TUI/RPC the report uses Pi’s notification UI. In print/JSON, where Pi’s
notification UI is a no-op, the report and command refusals use **stderr**:

```bash
pi -p /delegate-doctor
pi --mode json /delegate-doctor
```

JSON stdout remains JSONL; no fake user/custom model message is injected and no
model turn starts. Refusal diagnostics do not change Pi’s slash-command exit
status: neither a zero exit code nor a successful preflight is a task result.
Look for the actual `[delegate]` result.

## Task or result never arrives: mail namespaces

**Read-only check:** confirm that both runtimes load a provider of all four
`message:*` hooks. Compare the parent, tmux server/Herdr pane/Rex terminal/Paseo daemon's
mail-root settings without dumping credentials or the whole environment.
With pi-session-mail, only an absolute `PI_SESSION_MAIL_ROOT` selects that root;
otherwise an absolute `XDG_STATE_HOME` selects its `pi-session-mail/` directory,
otherwise its home default applies. Empty/relative values do not select a root.

**Fix:** set the same absolute `PI_SESSION_MAIL_ROOT` in the parent before new
launches, and configure/restart affected existing runtimes consistently. Squire
copies these explicit variables but cannot query the provider's effective root.
Do not delete shared mail. Upgrade mail and Squire together, then reload/restart
both sides. See [environment propagation](configuration.md#configuration) and
[provider lifecycle](integrations.md#messageinbound).

## Cleanup is kept: stale Paseo daemon descriptor

**Read-only check:** read the reason in the cleanup result. Check the recorded
daemon home (current home for records without receipts), descriptor/pid and
whether that exact daemon is running. A dead pid with unverifiable host/boot
identity, malformed/unreadable descriptor, failed authentication, timeout, or
missing socket with a live pid is ambiguous, not positive absence. Do not probe
a different daemon and treat it as proof about the recorded workspace.

**Fix:** restore the correct daemon or repair its stale descriptor only after
independently verifying that its daemon has ended; retry cleanup so it can
re-prove workspace identity and users. Do not bypass the receipt check or remove
a worktree merely because the daemon cannot be contacted. See
[cleanup's absence and ambiguity rules](workspaces.md#cleanup).

## Window state is unknown, or navigation is unavailable

**Read-only check:** inspect status and the host's window/tab/pane listing.
Verify the exact recorded locator, not just a title. Check that the same tmux
server, Herdr session or Rex server/session is reachable. A moved Herdr pane or replaced terminal,
changed live locator, failed host query, or absent attached tmux client can
explain refusal. Transcript mtime and quiet telemetry are only hints.

**Fix:** restore host access or return the Herdr pane to its original workspace;
retry observation. After Herdr restart, close a restored tab yourself before
Squire resume; Squire will not adopt its new terminal. Do not force close a
window that only shares a name. Unknown state does not free tree capacity or
release a coordinator's child barrier. See [host recovery](hosts.md#resume-fork-and-herdr-restarts)
and [navigation](delegation.md#navigation).

## Launch refuses a model, or the child reports missing credentials

**Read-only check:** check the chosen model, agent defaults/fallbacks and active
usage-limit marks in status. Check credential readiness in the child's host
context, not only the parent's. Avoid printing API keys into logs or chat.
Tmux and Paseo do not copy all parent environment variables; Herdr and Rex inherit
its parent's environment, excluding host-routing keys.

**Fix:** log in through Pi, configure the tmux server/Paseo daemon environment,
or use a reviewed `session:launch` contributor for needed values. Routed models
must also meet policy constraints; a credential fix does not bypass those.
Only clear a stale usage-limit mark deliberately with `/delegate-clear`.
See [credentials and environment](configuration.md#configuration),
[launch-hook exposure risks](integrations.md#sessionlaunch) and
[usage limits](results-and-recovery.md#usage-limits).

## A stopped task or held result does not complete

**Read-only check:** distinguish a held user stop from a failed final reply, an
unfinished child, an unprocessed child outcome, a completion hold, or a storage/
provider error. Look for `could not handle the task reply` and retained outbox
facts. An open window is not completion; a finished accounting entry is not proof
that the direct parent received or processed its result.

**Fix:** after a user stop, give later input to continue; failed intermediate
runs do not answer that held task. A root's explicit replay hold survives reopen;
previously held outcomes wait for later input or a genuinely fresh outcome.
Repair provider/storage failures, then reload/reopen the same exact session and
agent directory to retry a frozen answer without a model call. Do not overwrite
or discard the outbox; later run text does not replace a frozen answer. External
completion-hold providers own marking their work processed. See
[results](results-and-recovery.md#results),
[delivery and durable state](results-and-recovery.md#delivery-and-durable-state),
and [completion holds](integrations.md#process-local-completion-holds-v1).

## “This Pi session is already open in another process”

**Read-only check:** inspect the named PID and owner record under
`<agent dir>/squire/owners/`. Verify whether that process is live/paused and owns
this exact Pi session id in this agent directory. This protection is Squire's
process ownership, not a detector for every unrelated Pi process.

**Fix:** return to the existing owner and shut down the duplicate. For a truly
stale/corrupt owner record, first verify that the original owner has ended and
stop affected Squire runtimes, then repair only that record and reopen once.
Never evict a live owner, remove live lock tickets, force adoption, or clear the
tree/outbox to bypass a refusal. If input could not be staged because storage
was unwritable, repair storage and ask the sender to resend the named envelope.
Ordinary mail/asks are not protected by Squire's staging safeguard. See
[exact-session restoration and ownership](results-and-recovery.md#restoring-and-inspecting-a-delegation-tree).

## Resume is refused after an upgrade

**Read-only check:** inspect the refusal for missing original-root placement
identity, an obsolete resumed record, wrong parent, missing cwd/session file,
live owner, active subtree-close fence, host restrictions or routing metadata.

**Fix:** return to the direct parent and newest chain record where supported.
Records without required placement identity have no migration; do not invent
identity or delete history to make them resumable. Paseo requires the original
Paseo-hosted direct parent, an archived agent and its unchanged Pi session
file/cwd; pass only id and task. Deleted/mismatched or routed sources require a
fresh delegation. See [upgrading](upgrading.md) and
[resume requirements](results-and-recovery.md#resuming-a-delegation).

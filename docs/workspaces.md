# Workspaces, trust and cleanup

[Home](../README.md) · [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)

- [Working directory](#working-directory)
  - [Managed worktrees](#managed-worktrees)
  - [Cleanup](#cleanup)
  - [Interactive cleanup: /delegate-cleanup](#interactive-cleanup-delegate-cleanup)
  - [Checkout snapshots](#checkout-snapshots)
  - [Project trust](#project-trust)

## Working directory

`--cwd <dir>` (the `delegate` tool's `cwd`) runs the delegate in an existing
directory instead of the parent's: another checkout, a linked worktree, a
subdirectory or a directory outside Git.

- A relative path resolves against the parent's working directory. A leading
  `~` or `~/` means your home directory. Nothing else is expanded: no
  environment variables, globs or `~user`.
- The directory must exist and be readable. Its real path, with symlinks
  resolved, is where the window opens and what is recorded. A missing path,
  a file or a directory that cannot be entered is refused before the task is
  sent or a window opens; nothing is created.
- The directory is used as it is. Its branch, index, uncommitted and
  untracked files are not touched when the delegate starts, fails to start or
  is closed, and pi-squire never cleans it up.
- The delegate's Pi finds context files (`AGENTS.md`), project settings,
  skills and extensions from that directory and its ancestors, as Pi always
  does. Context files load even without project trust, so trust is not an
  instruction-safety boundary.
- The delegate's appended prompt names the selected directory. A delegate in
  the parent's own directory is not told its cwd again.
- The model may leave `cwd` out, or send `null`, `""`, `"null"`, `"none"`,
  `"false"` or `"undefined"`; each means the parent's directory. A boolean,
  number, array or object is refused. `/delegate --cwd` treats those same
  strings the same way.
- Write a value with spaces in double quotes:
  `/delegate scout --cwd "~/work/my repo" Read the README`. Inside the quotes
  `\"` is a quote and `\\` a backslash; there is no other escaping or shell
  expansion. The task after the flags is kept exactly as typed, quotes and
  backslashes included. A missing closing quote or a missing value is refused
  before anything starts.

Each new delegation records a `workspace`: its `mode` (`inherited` for the
parent's directory, `existing` for `--cwd`), its `cwd` and the Git checkout at
launch. `git` is one of:

- `{ kind: "git", identity: { mainRoot, commonDir, checkoutRoot }, position, head, baseline }`,
  where `position` is `{ branch, detached: false }` or
  `{ branch: null, detached: true }` and `baseline` is the commit checked out
  at launch (`null` in a repository with no commits yet);
- `{ kind: "non-git" }` when Git says the directory is not in a checkout;
- `{ kind: "unknown", reason }` when Git is missing, times out (5 seconds per
  question) or fails. That never blocks a launch and is not a claim that the
  directory is outside Git.

Git is asked read-only, without optional index locks. The start message
names the directory when it differs from the parent's; the tool's
structured result always carries `cwd` and `workspace`, and status, results
and their expanded views show them.

### Managed worktrees

`--worktree <branch>` (or the `worktree` tool input) creates a new local branch
and worktree from this session's checkout, or from the existing checkout named
by `--worktree-source <dir>` (tool input `worktree_source`). Relative sources
resolve from this session's cwd; `~`, symlinks, linked worktrees and repository
subdirectories are accepted. The delegate starts at the created root. Its base
is the selected checkout's committed `HEAD`, or `--worktree-base <commit-ish>`
(the tool input `worktree_base`). The base resolves only against locally available branches, remote-tracking refs, tags, commits or commit-ish expressions; Squire does not fetch. The exact commit is frozen before creation. An explicit commit works even if source `HEAD` is unborn; without an override an unborn `HEAD` is refused. The default
location is a sibling directory named `{repo}-worktrees/{branch}`, with `/` in
the folder segment replaced by `-`; the branch name itself is unchanged.
`worktree_source` and `worktree_base` require `worktree`; `cwd` and `worktree` cannot be combined. An unrelated source repository uses its own saved trust decision; when undecided, protected resources in the frozen base and applicable destination ancestor skills are reviewed in the parent before creation. Branches and destinations are never
reused, reset, suffixed or force-created. Git creation uses the frozen commit,
not a later moving `HEAD`.

Dirty staged, unstaged and untracked source paths are summarized in the start
notice and recorded; none are copied. Ignored files remain in the source and
are not transferred. No setup or submodule initialization is performed.
The delegate starts at the created worktree root with factual branch and base
context.

Managed placement is selected on every creation from the optional
`<agent dir>/squire/settings.json` file (separate from Pi's `settings.json`):

```json
{
  "worktreeRoot": "~/worktrees/{repo}/{branch}",
  "worktreeRootByRepo": {
    "/Users/me/src/special-project": "../special-checkouts/{branch}"
  }
}
```

A matching `worktreeRootByRepo` entry wins over `worktreeRoot`, which wins
over the built-in `{repoParent}/{repo}-worktrees/{branch}` default. Repository
keys identify the canonical main checkout root, even when creation starts from
a linked worktree; keys and relative templates resolve from the settings
directory, and `~`/`~/` expands to the home directory. Templates accept
`{repoParent}` (the main checkout's parent), `{repo}` (its directory name) and
`{branch}` (the branch with `/` replaced by `-` for this path only). For a
main checkout at `/Users/me/src/special-project` and branch `feature/topic`,
the built-in path is
`/Users/me/src/special-project-worktrees/feature-topic`. With `~` set to
`/Users/me`, the global example resolves to
`/Users/me/worktrees/special-project/feature-topic`; if the settings directory
is `/Users/me/.pi/agent/squire`, the matching relative override resolves to
`/Users/me/.pi/agent/special-checkouts/feature-topic`. The Git branch remains
`feature/topic`.

Worktree placement keys are read only for managed creation. A missing file
uses the built-in default; invalid templates and duplicate canonical repository
keys refuse creation rather than silently falling back. Those creation-key
errors do not affect inherited or `cwd` launches, but malformed, inaccessible
or non-object shared settings refuse every launch/resume with an error naming
the file (see [Configuration](configuration.md#configuration)). Placement does
not choose a source checkout or base commit. Pi discovers `AGENTS.md`, skills
and other project context from the created directory and its ancestors, so the
chosen layout determines which instructions and skills apply. For a layout
inside another checkout, arrange any needed Git ignore rule yourself;
pi-squire never edits `.gitignore`.

A launch attempt is recorded before Git creation. If launch fails before a
window is known to have opened, pi-squire removes only a checkout and branch
it can prove it created and that remain pristine; it never uses force. Changed,
ignored, untracked or uncertain resources are retained and reported with
recovery facts. A timeout or other ambiguous tmux failure retains the worktree.
A host that mails the task before opening has already delivered it by then, so
a rolled-back attempt keeps its request id and reports that the task was mailed
and was not recalled.
Once tmux returns a window id, the worktree and branch are kept through later
failure, completion and close. After merging, use `delegation_cleanup` to remove
proved-safe managed worktrees and local branches (see [Cleanup](#cleanup)).
Worktrees isolate checkouts, not delegate permissions or filesystem access.

Paseo placement receipts are saved as soon as the daemon acknowledges placement,
including in retained or interrupted launch attempts. Agent/session recovery
identities are saved as they become known, before configuration and task mail.
`delegation_status` shows a partial launch's Paseo recovery target: inspect that
id in Paseo before closing it manually. A rolled-back attempt reports that no
delegate window or agent was created and no managed worktree remains, and names
no recovery target, even when an older record stored the requested id. A lost
creation acknowledgement proves neither creation nor absence, so an uncertain
launch is not automatically deleted.
Cleanup accepts an attempt's exact `created` receipt when retained, or interrupted
with last phase `created`, only after its normal Git and no-live-user checks;
opened/reused receipts never authorize tool-triggered archive.

### Cleanup

Call `delegation_cleanup` after merging a delegate's work, not while you still
need its checkout. Pass `ids: ["<delegation id>", ...]` or `all: true` (not
both). Authority is limited to the caller's descendants. Discovery includes
legacy managed starts and retained/interrupted-after-creation attempts, even
a grandchild's. Inherited and existing directories are never candidates.
Aliases of one worktree are checked once and each requested id gets an outcome.

The tool is deferred, like `delegation_fork`: a parent with active
`codemode`, or `tool_search` on a model that keeps its prompt cache when tools
are added, reaches it without paying for its declaration
([which models](delegation.md#tools)). Otherwise it is declared at startup,
coordinators included.

Cleanup requires the recorded repository, worktree registration and created
branch still to match; a locked, prunable, detached or replaced checkout stays.
It checks all Squire tree registries in this agent directory, live owners and
session-header working directories, pending reservations and the caller's host's
windows. Close running delegations with `delegation_close` first.

Paseo launches record the daemon home, workspace id, directory, project and
whether Squire created, opened or reused the workspace. Only a `created`
receipt (including an alias's receipt for that same workspace) permits tool-triggered archive.
Opened, reused and path-found workspaces are kept by the tool: Squire did not create them.
The interactive `/delegate-cleanup` command can ask you to archive one such workspace.
Older records need no receipt: when the daemon is available, a workspace at
the exact directory keeps the worktree; if none exists, Git cleanup proceeds.
A receipt with an unavailable daemon keeps the item: its persisted workspace
cannot be verified or archived while the daemon is down. Without a receipt,
cleanup skips Paseo checks only on **positive absence**: a missing `paseo.pid`,
a recorded local pid that no longer exists, or a refused daemon TCP port or Unix
socket. These checks do not load the SDK. A live pid alone does not prove availability; Squire probes
the socket and authenticates with the daemon. A descriptor without a pid still
needs the socket probe. Malformed/unreadable descriptors, timeouts, failed
authentication and other ambiguous failures keep the item with the specific
reason, even for tmux-only worktrees. When a daemon is available, the foreign
workspace policy above still applies. A dead pid with a mismatched or unverifiable
recorded host/boot identity stays ambiguous; a missing socket path with a live pid
also stays ambiguous (only connection refusal proves absence).

Before archive, the directory and project must match, the workspace must not
be internal, archiving, Paseo-owned, running setup or running a script, and no
unarchived agent (including internal/background agents) or terminal may use
its id or a cwd inside the worktree. Even the delegate's own agent counts.
Archive runs only after nonmutating Git safety proof. Squire then re-lists
the workspace and its users before the final synchronous Git re-check and
removal; an archive that leaves a workspace or user is `partial` and skips Git.
A successful archive followed by a Git refusal is also `partial`.
**Paseo schedules are not checked**: the supported SDK has no schedule-list API. A schedule
aimed at an archived workspace fails on its next run.

Staged, unstaged, conflicted and non-ignored untracked files, in-progress Git
operations and gitlinks all block cleanup. **Ignored files inside the worktree
are deleted with it**: `node_modules/`, `.scratch/`, build output and a
hand-made ignored `.env` are not backups. A nested repository or different
filesystem inside an ignored directory blocks cleanup. The directory walk is
bounded to 200,000 directories or 10 seconds; an incomplete check keeps the item.

Merge proof is local: no commits beyond the recorded base, ancestry to the main
checkout's branch or its upstream or `origin/HEAD`, or an exact merged `gh` PR
head from this repository whose merge commit is in a matching local target.
Squire never fetches. Missing/stale refs, absent/failing `gh`, or ambiguous
evidence keep the item; fetch and retry. An upstream marked `[gone]` is not
merge proof: a deleted branch after an unmerged closed PR, or local commits
after the last push, look the same as a merge. The tool has no discard/force option;
use `/delegate-cleanup` for confirmed overrides. Remote branches are untouched.

The result carries `items`, `counts` and, for `all`, `selection`. An item is
`removed`, `kept`, `partial` (resources remain after removal, or a failed
removal may have deleted some content) or `already-clean`, with a reason and
observed `remains`. When Git is already clean but a recorded Paseo workspace
cannot be verified, the overall outcome is still `kept`, not `already-clean`.
The text reports "Git already-clean; Paseo workspace unverified" with the daemon
failure, and additive `resources` observations report
`{ git: "already-clean", paseo: "unverified" }`; receipt-less ambiguous checks also
report `paseo: "unverified"`, adding `git: "already-clean"` when observed. Retry
after restoring the daemon to verify/archive the remaining workspace; a previous successful cleanup is not
cached as proof. Opened/reused receipts still receive the tool\'s foreign-workspace
refusal without contacting the daemon, alongside any already-clean Git observation;
use `/delegate-cleanup` for confirmation. Completed worktree removals have a bounded `ignoredRemoved`
path summary; an incomplete directory removal does not claim an ignored count.
Kept text groups reasons and shows at most ten ids per group. Calls process at most 50 worktree groups,
and stop starting new worktrees after about 120 s; the rest are listed in
`selection.omittedIds`. A group already in progress finishes with its own
Git-command timeouts. Pass those ids next so kept groups cannot starve them.
Partial removal or failed selection sets the tool error flag. Retry re-derives
the facts from Git, including a branch left after worktree removal.

### Interactive cleanup: `/delegate-cleanup`

Run `/delegate-cleanup` in an interactive session to preview the same descendant
worktree candidates as `delegation_cleanup({ all: true })`, without removing anything:

1. One confirmation lists proven-safe items with their paths, local branches
   and ignored-entry counts.
2. A separate confirmation lists items whose upstream is marked `[gone]`
   and that have no foreign Paseo workspace, including the upstream name, tip and
   unique-commit count. **Merge is not proved**; accepting can discard work.
   A `[gone]` item with a foreign workspace goes to the stricter per-item
   selector instead.
3. A selector offers kept items only when their remaining blockers are unmerged
   commits and/or a Paseo workspace Squire did not create. Pick one for its own
   confirmation, naming branch, tip and unique commits versus the local target,
   plus the foreign workspace id, title and creation time when applicable, and
   every workspace id to be archived (including Squire-created ones at the same
   path or in other recorded daemon homes). There is no "yes to all".
   Multiple foreign workspaces at one path stay kept; resolve them
   individually in Paseo before retrying.

Each confirmation and selector expires after 60 seconds. Decline, Escape,
timeout or Done keeps the unconfirmed items. Without UI the command refuses
before discovery or mutation. Results appear as notifications, never a model
message or a new model turn. The preview processes at most 50 groups and stops
starting new groups after about 120 seconds, like the tool.

Each yes is bound to the worktree path, exact branch tip, upstream tracking
state and stable Paseo workspace identity/safety facts, not volatile daemon
activity, status, diff, forge or script-health observations. Squire repeats the
full proof before archiving or removing; changed facts abort that item with
"changed since you confirmed; nothing removed". Ignored files are deleted here
too. The command never forces Git, fetches, touches remote branches, or overrides
dirty files, locks, live users or other safety blockers. A foreign workspace
gets the same live-user and setup/script checks as a Squire-created one.
**Paseo schedules are not checked**; a schedule aimed at an archived workspace
fails on its next run. If a race or failure occurs after an archive or removal,
the result is `partial`, not a claim that nothing changed.

Cleanup serializes with managed launches in this process, refreshes the
records and window states after entering that queue, and synchronously
rechecks identity, registries/owners and Git status/state just before
`git worktree remove` (never forced). It checks for a recreated checkout
before deleting the local branch at the proved tip using compare-and-swap.
No new durable cleanup record is written; missing managed directories show
`workspace removed` in status and cannot resume.

Concurrency limits: a launch/resume/fork reserving after the final check can
open a window in the removed directory and fail loudly; non-ignored files it
writes make Git refuse removal. Older Squire versions did not record cwd at
reservation. External shells/editors, other agent directories, session files
outside the scanned directories (or missing session headers), and custom
`worktreeRoot` without `{branch}` cannot be excluded. Paseo checks use the
recorded daemon home (the current home for records without a receipt); other
daemons are not scanned. Paseo can report no terminals when its terminal query
fails, and a user appearing during workspace archive can be archived with it.
Window checks use only the caller's host and run in preflight. In the instant between
the final worktree-list check and branch deletion, another process recreating
the branch can lose its branch ref; its worktree keeps HEAD's commit. These
checks reduce races, not exclude arbitrary external use.

### Checkout snapshots

A result records one snapshot of the delegation's checkout, taken when the
reply arrives, and `delegation_status` takes a fresh one on every call. The
result's snapshot is history: a later status never changes it. Both are a
`workspaceSnapshot`, one of:

- `{ kind: "git", position, head, baseline, ahead, workingState, committed, pending }`:
  the current branch or detached HEAD, the head commit, the launch commit
  (`baseline`), how many commits are reachable from head but not from the
  baseline, `clean` or `dirty`, the paths changed between baseline and head
  (`committed`), and the `pending` paths, split into `staged`, `unstaged`,
  `untracked` and `conflicted`. A clean working tree can still have commits
  and committed paths since launch;
- `{ kind: "non-git" }` for a directory launched outside Git that still exists;
- `{ kind: "unknown", reason }` when the directory is gone, its checkout root
  or Git common directory is no longer at the location recorded at launch, its
  launch commit is missing, Git is missing,
  fails or passes a limit, its Git state at launch was unknown, or the record
  predates workspaces. Only the recorded checkout is inspected, never the
  parent's.

Each path list is `{ paths, total, truncated }`: at most 100 whole paths and
16 KiB of names per list, with `total` counting all of them. Paths come from
NUL-separated Git output and are shown JSON-quoted, so spaces and newlines in
a name stay data; a rename lists both its old and new path. An inspection
gives each Git command 2 seconds, the whole checkout 5 seconds and 4 MiB of
output; a command still running at its limit is killed. Past any of those
limits the snapshot is unknown, never a partial count, and stdout and stderr
count together toward the 4 MiB. Committed paths are relative to the
repository root whatever `diff.relative` says. Git runs read-only, without
optional index writes.

A snapshot observes the Git state at the recorded location, not that it is the
same repository on disk: a repository replaced there, for example by a fresh
clone, that still has the launch commit is reported normally against that
commit. It is not proof that the delegate made those changes, that the task
succeeded, or that the branch is safe to merge.
It does not say whether the branch is merged anywhere, prints no cleanup
command, and nothing acts on it.

### Project trust

The requesting parent resolves the delegate's trust flag before task mail,
worktree creation or a window opens. Unresolved choices go to the root user,
not to an intervening model or an unattended delegate UI. A same-repository
managed worktree uses the requester's current trust for that repository.
The model has no trust input; every launch/resume still passes explicit
`--approve` or `--no-approve`.

1. A directory in the parent's own repository, by Git's common directory, so
   including its linked worktrees, gets the parent's current trust, even a
   decision the user made for this session only. It never carries to another
   repository or to a directory outside Git.
2. Otherwise a saved decision in Pi's trust store applies, found the way Pi
   finds it (the closest saved directory at or above the key). The key is the
   main repository root for a linked worktree of another repository, and the
   directory itself for everything else, including a subdirectory of another
   main checkout or a main checkout whose Git directory lives elsewhere
   (`--separate-git-dir`), so a nearer saved denial there still wins. A
   linked worktree whose main checkout Git cannot name, such as one of a bare
   repository, has an unknown Git state and is keyed by its own directory.
3. With no saved decision and no project resources that Pi gates behind trust
   (`.pi/settings.json`, extensions, skills and the like, or an
   `.agents/skills` directory above it), the delegate starts with
   `--no-approve` and no question.
4. Otherwise the root asks, naming the requesting agent chain, requester
   session id, directory, the main repository when it is the key, and what each
   answer saves:
   `Trust`, `Trust parent folder (<folder>)` (left out at the filesystem
   root), `Trust (this session only)`, `Do not trust` and
   `Do not trust (this session only)`. The two "this session only" answers
   apply to this launch alone and save nothing. "Trust parent folder" saves
   the folder and clears a decision saved for the key itself. Cancelling
   starts nothing. One question is open at a time; a question that waited
   reads the store again, so an answer just saved is not asked twice. Aborting
   the turn or tool call stops a launch that is waiting for or answering a
   question; nothing is saved, sent or opened.

An unresolved nested question requires the same root Pi session to be running
with dialog-capable UI (TUI or RPC), without `PI_UNATTENDED=1`. An absent root or
refused connection fails without waiting for a timeout; a disconnected root fails
its pending launches, rather than waiting for the root to return. Already-resolved
trust and resource-free targets need no root connection. A root's own trust in a
different repository never supplies approval. For a top-level launch without UI,
open Pi in the trust key directory named by the refusal (the source/main checkout
for a managed worktree), answer its trust question, then delegate again.

Root questions, local and remote together, are serialized, even while the
root model is busy. Each request has a **10-minute deadline including queue
wait**. Escape, tool/turn cancellation, requester or root shutdown/reload/session
replacement, disconnection and expiry cancel that launch and dismiss its
question; canceled queued requests are skipped. An unrelated root model run's
abort does not cancel a remote request. Late decisions cannot save trust or
start the canceled work. A new launch after reopening makes a new request;
pending requests and decisions are never replayed.

Squire uses an authenticated **127.0.0.1 loopback connection**, not mail or
`session_mail_ask`, for this control. The root writes its random port and
per-runtime token to the owner-only
`<agent dir>/squire/trust/<SHA-256 of root id>.json` descriptor. Only squire
reads it; no provider files, APIs or tool grants are needed. Unreachable
endpoints fail on the connection error without waiting for a timeout. Connection
establishment and authentication together are bounded to five seconds, allowing
brief synchronous work in a busy root without extending the dialog deadline.
A fresh client-nonce/HMAC handshake verifies the root before sending any
question or secret, so a reused stale port cannot impersonate it. Root restart
changes the token, invalidating old frames.
The descriptor is transient and removed on ordinary shutdown; a crash can
leave a harmless stale descriptor that cannot approve anything. Like the rest
of squire, this is not an OS boundary against processes running as you.

Only the live **requester** saves a persistent choice in that agent directory's
Pi `trust.json`, after cancellation/deadline checks and before launch.
The root holds the queue until the requester has applied the answer or
disconnected, so queued requests re-read saved decisions. The two session-only
choices save nothing and apply only to that launch. `Do not trust` launches
untrusted; Escape cancels instead. A trust store that cannot be read or written
refuses the launch; nothing is granted by default.

Model questions still use `session_mail_ask` to the direct parent, parent by
parent. Permission prompts remain with the permission provider, with each
child's own agent policy: there is **no permission inheritance**. Its bridge
can label a requester with `PI_DELEGATE_CHAIN` (comma-separated roster names,
root downward including the current delegate); `session:launch.chain` is the
corresponding frozen string array. Routing uses separate parent/root session
ids, not chain names. Squire does not implement that permission bridge.

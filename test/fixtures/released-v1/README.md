# Executable released shared-state fixture

Frozen from tag `v0.20.2`, commit
`c27b082d19662bdca37f5d4fb02e94b3037ed4ac`, not from the new locator code:

- `tree-registry.mjs`: complete released `src/tree-registry.ts`.
- `tree-close.mjs`: complete released `src/tree-close.ts`.
- `windows.mjs`: complete released `src/windows.ts`.
- `child-tasks.mjs`, `results.mjs`, `result-restore.mjs`, `tree-view.mjs`, and
  `poll.mjs`: complete released local store, transcript restore, result processing,
  historical lookup, and poll implementations. They deliberately read legacy
  records WITHOUT any new locator decoder, wrapper or journal namespace.

Type annotations were stripped with Node's `stripTypeScriptTypes`; imports were
relocated, and Biome formatting was applied. Function bodies are otherwise the
released implementation. Do not update these snapshots when production changes.

The fixtures share unchanged production filesystem/lock, fence, cap, owner,
task-store, session-id and placement helpers. Those files were compared against
the tag. The imported `isStarted` function is unchanged too (the unrelated
`deriveState` in that module changed in ticket 03). None routes through a new
locator decoder or registry loader. Using the same lock/path is essential:
old/new actors must contend on the real mutex, not isolated compatibility stores.

`../tree-version-process.ts` drives either implementation in separate processes,
with gates at the old asynchronous window listing, old locked transaction, and
actual new temporary-file/atomic-rename boundary. The regression includes a
positive control reproducing the unsafe version-1 historical-publication/close
behaviour; the frozen reader is not a stub that simply rejects version 2.

`../local-version-process.ts` executes the actual released ChildTasks restore/save
and Results/transcript/poll paths. Its timer seam runs one real poll tick directly;
it does not replace the window matcher, decoder, save guards or result logic.
A second positive control shows that the shared registry barrier alone cannot
stop an old parent poisoning local gone facts. The v2 local wrapper and v2 start
namespace tests cover the delayed/unclaimed-child and append-before-local-save
crash gap, including a journal with no corresponding local start record.

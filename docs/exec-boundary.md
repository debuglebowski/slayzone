# The exec boundary: what runs on a runner, what stays on the hub

Every call that crosses an exec seam is either **workspace** work (routed to the
task's runner, because the files it touches live there) or **hub-owned** work
(never routed, because the thing it touches belongs to the hub process).

This file exists because that distinction was previously discovered by watching e2e
fail — four separate times, each revealing another hub-owned call that had been
wrongly routed. Enforcing "runners run the agents" without this table written down
is how task creation, task archiving, and the app's own boot got broken.

**The rule:** if a call reads or writes something under the hub's `<ROOT>/storage`,
or is sync, or runs before any agent exists for the task, it is hub-owned.

## Workspace — routed to the task's runner

These touch the task's checkout. They must land on the same machine as the agent
that will use it, or the agent gets a cwd that does not exist.

| call | seam | notes |
|---|---|---|
| pty spawn | `PtyBackend.spawn` | `runnerId` from `resolveRunnerId(taskId)`, `pty-store.ts:313` |
| chat agent spawn | `ChatBackend.spawn` | `runnerId` from `data.resolveRunnerId`, `chat-handlers.ts:332` |
| `createWorktree` | `WorktreeExecAdapters` | in `createWorktreeForTask` |
| `removeWorktree` | `WorktreeExecAdapters` | in `cleanupTaskFull` — see the caveat below |
| `runWorktreeSetupScript` | `WorktreeExecAdapters` | in `createWorktreeForTask` |
| `copyIgnoredFiles` | `WorktreeExecAdapters` | in `createWorktreeForTask` |
| `getCurrentBranch` | `WorktreeExecAdapters` | in `createWorktreeForTask` |
| `isGitRepo` | `WorktreeExecAdapters` | in `createWorktreeForTask` — see the caveat below |
| `pathExists` | `WorktreeExecAdapters` | probes a WORKTREE path only |

## Hub-owned — never routed

| call | why |
|---|---|
| `hubPathExists` | probes `<ROOT>/storage/artifacts/<taskId>` — hub storage, absent on a runner |
| `removeArtifactDir` | removes the same; routing it made archiving a task impossible |
| `getWorktreeColor` | SYNC, and UI state. A sync function cannot be a network call |
| `ensureProjectWorktreeColors` | same class; runs on every task-list read |
| background processes (`ProcessBackend`) | project-level dev servers, not agents. `doSpawn` is sync and also driven by restart timers, so it cannot resolve a runner. Spec passes `runnerId: null` deliberately |

## Callers that MUST tolerate zero runners

Not obvious from the seam alone, and each was a real break:

- **`purgeStaleAndOrphanedTasks` → `cleanupTaskFull`** runs at BOOT
  (`composition.ts:423`, inside `bootBestEffort`). If any of its seam calls demanded
  a runner, the hub could not start.
- **`attachWorktreeColors`** runs on EVERY task list/get
  (`parseAndColorTasks`). Its two calls are hub-owned precisely so a read path never
  depends on a runner.
- **`maybeAutoCreateWorktree`** runs during task CREATE, before any agent exists to
  need a workspace. It is best-effort by contract (hence "maybe"), so a missing
  runner SKIPS the worktree with a diagnostic — it must never fail the create. Its
  `isGitRepo` probe is the specific call that, once routed, broke task creation
  outright.
- **`cleanupTaskFull` → `removeWorktree`** is routed but already wrapped in
  try/catch with a `task.cleanup_worktree_failed` diagnostic, so archiving survives
  a missing runner. Keep that wrapper if enforcement lands.

## Acceptance test for enforcement

With **zero runners connected**, all of this must still work:

- the app boots (startup purge included)
- tasks can be created (without a worktree), listed, archived, deleted
- the UI renders, including the task list and its worktree colors

Only these may fail, and they must fail with an actionable error naming the runner
requirement — not silently on the hub:

- opening a terminal, spawning a chat agent
- creating or removing a worktree
- git probes against a workspace path

## Still undecided

- **Background processes**: routing them means an async `doSpawn`, and they ignore a
  per-task `runner_id` pin today (they follow the connected default). Fine while they
  are dev servers; revisit if they ever host agents.
- **A task whose project has no repo** never creates a worktree, so its cwd is a
  plain path. Nothing guarantees that path exists on a runner — who creates it?
- **Standalone `slay hub`** provisions no runner at all, so enforcement makes a bare
  VPS hub agent-less until that is answered.

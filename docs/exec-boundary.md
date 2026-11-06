# The exec boundary: what runs on a computer, what stays on the hub

Every call that crosses an exec seam is either **workspace** work (routed to the
task's computer, because the files it touches live there) or **hub-owned** work
(never routed, because the thing it touches belongs to the hub process).

This file exists because that distinction was previously discovered by watching e2e
fail — four separate times, each revealing another hub-owned call that had been
wrongly routed. Enforcing "computers run the agents" without this table written down
is how task creation, task archiving, and the app's own boot got broken.

**The rule:** if a call reads or writes something under the hub's `<ROOT>/storage`,
or is sync, or runs before any agent exists for the task, it is hub-owned.

## Workspace — routed to the task's computer

These touch the task's checkout. They must land on the same machine as the agent
that will use it, or the agent gets a cwd that does not exist.

| call | seam | notes |
|---|---|---|
| pty spawn | `PtyBackend.spawn` | `computerId` from `resolveComputerId(taskId)`; the default backend (none installed, or no computer) refuses — the in-process node-pty backend (`pty-backend-local`) is not in the hub |
| background processes | `ProcessBackend.spawn` | the manager awaits the task's (else project's) computer before every spawn, start, restart and auto-restart (`setProcessComputerResolver`); a project process sends no cwd (the computer resolves its folder); stats, title and group sweep run on the computer (`proc.stats`, `reapGroupOnExit`). None → "connect a computer" status, never the hub; an auto-restart one starts when a computer connects. A run a previous hub left on a computer shows as `orphaned` on connect (`proc.list`), and Stop ends it there |
| pty output pipeline | `PtySpawnSpec.detection` | terminal query answers, detection (`pty-signal`), replay filter and the ONLY scrollback run on the computer; the hub mirrors signals and reads replay via `pty.getReplay` (offline → `PtyOutputUnavailableError`) |
| git panel (65 ops) | `git.op` | one table (`@slayzone/worktrees` git op contract + `git-ops` impls) shared by hub and computer; the hub resolves the computer from an explicit `target`, else the op's path (a task worktree, a project placement), else the caller's default; the computer validates and jails every path. The git watcher (`git.watchStart/Stop`), PR ops (`gh`) and the AI merge run there too |
| turn snapshots | `git.turnOp` | by the checkout's path, else the task |
| chat agents | computer chat runtime (`chat.request`) | the whole chat runtime — spawn, history, `@file` autocomplete, autocomplete usage — runs on the computer; the hub relays (`@slayzone/chat-runtime/hub`). A chat → terminal hand-off stops the chat there (conversation registry) |
| AI config | `agentConfig.fs` | project files on the project's computer; computer-level files (`~/.claude`, …) on an explicit computer, else the caller's |
| automation shell actions | `exec.run` | the task's, else the project's computer |
| terminal settings probes | `exec.run` | a terminal mode's binary (`command -v`) and a docker / ssh execution context, on the caller's computer |
| usage | `usage.collect` | each connected computer parses its own logs; parse state keyed by `(computer_id, file_path)` |
| test-panel scan | `testPanel.scan` | on the project's computer |
| workspace files | file-editor `fs.*` | on the task's / project's computer |
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
| `hubPathExists` | probes `<ROOT>/storage/artifacts/<taskId>` — hub storage, absent on a computer |
| `removeArtifactDir` | removes the same; routing it made archiving a task impossible |
| `getWorktreeColor` | SYNC, and UI state. A sync function cannot be a network call |
| `ensureProjectWorktreeColors` | same class; runs on every task-list read |

## Callers that MUST tolerate zero computers

Not obvious from the seam alone, and each was a real break:

- **`purgeStaleAndOrphanedTasks` → `cleanupTaskFull`** runs at BOOT
  (`composition.ts:423`, inside `bootBestEffort`). If any of its seam calls demanded
  a computer, the hub could not start.
- **`attachWorktreeColors`** runs on EVERY task list/get
  (`parseAndColorTasks`). Its two calls are hub-owned precisely so a read path never
  depends on a computer.
- **`maybeAutoCreateWorktree`** runs during task CREATE, before any agent exists to
  need a workspace. It is best-effort by contract (hence "maybe"), so a missing
  computer SKIPS the worktree with a diagnostic — it must never fail the create. Its
  `isGitRepo` probe is the specific call that, once routed, broke task creation
  outright.
- **`cleanupTaskFull` → `removeWorktree`** is routed but already wrapped in
  try/catch with a `task.cleanup_worktree_failed` diagnostic, so archiving survives
  a missing computer. Keep that wrapper if enforcement lands.

## Acceptance test for enforcement

With **zero computers connected**, all of this must still work:

- the app boots (startup purge included)
- tasks can be created (without a worktree), listed, archived, deleted
- the UI renders, including the task list and its worktree colors

Everything in the workspace table above may fail, and must fail with the actionable
"connect a computer" error (`NO_COMPUTER_CONNECTED`) — never run on the hub. Views
that need a computer show that state and refetch when one connects; a local computer
can always be enrolled, even to a remote hub.

## No hub-local fallbacks

No hub — desktop or remote, processes on or off — runs project work itself: every
workspace call above routes to a computer or refuses with `NO_COMPUTER_CONNECTED`
("Connect a computer") and one `hub.local_exec` audit line. Hub storage
(`hubPathExists`, `removeArtifactDir`) and worktree colors stay hub-owned; colors stay
empty until a computer answers their probe.

What `SLAYZONE_HUB_ENABLE_PROCESSES=0` (T-06) still turns off is what remains on the
hub's own machine: the OS opener (`shell-native.ts`, a client concern), the v122
backfill migration, and the uploads that copy a path the client names off the hub's
disk — `artifacts.upload`, `artifacts.uploadDir`, `projects.uploadIcon`, and
`artifacts.pasteFiles` from anywhere but the hub's own artifact store (T-107); bytes
sent by the client (`artifacts.uploadBlob`, `POST /api/tasks/:id/artifacts`) never touch
a client path.

`pnpm lint:server-boundary` (`scripts/check-hub-exec-imports.mjs`) fails on a
process-spawning import in hub-bundled code that is not allowlisted. Five remain, each
with its reason: `shell-native.ts`, the v122 migration, `cli-install.ts` (fs probe
only), and `process-tree.ts` / `login-shell-path.ts` (bundled through the
`@slayzone/platform` barrel, never called by the hub). The hub imports its domains
through hub-safe entries — `@slayzone/terminal/hub`, `@slayzone/worktrees/hub`,
`@slayzone/file-editor/hub`, `@slayzone/chat-runtime/hub` — never their `./server`
barrels, which keep the local implementations computers use.

## Still undecided

- **A task whose project has no repo** never creates a worktree, so its cwd is a
  plain path. Nothing guarantees that path exists on a computer — who creates it?
- **Standalone `slay hub`** provisions no computer at all, so enforcement makes a bare
  VPS hub agent-less until that is answered.

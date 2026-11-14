# Task Domain

Task CRUD operations and detail view.

## Contracts (shared/)

```typescript
interface Task {
  id: string
  project_id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: number
  agent_id: AgentId
  // ... terminal config, timestamps
}

type TaskStatus = 'inbox' | 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
```

Also exports validation schemas (`createTaskSchema`, `updateTaskSchema`) and form types.

`src/shared/main-terminal.ts` - how a task's MAIN agent starts (spawn props, cwd:
worktree > base dir > bound child repo > project root). DOM-free; the task page and
the hub's `task.startMainAgent` both use it, so they cannot start a session two ways.
Exported DOM-free as `@slayzone/task/main-terminal` (its contract imports go through
DOM-free subpaths): the mobile chat resolves a chat tab's folder with it.

## Server (server/)

- `server/ops/` - Electron-free task ops (CRUD, archive, reorder, blockers, conversation ledger) behind the transport tRPC routers. Order and blocker writes signal `notify.onTasksChanged` with the rows they changed.
- `server/main-agent.ts` - `task.startMainAgent({ taskId, cols?, rows? })`: the hub resolves and starts the task's main agent (pty or chat) only when none is live; concurrent calls share one start. Repo discovery is injected (`setMainAgentDeps`, wired by api from worktrees).

## Electron (electron/)

- `filesSaveTempImage` / `filesPathExists` - Temp image saving for pasted images, path check

## Client (client/)

- `TaskDetailPage` - Full task view with terminal
- `CreateTaskDialog` / `EditTaskDialog` / `DeleteTaskDialog`
- `TaskMetadataSidebar` - Priority, status, project, tags, blockers

### Keyboard Shortcuts (TaskDetailPage)

| Shortcut | Action |
|----------|--------|
| Cmd+I | Inject task title into active terminal |
| Cmd+Shift+I | Inject task description into active terminal |

## Dependencies

- `@slayzone/types` - ElectronAPI contract
- `@slayzone/ui` - UI components
- `@slayzone/editor` - Rich text description
- `@slayzone/terminal` - AgentId type, Terminal component
- `@slayzone/projects` - Project selector
- `@slayzone/tags` - Tag selector
- `@slayzone/worktrees` - GitPanel
- `@slayzone/task-browser` - URL webview

## Decision Log

**2026-10-29: Hub-side main-agent start (`task.startMainAgent`)**
Client-driven spawning (`pty.create` after `pty.attach`) let two clients race and kill each other's agent, and made every client re-implement spawn props + cwd. The hub now resolves both from stored data with the same shared module the desktop uses. Lives in `task` (not `task-terminals`): it needs task + project rows; `task-terminals` sits below `task`.


### Move and copy

`taskMoves` is the durable transfer journal. Moves keep IDs, lock originals, carry sessions when selected, and release the source with redirects. Copies freeze rows and artifact bytes, assign new IDs, preserve writable originals, start fresh sessions, and drop external blockers. `shared/task-copy-bundle.ts` remaps content and structured references; Duplicate remains a separate fresh-follow-up preset. Integration-linked content is refused.

Same-hub copies use the same snapshot/import/commit operations through `copyOnHub`. Cross-hub UI and REST requests use the app's step engine; CLI handoffs and controls persist in the source journal and are picked up by `TaskMovesPanel`. The CLI talks only to its source hub. Copy imports have separate journal IDs, allowing both ends to be the same hub. Source snapshots survive pause/recovery and are removed on completion/cancellation.

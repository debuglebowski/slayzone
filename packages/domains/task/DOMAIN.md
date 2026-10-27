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
  terminal_mode: TerminalMode
  // ... terminal config, timestamps
}

type TaskStatus = 'inbox' | 'backlog' | 'todo' | 'in_progress' | 'review' | 'done'
```

Also exports validation schemas (`createTaskSchema`, `updateTaskSchema`) and form types.

## Server (server/)

- `server/ops/` - Electron-free task ops (CRUD, archive, reorder, blockers, conversation ledger) behind the transport tRPC routers

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
- `@slayzone/terminal` - TerminalMode type, Terminal component
- `@slayzone/projects` - Project selector
- `@slayzone/tags` - Tag selector
- `@slayzone/worktrees` - GitPanel
- `@slayzone/task-browser` - URL webview

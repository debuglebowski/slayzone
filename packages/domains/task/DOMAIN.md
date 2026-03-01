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

## Main Process (main/)

- `registerTaskHandlers(ipcMain, db)` - Task CRUD, archive, reorder
- `registerFilesHandlers(ipcMain)` - Temp image saving for AI

## Client (client/)

- `TaskDetailPage` - Full task view with terminal

### Keyboard Shortcuts (TaskDetailPage)

| Shortcut | Action |
|----------|--------|
| Cmd+I | Inject task title into active terminal |
| Cmd+Shift+I | Inject task description into active terminal |
- `CreateTaskDialog` / `EditTaskDialog` / `DeleteTaskDialog`
- `QuickRunDialog` - Quick task execution
- `TaskMetadataSidebar` - Priority, status, project, tags, blockers

## Dependencies

- `@slayzone/types` - ElectronAPI contract
- `@slayzone/ui` - UI components
- `@slayzone/editor` - Rich text description
- `@slayzone/terminal` - TerminalMode type, Terminal component
- `@slayzone/projects` - Project selector
- `@slayzone/tags` - Tag selector
- `@slayzone/worktrees` - GitPanel
- `@slayzone/task-browser` - URL webview

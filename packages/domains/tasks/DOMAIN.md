# Tasks Domain (Kanban)

Kanban board view for task management. Client-only domain (shared/ and main/ are placeholders).

## Client (client/)

- `KanbanBoard` - Drag-and-drop board with columns
- `KanbanColumn` / `KanbanCard` - Column and card components
- `FilterBar` - Status, priority, tag filtering
- `TaskContextMenu` - Right-click actions
- `useTasksData` - Core data hook (tasks, projects, tags state)
- `useFilterState` - Per-project filter persistence

## Board logic (`./board`)

`@slayzone/tasks/board` (`client/board.ts`): columns, sorting, filters (`kanban.ts`, `FilterState.ts`) and board-row patching (`board-patch.ts`) without UI — DOM-, React- and desktop-UI-free at runtime, for the mobile app. `kanban.ts` imports the column helpers from `@slayzone/workflow` (their origin) because the `@slayzone/projects-contracts` barrel also loads `@slayzone/ui/secure-context`.

## Dependencies

- `@slayzone/task-contracts` - Task types
- `@slayzone/workflow` - Status columns (`resolveColumns`, `isTerminalStatus`)
- `@slayzone/terminal` - usePty for card status indicator
- `@dnd-kit/*` - Drag and drop

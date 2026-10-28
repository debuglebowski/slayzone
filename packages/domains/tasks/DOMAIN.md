# Tasks Domain (Kanban)

Kanban board view for task management. Client-only domain (shared/ and main/ are placeholders).

## Client (client/)

- `KanbanBoard` - Drag-and-drop board with columns
- `KanbanColumn` / `KanbanCard` - Column and card components
- `FilterBar` - Status, priority, tag filtering
- `TaskContextMenu` - Right-click actions
- `useTasksData` - Core data hook (tasks, projects, tags state)
- `useFilterState` - Per-project filter persistence

## Dependencies

- `@slayzone/task-contracts` - Task types
- `@slayzone/terminal` - usePty for card status indicator
- `@dnd-kit/*` - Drag and drop

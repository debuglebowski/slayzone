import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project, ProjectGroup, ColumnConfig, TopLevelEntryRef } from '@slayzone/projects/shared'

export interface SidebarViewContext {
  projects: Project[]
  /** Project groups — Discord-style folders (rail) / collapsible labels (tree). */
  projectGroups: ProjectGroup[]
  tasks: Task[]
  selectedProjectId: string
  /** `opts.home` forces the project's home/kanban tab (Home icon); omitted = restore last tab. */
  onSelectProject: (id: string, opts?: { home?: boolean }) => void
  onProjectSettings: (project: Project) => void
  onTaskClick?: (taskId: string) => void
  /** Close a task tab by id (handles temporary task DB cleanup). */
  onCloseTab?: (taskId: string) => void
  /** Open a task as a background tab without changing focus. */
  onOpenTaskInBackground?: (taskId: string) => void
  /** Create a temporary "scratch" task in the given project. */
  onCreateTemporaryTask?: (projectId: string) => void
  /** Task ids with an active (non-idle) agent session — always pass the tree filter. App injects via `useActiveSessionTaskIds`; fork passes empty. */
  sessionTaskIds?: Set<string>
  onReorderProjects: (projectIds: string[]) => void
  // ── Project-group handlers (Discord folders / tree labels) ────────────────
  /** Create an empty group (appended to the top level). */
  onCreateProjectGroup?: (name?: string) => void
  /** Create a folder from dropped projects — Discord's drag-onto gesture. */
  onCreateFolderWithProjects?: (projectIds: string[]) => void
  onRenameProjectGroup?: (id: string, name: string) => void
  onDeleteProjectGroup?: (id: string) => void
  /** Persist a group's expand/collapse (shared across rail + tree). */
  onSetGroupCollapsed?: (id: string, collapsed: boolean) => void
  /** Reorder the full top-level list (ungrouped projects + groups interleaved). */
  onReorderTopLevel?: (entries: TopLevelEntryRef[]) => void
  /** Move a project into a group (or out to top level) at a target index. */
  onMoveProjectToGroup?: (projectId: string, groupId: string | null, targetIndex: number) => void
  /** Reorder projects within a single group. */
  onReorderProjectsInGroup?: (groupId: string, projectIds: string[]) => void
  idleByProject?: Map<string, number>
  /** Render a task-row context-menu wrapper. Caller wires update/archive/delete + tag handlers. */
  taskContextMenuRender?: (task: Task, child: ReactNode) => ReactNode
  /** Render a bulk context-menu wrapper when multiple tasks are selected. */
  taskBulkContextMenuRender?: (taskIds: string[], child: ReactNode) => ReactNode
  /** Per-task progress 0..100. */
  taskProgress?: Map<string, number>
  /** Task ids in a "done" status. */
  doneTaskIds?: Set<string>
  /** Per-project kanban column config (used for task-status icon lookup). */
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
  /** Reorder a flat list of task ids (writes "order" col). */
  onTaskReorder?: (taskIds: string[]) => void
  /**
   * Move a task to a different group. `newColumnId` is interpreted by `groupBy`:
   * - 'status': status id (e.g. 'in_progress')
   * - 'priority': 'p1'..'p5'
   */
  onTaskMove?: (
    taskId: string,
    newColumnId: string,
    targetIndex: number,
    groupBy: 'none' | 'status' | 'priority'
  ) => void
  /** Reparent a task — sets new parent_id (or null) and rewrites sibling order. */
  onTaskReparent?: (taskId: string, newParentId: string | null, newSiblingTaskIds: string[]) => void
  /** Bulk variant of reparent — used when dragging a multi-selection. */
  onTaskBulkReparent?: (
    taskIds: string[],
    newParentId: string | null,
    newSiblingTaskIds: string[]
  ) => void
  /** Patch a task with a partial update (used for orderBy field inheritance on drop). */
  onTaskFieldUpdate?: (taskId: string, updates: Partial<Task>) => void
  /** Bulk variant of field update — used for groupBy inheritance on multi-drag. */
  onTaskBulkFieldUpdate?: (taskIds: string[], updates: Partial<Task>) => void
  /** Pin / unpin tasks in the sidebar tree (writes `tasks.pinned` + `pin_order`). */
  onSetTasksPinned?: (taskIds: string[], pinned: boolean) => void
  /** Collapse / expand a task's sub-tasks in the sidebar tree (writes `tasks.tree_collapsed`). */
  onSetCollapsed?: (taskId: string, collapsed: boolean) => void
  /** Reorder the pinned group — writes `tasks.pin_order` for the ordered ids. */
  onPinnedReorder?: (taskIds: string[]) => void
}

export interface SidebarView {
  id: string
  label: string
  icon: LucideIcon
  /** Tailwind width class used when the view is not resizable (or as fallback). */
  width: string
  footerLayout: 'vertical' | 'horizontal'
  /** When true, the sidebar exposes a drag handle and a persisted custom width applies. */
  resizable?: boolean
  /** Pixel width used as the starting/reset value when the view first becomes resizable. */
  defaultWidth?: number
  minWidth?: number
  maxWidth?: number
  render: (ctx: SidebarViewContext) => ReactNode
}

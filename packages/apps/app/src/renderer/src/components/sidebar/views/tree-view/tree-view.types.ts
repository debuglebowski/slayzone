import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Task } from '@slayzone/task/shared'
import type { SidebarViewContext } from '../types'

export type ProjDropMode = 'before' | 'after' | 'merge'

export interface TaskRowDragData {
  kind: 'task'
  projectId: string
  /** Either a status id or 'p1'..'p5' depending on treeGroupBy. */
  groupValue: string
  parentId: string | null
}

export interface GroupDropData {
  kind: 'group'
  projectId: string
  groupValue: string
}

export interface ProjectDragData {
  kind: 'project'
  projectId: string
  /** Group the project currently belongs to, or null = top-level. */
  groupId: string | null
}

export interface TaskBranchCtx {
  childrenByParent: Map<string, Task[]>
  activeTaskId: string | null
  openTabTaskIds: Set<string>
  doneTaskIds?: Set<string>
  taskProgress?: Map<string, number>
  columnsByProjectId?: Map<string, import('@slayzone/projects/shared').ColumnConfig[] | null>
  pinnedSet: Set<string>
  selectedTaskIds: Set<string>
  selectedTaskIdArr: string[]
  /** Id of the currently-dragged row (null when no drag). Used so all rows
   * in a multi-drag can hide together — the dragged row plus every other
   * selected row vanishes while the floating preview shows the count. */
  activeDragTaskId: string | null
  treeShowStatus: boolean
  treeShowPriority: boolean
  treeShowWorktree: boolean
  treeCrossOutDone: boolean
  treeGroupBy: 'none' | 'status' | 'priority'
  treeGroupPinned: boolean
  onTaskClick?: (taskId: string) => void
  onRowSelectClick: (event: ReactMouseEvent<HTMLButtonElement>, taskId: string) => void
  onCloseTab?: (taskId: string) => void
  onOpenTaskInBackground?: (taskId: string) => void
  taskContextMenuRender?: SidebarViewContext['taskContextMenuRender']
  taskBulkContextMenuRender?: SidebarViewContext['taskBulkContextMenuRender']
  dragEnabled: boolean
  editingTaskId: string | null
  onStartEdit: (taskId: string) => void
  onCommitEdit: (taskId: string, value: string) => void
  onCancelEdit: () => void
  /** Tasks that have at least one visible child in the tree — render
   * collapse chevron. Computed from the un-collapse-filtered child map so
   * collapsing a parent doesn't hide its own chevron. */
  tasksWithChildren: Set<string>
  collapsedTaskIds: Set<string>
  onToggleCollapse: (taskId: string) => void
}

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Task } from '@slayzone/task/shared'
import type { Project, ColumnConfig } from '@slayzone/projects/shared'
import type { TerminalState } from '@slayzone/terminal/shared'

export interface SidebarViewContext {
  projects: Project[]
  tasks: Task[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
  onProjectSettings: (project: Project) => void
  onTaskClick?: (taskId: string) => void
  /** Close a task tab by id (handles temporary task DB cleanup). */
  onCloseTab?: (taskId: string) => void
  /** Open a task as a background tab without changing focus. */
  onOpenTaskInBackground?: (taskId: string) => void
  /** Create a temporary "scratch" task in the given project. */
  onCreateTemporaryTask?: (projectId: string) => void
  onReorderProjects: (projectIds: string[]) => void
  idleByProject?: Map<string, number>
  /** Render a task-row context-menu wrapper. Caller wires update/archive/delete + tag handlers. */
  taskContextMenuRender?: (task: Task, child: ReactNode) => ReactNode
  /** Per-task terminal state (mostly populated for open-tab tasks). */
  terminalStates?: Map<string, TerminalState>
  /** Per-task progress 0..100. */
  taskProgress?: Map<string, number>
  /** Task ids in a "done" status. */
  doneTaskIds?: Set<string>
  /** Per-project kanban column config (used for task-status icon lookup). */
  columnsByProjectId?: Map<string, ColumnConfig[] | null>
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

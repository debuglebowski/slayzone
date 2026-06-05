import type { Tab } from '@slayzone/settings'
import type { Task } from '@slayzone/task/shared'
import type { Project } from '@slayzone/projects/shared'

export type FilterKind = 'all' | 'actions' | 'files' | 'tasks' | 'projects'

export type TaskTab = Extract<Tab, { type: 'task' }>

export type ActionId =
  | 'new-task'
  | 'new-temp-task'
  | 'reopen-closed-tab'
  | 'add-project'
  | 'go-home'
  | 'toggle-global-agent-panel'
  | 'open-changelog'
  | 'open-settings'

export type SearchItem =
  | { kind: 'action'; id: ActionId; label: string; sublabel: string; shortcutId?: string }
  | { kind: 'file'; id: string; label: string; sublabel: string; filePath: string }
  | { kind: 'task'; id: string; label: string; sublabel: string; status: string; priority: number }
  | { kind: 'project'; id: string; label: string; sublabel: string }

export interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tasks: Task[]
  projects: Project[]
  closedTabs: TaskTab[]
  openTaskTabs: TaskTab[]
  activeTaskId: string | null
  onSelectTask: (taskId: string) => void
  onSelectProject: (projectId: string) => void
  onNewTask: () => void
  onNewTemporaryTask: () => void
  onReopenClosedTab: () => void
  onAddProject: () => void
  onGoHome: () => void
  onToggleGlobalAgentPanel: () => void
  onOpenChangelog: () => void
  onOpenSettings: () => void
}

import { createContext, useContext } from 'react'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type { FilterState } from '@slayzone/tasks'
import type { Project } from '@slayzone/projects/shared'

interface GitPanelContextValue {
  tasks: Task[]
  filter?: FilterState
  projects: Project[]
  activeTask?: Task | null
  projectPath: string | null
  onTaskClick?: (task: Task) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
}

export const GitPanelContext = createContext<GitPanelContextValue | null>(null)

export function useGitPanelContext() {
  const context = useContext(GitPanelContext)
  if (!context) throw new Error('useGitPanelContext must be used within UnifiedGitPanel')
  return context
}

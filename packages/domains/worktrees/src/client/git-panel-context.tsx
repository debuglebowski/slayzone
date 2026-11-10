import { createContext, useContext } from 'react'
import type { Task, UpdateTaskInput } from '@slayzone/task-contracts'
import type { FilterState } from '@slayzone/tasks'
import type { Project } from '@slayzone/projects-contracts'

interface GitPanelContextValue {
  tasks: Task[]
  filter?: FilterState
  projects: Project[]
  activeTask?: Task | null
  projectPath: string | null
  onTaskClick?: (task: Task) => void
  onUpdateTask?: (data: UpdateTaskInput) => Promise<Task>
  onTaskUpdated?: (task: Task) => void
  /**
   * A task's worktree path as its computer answered (§9 Phase 7d: the hub keeps no
   * copy). `undefined` = not known yet (loading, computer away) — never "none":
   * a task without a worktree is `!task.has_worktree`.
   */
  worktreeOf: (task: Task) => string | undefined
}

export const GitPanelContext = createContext<GitPanelContextValue | null>(null)

export function useGitPanelContext() {
  const context = useContext(GitPanelContext)
  if (!context) throw new Error('useGitPanelContext must be used within UnifiedGitPanel')
  return context
}

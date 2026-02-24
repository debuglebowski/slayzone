export type ProjectTaskStorage = 'database' | 'repository'

export interface Project {
  id: string
  name: string
  color: string
  path: string | null
  task_storage: ProjectTaskStorage
  auto_create_worktree_on_task_create: number | null
  created_at: string
  updated_at: string
}

export interface CreateProjectInput {
  name: string
  color: string
  path?: string
  taskStorage?: ProjectTaskStorage
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  path?: string | null
  taskStorage?: ProjectTaskStorage
  autoCreateWorktreeOnTaskCreate?: boolean | null
}

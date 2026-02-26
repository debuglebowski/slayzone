export interface Project {
  id: string
  name: string
  color: string
  path: string | null
  auto_create_worktree_on_task_create: number | null
  worktree_source_branch: string | null
  created_at: string
  updated_at: string
}

export interface CreateProjectInput {
  name: string
  color: string
  path?: string
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  path?: string | null
  autoCreateWorktreeOnTaskCreate?: boolean | null
  worktreeSourceBranch?: string | null
}

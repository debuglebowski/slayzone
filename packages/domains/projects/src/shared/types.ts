import type { ColumnConfig } from '@slayzone/workflow'

export type ExecutionContext =
  | { type: 'host' }
  | { type: 'docker'; container: string; workdir?: string; shell?: string }
  | { type: 'ssh'; target: string; workdir?: string; shell?: string }

export {
  WORKFLOW_CATEGORIES,
  DEFAULT_COLUMNS,
  type WorkflowCategory,
  type ColumnConfig
} from '@slayzone/workflow'

export type WorktreeCopyBehavior = 'ask' | 'none' | 'all' | 'custom'

export type WorktreeSubmoduleInit = 'auto' | 'skip'

export interface TaskAutomationConfig {
  on_terminal_active: string | null
  on_terminal_idle: string | null
}

export interface ProjectLockConfig {
  /** ISO timestamp — project locked until this time. null = no duration lock */
  locked_until: string | null
  /** Rate limit config. null = no rate limit */
  rate_limit: {
    max_tasks: number
    per_minutes: number
  } | null
  /** Schedule lock — locked daily between these times. "HH:MM" 24h format. null = disabled */
  schedule: {
    from: string
    to: string
  } | null
  /** When true, hide "Unlock early" button on lockscreen. Default false. */
  disable_unlock_early?: boolean
}

export interface Project {
  id: string
  name: string
  color: string
  path: string | null
  auto_create_worktree_on_task_create: number | null
  worktree_source_branch: string | null
  worktree_copy_behavior: WorktreeCopyBehavior | null
  /** Comma-separated relative paths (paths must not contain commas) */
  worktree_copy_paths: string | null
  /** null = inherit global 'worktree_submodule_init' setting */
  worktree_submodule_init: WorktreeSubmoduleInit | null
  columns_config: ColumnConfig[] | null
  execution_context: ExecutionContext | null
  /** Folder name of the default child repo (for multi-repo projects) */
  selected_repo: string | null
  task_automation_config: TaskAutomationConfig | null
  lock_config: ProjectLockConfig | null
  /** Custom 1–5 char override for the avatar. Null = derive from name. */
  icon_letters: string | null
  /** Absolute path to icon image on disk. Overrides letters when set. */
  icon_image_path: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface DetectedRepo {
  name: string
  path: string
}

export interface CreateProjectInput {
  name: string
  color: string
  path?: string
  columnsConfig?: ColumnConfig[]
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  path?: string | null
  autoCreateWorktreeOnTaskCreate?: boolean | null
  worktreeSourceBranch?: string | null
  worktreeCopyBehavior?: WorktreeCopyBehavior | null
  worktreeCopyPaths?: string | null
  worktreeSubmoduleInit?: WorktreeSubmoduleInit | null
  columnsConfig?: ColumnConfig[] | null
  executionContext?: ExecutionContext | null
  selectedRepo?: string | null
  taskAutomationConfig?: TaskAutomationConfig | null
  iconLetters?: string | null
  iconImagePath?: string | null
  lockConfig?: ProjectLockConfig | null
}

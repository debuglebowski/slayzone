import type { ColumnConfig } from '@slayzone/workflow'
import type { ProjectPlacement } from '@slayzone/computers/shared'

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
  /** Schedule lock — locked between these times on selected weekdays. "HH:MM" 24h format. null = disabled */
  schedule: {
    from: string
    to: string
    /** Length-7 array indexed by JS getDay() (Sun=0..Sat=6). Missing = all 7 days active (back-compat). */
    weekdays?: boolean[]
  } | null
  /** When true, hide "Unlock early" button on lockscreen. Default false. */
  disable_unlock_early?: boolean
}

/**
 * A `projects` row as stored. What the hub returns to clients is {@link Project},
 * which adds where the project's folder is on each computer — a row alone does
 * not know that, so a bare row must never be handed out as a Project.
 */
export interface ProjectRecord {
  id: string
  name: string
  color: string
  /**
   * LEGACY: the hub's single folder column from before folders moved to
   * computers. Read only to carry existing values over to the local computer, and
   * where no computer exists at all. Dropped in the next release.
   */
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
  /**
   * Position. When `group_id` is null → position in the top-level sidebar list
   * (shared integer space with `ProjectGroup.sort_order`). When `group_id` is
   * set → position within that group.
   */
  sort_order: number
  /** Group this project belongs to, or null = ungrouped (top-level). */
  group_id: string | null
  /** Exempts the project from the sidebar tree's "hide inactive" collapse. */
  starred: boolean
  /**
   * The hub-auth user who owns the project. Null on a hub without login (the
   * desktop app's), where requests carry no user, and on rows from before
   * ownership existed until the hub assigns them (`ownership-backfill.ts`).
   */
  owner_user_id: string | null
  /**
   * The computer this project's work runs on unless a task names another. Null =
   * none chosen; the hub then uses its connected default (see
   * {@link Project.resolved_computer_id}).
   */
  default_computer_id: string | null
  created_at: string
  updated_at: string
}

/**
 * A project as the hub returns it: the row plus where its folder is on each
 * computer. Deliberately WITHOUT the row's legacy `path`: a folder belongs to a
 * computer, so every reader names one (`projectRootOn` / `defaultProjectRoot` /
 * `taskProjectRoot`) instead of trusting the hub's single column.
 */
export interface Project extends Omit<ProjectRecord, 'path'> {
  /** Every computer's folder for this project, as the hub knows it. */
  placements: ProjectPlacement[]
  /**
   * The computer the hub actually uses for this project's work right now:
   * `default_computer_id`, else the connected default. Null = no computer at all.
   * Clients read this instead of re-deriving it, so they never disagree with the
   * computer an agent really starts on.
   */
  resolved_computer_id: string | null
}

/**
 * A group of projects. Renders as a Discord-style folder in the rail view and
 * a collapsible labeled section in the tree view — one shared entity for both.
 */
export interface ProjectGroup {
  id: string
  /** Label (tree-view header + rail folder tooltip/expanded title). May be ''. */
  name: string
  /** Top-level position, shares one integer space with ungrouped projects. */
  sort_order: number
  /** 0/1 — persisted expand/collapse, shared across rail + tree views. */
  collapsed: number
  created_at: string
  updated_at: string
}

export interface CreateProjectGroupInput {
  name?: string
}

export interface UpdateProjectGroupInput {
  id: string
  name?: string
  collapsed?: boolean
}

/**
 * A reference to one top-level sidebar slot — either an ungrouped project or a
 * group. Used as the `reorderTopLevel` payload (the merged ordered list).
 */
export type TopLevelEntryRef = { kind: 'project' | 'group'; id: string }

export interface DetectedRepo {
  name: string
  path: string
  kind?: 'project-root' | 'child-repo' | 'submodule'
}

export interface CreateProjectInput {
  name: string
  color: string
  /** The project's folder on its computer. Optional: a project needs none. */
  path?: string
  /** The project's default computer. Omitted = the caller's default computer. */
  computerId?: string | null
  columnsConfig?: ColumnConfig[]
}

export interface UpdateProjectInput {
  id: string
  name?: string
  color?: string
  /** The project's folder on the computer the hub uses for it; null forgets it. */
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
  starred?: boolean
}

import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ProviderConfig,
  Task,
  TaskPathState,
  TasksChange,
  UpdateTaskInput
} from '@slayzone/task-contracts'
import {
  prioritySchema,
  validateReparent,
  reparentErrorMessage,
  type ReparentTaskRow
} from '@slayzone/task-contracts'
import { resetConversation } from './task-conversations.js'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { buildTaskUpdatedEvents } from '../history.js'
import type { ColumnConfig } from '@slayzone/projects-contracts'
import {
  getColumnById,
  getDefaultStatus,
  getStatusByCategory,
  isKnownStatus,
  isTerminalStatus,
  parseColumnsConfig,
  WORKFLOW_CATEGORIES
} from '@slayzone/projects-contracts'
import {
  CHAT_SETTING_KEYS,
  chatOwnsSpawnFlags,
  COMPUTER_OWNED_CHAT_KEYS,
  DEFAULT_AGENTS
} from '@slayzone/terminal-contracts'
import path from 'path'
import { existsSync, rmSync } from 'fs'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import type { WorktreeCopyBehavior } from '@slayzone/projects-contracts'
import { artifactsDirOf, artifactTaskDir } from '../artifact-paths.js'
import { taskEvents } from '../events.js'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../task-txns.js'

/**
 * The board's task ordering, defined once and interpolated by every list query
 * (get-all, get-by-project, get-subtasks, load-board-data) so they cannot answer
 * the same question differently.
 *
 * `rowid DESC` is the part that matters. Without it the ordering is NOT TOTAL:
 * `"order"` is `NOT NULL DEFAULT 0`, and nothing on the create path sets it, so
 * every task made through the app ties on the primary key. `created_at` defaults
 * to `datetime('now')`, which is second-granular — so two tasks created in the
 * same second tie there too, and SQLite is then free to return them in any
 * order. Two consequences, both observed:
 *
 *   - In the app, same-second tasks could swap position between refetches.
 *   - In the suite, `core/52` asserted a specific card was first and failed
 *     ~2% of runs. It looked host-correlated for a subtle reason: a slower host
 *     widens the gap between two seeded INSERTs, which makes them more likely to
 *     land in DIFFERENT seconds — and then `created_at DESC` deterministically
 *     puts the SECOND one first. A load-sensitive symptom with no load bug.
 *
 * `DESC` keeps the tie-break consistent with `created_at DESC`: newest first.
 */
export const TASK_ORDER_BY = `ORDER BY t."order" ASC, t.created_at DESC, t.rowid DESC`

export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DiagnosticEventPayload {
  level: DiagnosticLevel
  source: 'task'
  event: string
  message?: string
  taskId?: string
  projectId?: string
  payload?: Record<string, unknown>
}

/**
 * Exec-side worktree/git/fs operations task ops previously ran inline. Injected
 * behind this seam so hub-side task code never spawns git or touches the
 * filesystem directly (hub/computer split, wave 1). Method signatures mirror the
 * `worktrees/server` exports they wrap (narrowed to the parameters
 * task ops actually pass), plus two raw-fs seams (`pathExists`,
 * `removeArtifactDir`) that replace direct `existsSync`/`rmSync` calls.
 *
 * Task owns this interface; the in-process implementation is
 * `defaultWorktreeExecAdapters` in `worktrees/server` (worktrees builds
 * on task, never the reverse), passed in by the composition roots.
 *
 * OVERRIDE CONTRACT: `configureTaskRuntimeAdapters` merges SHALLOWLY. Any
 * future override of `worktrees` must supply a COMPLETE `WorktreeExecAdapters`
 * object — a partial object would silently drop the remaining methods.
 */
export interface WorktreeExecAdapters {
  /**
   * ── `taskId` on every routable method ──────────────────────────────────────
   * Each of these can run on a computer, and picking one requires knowing WHICH
   * TASK the work is for (`resolveTaskComputerId`). The seam previously carried
   * only paths, so the hub-side router had nothing to route on and was pinned to
   * `() => null` — meaning a task whose agent runs on a computer had its worktree
   * created on the HUB, leaving the agent with a cwd that does not exist on its
   * own machine. Every call site already has the id in scope.
   */
  /** `createWorktree` from `worktrees/server`. Answers the computer that made it
   *  (null: this host's own disk) — recorded on the task, so the worktree is removed
   *  there later even when the task's default computer has changed. */
  createWorktree: (
    taskId: string,
    repoPath: string,
    worktreePath: string,
    branch: string,
    sourceBranch?: string
  ) => Promise<{ computerId: string | null }>
  /** `removeWorktree` from `worktrees/server` (no branch deletion). Runs on the
   *  computer that holds the task's worktree (`tasks.worktree_computer_id`, else the
   *  task's computer). */
  removeWorktree: (
    taskId: string,
    projectPath: string,
    worktreePath: string
  ) => Promise<{ branchDeleted?: boolean; branchError?: string }>
  /** `runWorktreeSetupScript` from `worktrees/server`. */
  runWorktreeSetupScript: (
    taskId: string,
    worktreePath: string,
    repoPath: string,
    sourceBranch?: string | null
  ) => Promise<{ ran: boolean; success?: boolean; output?: string }>
  /** `copyIgnoredFiles` from `worktrees/server`. */
  copyIgnoredFiles: (
    taskId: string,
    repoPath: string,
    worktreePath: string,
    behavior: 'all' | 'custom',
    customPaths: string[]
  ) => Promise<void>
  /** `getCurrentBranch` from `worktrees/server`. */
  getCurrentBranch: (taskId: string, repoPath: string) => Promise<string | null>
  /** `isGitRepo` from `worktrees/server`. */
  isGitRepo: (taskId: string, path: string) => Promise<boolean>
  /** `fs.existsSync` for a path in the task's WORKSPACE (e.g. the recovered-worktree
   *  check). Routed: the workspace lives wherever the task's agents run. The local
   *  default stays sync (`boolean`); a computer-backed impl needs a network
   *  round-trip, so the return is widened to allow a Promise (call sites await). */
  pathExists: (taskId: string, path: string) => boolean | Promise<boolean>
  /**
   * `fs.existsSync` for a path in the HUB's own storage (`<ROOT>/storage/...`).
   *
   * Separate from {@link pathExists} on purpose: artifacts are hub-owned data, not
   * workspace files, so this must NEVER be routed to a computer — the directory does
   * not exist there, and requiring a computer to probe it would make archiving a task
   * impossible with no computer connected (which is exactly what happened when both
   * shared one seam).
   */
  hubPathExists: (absPath: string) => boolean | Promise<boolean>
  /** `fs.rmSync(dir, { recursive, force })` for a task's artifact directory under
   *  the HUB's storage. Hub-local for the same reason as {@link hubPathExists}. */
  removeArtifactDir: (absDir: string) => void | Promise<void>
}

/**
 * Hub-side worktree POLICY reads task ops make while auto-creating a worktree:
 * which ignored files to copy, and how the base-path setting template expands.
 * Not exec work (never routed to a computer), so deliberately not part of
 * {@link WorktreeExecAdapters}. Task owns this interface; the implementation is
 * `defaultWorktreePolicyAdapters` in `worktrees/server`, passed in by
 * the composition roots.
 */
export interface WorktreePolicyAdapters {
  /** `resolveCopyBehavior` from `worktrees/server` (hub-side DB read). */
  resolveCopyBehavior: (
    db: SlayzoneDb,
    projectId?: string
  ) => Promise<{ behavior: WorktreeCopyBehavior; customPaths: string[] }>
  /** `DEFAULT_WORKTREE_BASE_PATH_TEMPLATE` from `worktrees/shared`:
   *  used when the `worktree_base_path` setting is unset/empty. */
  defaultBasePathTemplate: string
  /** `resolveWorktreeBasePathTemplate` from `worktrees/shared`. */
  resolveBasePathTemplate: (template: string, projectPath: string) => string
}

/**
 * Whether the computer holding a task's worktree can remove it now (final review
 * round 5, R5-1): `ready` — it is connected; `wait` — not yet (the hub's boot, a
 * reconnect): keep the task and try again when it connects; `gone` — deleted or
 * revoked, it will never answer: the worktree is left on it.
 */
export type WorktreeComputerState = 'ready' | 'wait' | 'gone'

/** What {@link cleanupTaskFull} did with the task's worktree. */
export type WorktreeCleanup = 'none' | 'removed' | 'failed'

export interface TaskRuntimeAdapters {
  killPtysByTaskId: (taskId: string) => void
  removeTaskProcesses: (taskId: string) => void
  recordDiagnosticEvent: (event: DiagnosticEventPayload) => void
  /** Broadcast a respawn request to the renderer when a task transitions from a
   *  terminal status back to a non-terminal one. Renderer decides whether to act. */
  requestPtyRespawn: (taskId: string) => void
  /** Single invariant: all side-effects of "task reached a terminal status".
   *  Wired by the app to terminal/main's onTaskReachedTerminal. Add new side
   *  effects there, not at call sites. */
  onReachedTerminal: (taskId: string) => void
  /** Resolve the app data root (`<ROOT>/storage`). Electron-free seam so ops/
   *  stays server-pure; the app wires it to getStorageDir(). */
  getDataRoot: () => string
  /** Exec-side worktree/git/fs ops. The composition roots pass the in-process
   *  `defaultWorktreeExecAdapters` from `worktrees/server` (or a routing
   *  impl wrapping it); unconfigured, every worktree op rejects/throws. Overrides
   *  must be COMPLETE (shallow merge — see WorktreeExecAdapters). */
  worktrees: WorktreeExecAdapters
  /** Hub-side worktree policy reads. The composition roots pass
   *  `defaultWorktreePolicyAdapters` from `worktrees/server`; unconfigured,
   *  each read throws. Overrides must be COMPLETE (shallow merge). */
  worktreePolicy: WorktreePolicyAdapters
  /**
   * The project's folder on the computer this task's work runs on — where its
   * worktrees are made and removed (the hub's copy, `project_placements`).
   * Unwired (no computers: tests, the fork sidecar): the legacy `projects.path`.
   */
  projectRootForTask: (db: SlayzoneDb, taskId: string, projectId: string) => Promise<string | null>
  /**
   * The project's folder on the computer that HOLDS this task's worktree — where it is
   * removed. Differs from {@link projectRootForTask} when the worktree was made on
   * another computer than the task's current one (`tasks.worktree_computer_id`).
   * Unwired: the legacy `projects.path`.
   */
  worktreeRootForTask: (db: SlayzoneDb, taskId: string, projectId: string) => Promise<string | null>
  /**
   * The state of the computer that holds this task's worktree (R5-1). Unwired (no
   * computers: tests, the fork sidecar): always `ready` — the worktree is local.
   */
  worktreeComputerState: (taskId: string) => Promise<WorktreeComputerState>
}

/** Before computers existed the hub held one path per project; with none wired it still does. */
async function legacyProjectPath(db: SlayzoneDb, projectId: string): Promise<string | null> {
  const row = await db.get<{ path: string | null }>('SELECT path FROM projects WHERE id = ?', [
    projectId
  ])
  return row?.path ?? null
}

function notConfigured(what: string): Error {
  return new Error(
    `TaskRuntimeAdapters.${what} not configured (the composition root passes the ` +
      'implementation from worktrees/server via configureTaskRuntimeAdapters)'
  )
}

/**
 * Placeholder until a composition root injects `defaultWorktreeExecAdapters`
 * (`worktrees/server`): every worktree/git op rejects (sync ones throw).
 * The two hub-STORAGE ops are plain fs, not worktree work, so they keep their
 * real implementation here.
 */
const unconfiguredWorktreeExecAdapters: WorktreeExecAdapters = {
  createWorktree: async () => {
    throw notConfigured('worktrees.createWorktree')
  },
  removeWorktree: async () => {
    throw notConfigured('worktrees.removeWorktree')
  },
  runWorktreeSetupScript: async () => {
    throw notConfigured('worktrees.runWorktreeSetupScript')
  },
  copyIgnoredFiles: async () => {
    throw notConfigured('worktrees.copyIgnoredFiles')
  },
  getCurrentBranch: async () => {
    throw notConfigured('worktrees.getCurrentBranch')
  },
  isGitRepo: async () => {
    throw notConfigured('worktrees.isGitRepo')
  },
  pathExists: async () => {
    throw notConfigured('worktrees.pathExists')
  },
  hubPathExists: (p) => existsSync(p),
  removeArtifactDir: (absDir) => rmSync(absDir, { recursive: true, force: true })
}

const unconfiguredWorktreePolicyAdapters: WorktreePolicyAdapters = {
  resolveCopyBehavior: async () => {
    throw notConfigured('worktreePolicy.resolveCopyBehavior')
  },
  defaultBasePathTemplate: '',
  resolveBasePathTemplate: () => {
    throw notConfigured('worktreePolicy.resolveBasePathTemplate')
  }
}

// Side-effect hooks default to no-ops so ops run unwired (tests, CLI); the app and the
// hub wire every one of them via configureTaskRuntimeAdapters.
const defaultRuntimeAdapters: TaskRuntimeAdapters = {
  killPtysByTaskId: () => {
    // Unwired: no PTYs to kill.
  },
  removeTaskProcesses: () => {
    // Unwired: no processes to kill.
  },
  recordDiagnosticEvent: () => {
    // Unwired: no diagnostics sink.
  },
  requestPtyRespawn: () => {
    // Unwired: no PTYs to respawn.
  },
  onReachedTerminal: () => {
    // Unwired: no teardown to run.
  },
  getDataRoot: () => {
    throw new Error(
      'TaskRuntimeAdapters.getDataRoot not configured (call configureTaskRuntimeAdapters)'
    )
  },
  worktrees: unconfiguredWorktreeExecAdapters,
  worktreePolicy: unconfiguredWorktreePolicyAdapters,
  projectRootForTask: (db, _taskId, projectId) => legacyProjectPath(db, projectId),
  worktreeRootForTask: (db, _taskId, projectId) => legacyProjectPath(db, projectId),
  worktreeComputerState: async () => 'ready'
}

let runtimeAdapters: TaskRuntimeAdapters = defaultRuntimeAdapters

/**
 * SHALLOW merge: top-level keys absent from `adapters` keep their defaults (the
 * unconfigured placeholders for `worktrees` / `worktreePolicy`), so every
 * configure call must re-supply them. Nested objects are NOT deep-merged — a
 * `worktrees` override must pass a COMPLETE `WorktreeExecAdapters`.
 */
export function configureTaskRuntimeAdapters(adapters: Partial<TaskRuntimeAdapters>): void {
  runtimeAdapters = {
    ...defaultRuntimeAdapters,
    ...adapters
  }
}

export function getRuntimeAdapters(): TaskRuntimeAdapters {
  return runtimeAdapters
}

export function safeJsonParse(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// Parse JSON columns from DB row
export function parseTask(row: Record<string, unknown> | undefined): Task | null {
  if (!row) return null
  const providerConfig: ProviderConfig =
    (safeJsonParse(row.provider_config) as ProviderConfig) ?? {}
  // The hub keeps no task path (§9 Phase 7e, v211): a client reads the paths from
  // the computer (`task.paths`); the task says only whether they are set.
  return {
    ...row,
    has_worktree: Boolean(row.has_worktree),
    has_base_dir: Boolean(row.has_base_dir),
    dangerously_skip_permissions: Boolean(row.dangerously_skip_permissions),
    provider_config: providerConfig,
    // Backfill deprecated per-provider fields from provider_config
    claude_flags: providerConfig['claude-code']?.flags ?? '',
    codex_flags: providerConfig['codex']?.flags ?? '',
    cursor_flags: providerConfig['cursor-agent']?.flags ?? '',
    gemini_flags: providerConfig['gemini']?.flags ?? '',
    opencode_flags: providerConfig['opencode']?.flags ?? '',
    panel_visibility: safeJsonParse(row.panel_visibility),
    panel_sizes: safeJsonParse(row.panel_sizes),
    browser_tabs: safeJsonParse(row.browser_tabs),
    web_panel_urls: safeJsonParse(row.web_panel_urls),
    editor_open_files: safeJsonParse(row.editor_open_files),
    diff_collapsed_files: safeJsonParse(row.diff_collapsed_files),
    git_active_tab: (row.git_active_tab as Task['git_active_tab']) ?? null,
    merge_context: safeJsonParse(row.merge_context),
    loop_config: safeJsonParse(row.loop_config),
    is_temporary: Boolean(row.is_temporary),
    is_blocked: Boolean(row.is_blocked),
    active_artifact_id: (row.active_artifact_id as string) ?? null,
    artifacts_sidebar: safeJsonParse(row.artifacts_sidebar),
    needs_attention: Boolean(row.needs_attention),
    dev_url_toast_dismissed: Boolean(row.dev_url_toast_dismissed),
    pinned: Boolean(row.pinned),
    tree_collapsed: Boolean(row.tree_collapsed),
    commit_graph_config: safeJsonParse(row.commit_graph_config)
  } as Task
}

export function parseTasks(rows: Record<string, unknown>[]): Task[] {
  return rows.map((row) => parseTask(row)!)
}

export async function getProjectColumns(
  db: SlayzoneDb,
  projectId: string
): Promise<ColumnConfig[] | null> {
  const row = await db.get<{ columns_config: string | null }>(
    'SELECT columns_config FROM projects WHERE id = ?',
    [projectId]
  )
  return parseColumnsConfig(row?.columns_config)
}

export type AgentFlagsRow = { id: string; default_flags: string | null }

export async function getEnabledModeDefaults(db: SlayzoneDb): Promise<AgentFlagsRow[]> {
  let rows: AgentFlagsRow[] = []
  try {
    rows = await db.all<AgentFlagsRow>('SELECT id, default_flags FROM agents WHERE enabled = 1')
  } catch {
    rows = []
  }

  if (rows.length > 0) return rows

  return DEFAULT_AGENTS.filter((mode) => mode.enabled).map((mode) => ({
    id: mode.id,
    default_flags: mode.defaultFlags ?? ''
  }))
}

export async function getModeDefaultFlags(
  db: SlayzoneDb,
  modeId: string
): Promise<string | undefined> {
  try {
    const row = await db.get<{ default_flags: string | null }>(
      'SELECT default_flags FROM agents WHERE id = ?',
      [modeId]
    )
    if (row) return row.default_flags ?? ''
  } catch {
    // Fall back to built-in defaults when agents is unavailable or unseeded.
  }

  const fallback = DEFAULT_AGENTS.find((mode) => mode.id === modeId)
  return fallback ? (fallback.defaultFlags ?? '') : undefined
}

/** Kill PTY only — used for soft-delete (preserves worktree for undo) */
export function cleanupTaskImmediate(taskId: string): void {
  runtimeAdapters.killPtysByTaskId(taskId)
}

/** Kill PTY + processes + remove worktree + artifact files — used for archive and hard purge.
 *  `batchIds` lists every task being cleaned up in the same operation so the shared-worktree
 *  guard ignores siblings that are about to be archived (e.g. cascade from parent). */
export async function cleanupTaskFull(
  db: SlayzoneDb,
  taskId: string,
  batchIds: string[] = [taskId],
  /** The purge of a task whose computer is gone for good: there is no one to ask. */
  opts: { skipWorktree?: boolean; preserveArtifacts?: boolean } = {}
): Promise<WorktreeCleanup> {
  // Resolved first: an id that is not one plain path segment (`..` named the data dir)
  // is refused (`UnsafePathError`) before anything is killed or removed. getDataRoot()
  // is the single source of truth for the storage dir (<ROOT>/storage).
  const artifactsBaseDir = artifactTaskDir(artifactsDirOf(runtimeAdapters.getDataRoot()), taskId)
  cleanupTaskImmediate(taskId)
  runtimeAdapters.removeTaskProcesses(taskId)
  // Clean up artifact files on disk.
  // HUB storage, not workspace: never routed to a computer (see hubPathExists).
  if (
    !opts.preserveArtifacts &&
    (await runtimeAdapters.worktrees.hubPathExists(artifactsBaseDir))
  ) {
    await runtimeAdapters.worktrees.removeArtifactDir(artifactsBaseDir)
  }

  const task = await db.get<{ has_worktree: number; project_id: string }>(
    'SELECT has_worktree, project_id FROM tasks WHERE id = ?',
    [taskId]
  )

  if (!task?.has_worktree || opts.skipWorktree) return 'none'

  // The computer holding the task's folders knows its worktree and whether another
  // live task (outside this batch) still names it — a subtask inherits its parent's
  // worktree; the first batch member to clean up removes it (robustness plan §9, 7e).
  const ids = new Set(batchIds.length > 0 ? batchIds : [taskId])
  const live = (
    await db.all<{ id: string }>(
      'SELECT id FROM tasks WHERE project_id = ? AND archived_at IS NULL AND deleted_at IS NULL',
      [task.project_id]
    )
  )
    .map((r) => r.id)
    .filter((id) => !ids.has(id))

  try {
    if (!taskPathsDelegate) return 'none'
    const release = await taskPathsDelegate.release(taskId, live)
    if (!release.worktreePath || release.shared) return 'none'
    // The worktree lives on the computer it was made on, next to the project's folder there.
    const projectRoot = await runtimeAdapters.worktreeRootForTask(db, taskId, task.project_id)
    if (!projectRoot) return 'none'
    await runtimeAdapters.worktrees.removeWorktree(taskId, projectRoot, release.worktreePath)
    return 'removed'
  } catch (err) {
    console.error('Failed to remove worktree:', err)
    runtimeAdapters.recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'task.cleanup_worktree_failed',
      taskId,
      projectId: task.project_id,
      message: err instanceof Error ? err.message : String(err)
    })
    return 'failed'
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function parseBooleanSetting(value: string | null | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

export async function isAutoCreateWorktreeEnabled(
  db: SlayzoneDb,
  projectId: string
): Promise<boolean> {
  const projectRow = await db.get<{ auto_create_worktree_on_task_create: number | null }>(
    'SELECT auto_create_worktree_on_task_create FROM projects WHERE id = ?',
    [projectId]
  )

  if (projectRow?.auto_create_worktree_on_task_create === 1) return true
  if (projectRow?.auto_create_worktree_on_task_create === 0) return false

  const globalRow = await db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'auto_create_worktree_on_task_create'"
  )
  return parseBooleanSetting(globalRow?.value)
}

export async function maybeAutoCreateWorktree(
  db: SlayzoneDb,
  taskId: string,
  projectId: string,
  taskTitle: string,
  repoName?: string | null
): Promise<void> {
  if (!(await isAutoCreateWorktreeEnabled(db, projectId))) return

  // Auto-creation is BEST-EFFORT by contract (hence "maybe", and the
  // `auto_worktree_skipped` diagnostics below): the task must be created either
  // way. So a missing computer SKIPS the worktree instead of failing the create —
  // the exec seams throw when unrouted, and this runs during task creation,
  // before any agent exists to need a workspace. The user can attach a worktree
  // later once a computer is connected.
  try {
    await createWorktreeForTask(db, taskId, projectId, taskTitle, repoName)
  } catch (err) {
    // A hub with processes switched off refuses the hub-local fallback the same way
    // (`NO_COMPUTER_CONNECTED`, T-06) — same skip, never a failed create.
    if (
      (err instanceof Error && err.name === 'NoComputerAvailableError') ||
      (isHubSwitchedOffError(err) && err.code === 'NO_COMPUTER_CONNECTED')
    ) {
      runtimeAdapters.recordDiagnosticEvent({
        level: 'warn',
        source: 'task',
        event: 'task.auto_worktree_skipped',
        taskId,
        projectId,
        message: 'No computer available — worktree not created'
      })
      return
    }
    throw err
  }
}

/** The actual auto-create flow. Split out so `maybeAutoCreateWorktree` can treat
 *  "no computer" as a skip without wrapping every internal step. */
async function createWorktreeForTask(
  db: SlayzoneDb,
  taskId: string,
  projectId: string,
  taskTitle: string,
  repoName?: string | null
): Promise<void> {
  const projectRow = await db.get<{ worktree_source_branch: string | null }>(
    'SELECT worktree_source_branch FROM projects WHERE id = ?',
    [projectId]
  )
  // The project's folder on the computer this task's work runs on: the worktree is
  // made there, by that computer.
  const projectPath = await runtimeAdapters.projectRootForTask(db, taskId, projectId)
  if (!projectRow || !projectPath) {
    runtimeAdapters.recordDiagnosticEvent({
      level: 'info',
      source: 'task',
      event: 'task.auto_worktree_skipped',
      taskId,
      projectId,
      message: 'Project path is not set'
    })
    return
  }

  // Resolve effective repo path (child repo if multi-repo, otherwise the project folder)
  let repoPath = projectPath
  let isRepo: boolean
  try {
    if (repoName) {
      const childPath = path.join(projectPath, repoName)
      if (await runtimeAdapters.worktrees.isGitRepo(taskId, childPath)) {
        repoPath = childPath
      }
    }
    isRepo = await runtimeAdapters.worktrees.isGitRepo(taskId, repoPath)
  } catch (err) {
    // The probe throws when git could not be STARTED. Same skip as before it threw
    // (a failed probe used to read as "not a repo"), but logged as the error it is.
    // "No computer" is not ours — the caller turns that into its own skip.
    if (err instanceof Error && err.name === 'NoComputerAvailableError') throw err
    if (isHubSwitchedOffError(err)) throw err
    runtimeAdapters.recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'task.auto_worktree_skipped',
      taskId,
      projectId,
      message: `Git repo probe failed: ${err instanceof Error ? err.message : String(err)}`,
      payload: { projectPath: repoPath }
    })
    return
  }

  if (!isRepo) {
    runtimeAdapters.recordDiagnosticEvent({
      level: 'info',
      source: 'task',
      event: 'task.auto_worktree_skipped',
      taskId,
      projectId,
      message: 'Project path is not a git repository',
      payload: { projectPath: repoPath }
    })
    return
  }

  const baseTemplate =
    (await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'worktree_base_path'"))
      ?.value || runtimeAdapters.worktreePolicy.defaultBasePathTemplate
  const basePath = runtimeAdapters.worktreePolicy.resolveBasePathTemplate(baseTemplate, repoPath)
  const branch = slugify(taskTitle) || `task-${taskId.slice(0, 8)}`
  const worktreePath = path.join(basePath, branch)
  const parentBranch = await runtimeAdapters.worktrees.getCurrentBranch(taskId, repoPath)

  const sourceBranch = projectRow.worktree_source_branch ?? undefined

  // Block A: Create worktree and link to task immediately
  let made: { computerId: string | null }
  try {
    made = await runtimeAdapters.worktrees.createWorktree(
      taskId,
      repoPath,
      worktreePath,
      branch,
      sourceBranch
    )
  } catch (err) {
    // Git may exit non-zero after creating the worktree (e.g. post-checkout hook failure).
    // If the dir exists, still link it — better than orphaning a worktree the user can see.
    if (await runtimeAdapters.worktrees.pathExists(taskId, worktreePath)) {
      // Which computer holds it is not known here: the first write that reaches one
      // records it (hub computer-task-paths.ts `recordHolder`).
      await db.run(
        `
        UPDATE tasks
        SET has_worktree = 1, worktree_parent_branch = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
        [parentBranch, taskId]
      )
      await notifyTaskPaths(taskId, { op: 'set', worktreePath })
      runtimeAdapters.recordDiagnosticEvent({
        level: 'warn',
        source: 'task',
        event: 'task.auto_worktree_recovered',
        taskId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
        payload: { projectPath: projectPath, worktreePath, branch, parentBranch, sourceBranch }
      })
    } else {
      runtimeAdapters.recordDiagnosticEvent({
        level: 'error',
        source: 'task',
        event: 'task.auto_worktree_create_failed',
        taskId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
        payload: { projectPath: projectPath, baseTemplate, basePath, branch, worktreePath }
      })
    }
    return
  }

  // Worktree created — link to task before any post-creation steps, with the computer
  // that holds it: it is removed there, whichever computer is the task's later.
  await db.run(
    `
    UPDATE tasks
    SET has_worktree = 1, worktree_parent_branch = ?,
        worktree_computer_id = COALESCE(?, worktree_computer_id), updated_at = datetime('now')
    WHERE id = ?
  `,
    [parentBranch, made.computerId, taskId]
  )
  await notifyTaskPaths(taskId, { op: 'set', worktreePath })
  runtimeAdapters.recordDiagnosticEvent({
    level: 'info',
    source: 'task',
    event: 'task.auto_worktree_created',
    taskId,
    projectId,
    payload: { projectPath: projectPath, worktreePath, branch, parentBranch, sourceBranch }
  })

  // Block B: Post-creation extras (non-critical, won't affect linkage)
  try {
    // resolveCopyBehavior is a hub-side DB read — the policy seam, not part of
    // WorktreeExecAdapters (only exec work goes behind that seam).
    const { behavior: copyBehavior, customPaths } =
      await runtimeAdapters.worktreePolicy.resolveCopyBehavior(db, projectId)
    if (copyBehavior === 'all' || copyBehavior === 'custom') {
      await runtimeAdapters.worktrees.copyIgnoredFiles(
        taskId,
        repoPath,
        worktreePath,
        copyBehavior,
        customPaths
      )
    }
  } catch (copyErr) {
    runtimeAdapters.recordDiagnosticEvent({
      level: 'warn',
      source: 'task',
      event: 'task.auto_worktree_copy_failed',
      taskId,
      projectId,
      message: copyErr instanceof Error ? copyErr.message : String(copyErr),
      payload: { worktreePath }
    })
  }

  // Fire-and-forget: don't block task creation on setup script. Caught: a routed run
  // rejects (a script past the RPC timeout, a computer that went away), and unheard
  // that rejection ended the hub's process (T-102).
  runtimeAdapters.worktrees
    .runWorktreeSetupScript(taskId, worktreePath, repoPath, sourceBranch)
    .catch((err: unknown) => {
      runtimeAdapters.recordDiagnosticEvent({
        level: 'warn',
        source: 'task',
        event: 'task.auto_worktree_setup_failed',
        taskId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
        payload: { worktreePath }
      })
    })
}

/**
 * An update that breaks a task invariant (unknown status, out-of-range priority).
 * A caller bug, not a server fault — transports map it to "bad request".
 */
export class InvalidTaskUpdateError extends Error {
  override name = 'InvalidTaskUpdateError'
}

/**
 * The computer that holds (or would hold) a task's folders cannot take a path now:
 * none holds them, or it is not connected (§9 Phase 7e — the hub keeps no path).
 * A precondition the caller can fix by connecting it, not a server fault —
 * transports map it to "precondition failed" / 409.
 */
export class TaskFoldersUnavailableError extends Error {
  override name = 'TaskFoldersUnavailableError'
}

/**
 * A move names a project this hub does not have (a stale picker, another hub's
 * project). A caller error — transports map it to "bad request" — never the raw
 * foreign-key failure it would otherwise be.
 */
export class ProjectNotFoundError extends Error {
  override name = 'ProjectNotFoundError'
  constructor(projectId: string) {
    super(`Project not found: ${projectId}`)
  }
}

interface UpdateTarget {
  existing: { project_id: string; status: string; is_temporary: number } | undefined
  targetProjectId: string | undefined
  targetColumns: ColumnConfig[] | null
  projectChanged: boolean
}

async function readUpdateTarget(db: SlayzoneDb, data: UpdateTaskInput): Promise<UpdateTarget> {
  const existing = await db.get<{ project_id: string; status: string; is_temporary: number }>(
    'SELECT project_id, status, is_temporary FROM tasks WHERE id = ?',
    [data.id]
  )
  const targetProjectId = data.projectId ?? existing?.project_id
  const targetColumns = targetProjectId ? await getProjectColumns(db, targetProjectId) : null
  const projectChanged =
    existing !== undefined && data.projectId !== undefined && existing.project_id !== data.projectId
  return { existing, targetProjectId, targetColumns, projectChanged }
}

/**
 * Rejects an update that would write an invalid status or priority. An explicit
 * status must be a column of the task's project — it is NOT coerced to the
 * default column, because that silently hid caller bugs (a stray `status: ''`
 * from the settings panel dropped tasks into Inbox). The one exception is a
 * project move, which re-homes a status the target project lacks (`updateTask`).
 * A missing task is left to the caller's not-found path.
 */
function assertValidTaskUpdate(data: UpdateTaskInput, target: UpdateTarget): void {
  if (!target.existing) return
  if (data.status !== undefined) {
    const unknownHere = !isKnownStatus(data.status, target.targetColumns)
    if (data.status === '' || (unknownHere && !target.projectChanged)) {
      throw new InvalidTaskUpdateError(
        `Unknown status ${JSON.stringify(data.status)} for this task's project.`
      )
    }
  }
  if (data.priority !== undefined && !prioritySchema.safeParse(data.priority).success) {
    throw new InvalidTaskUpdateError(
      `Invalid priority ${JSON.stringify(data.priority)}: must be an integer 1-5.`
    )
  }
}

/** `updateTask`'s invariant check on its own, for validating a batch before writing any of it. */
export async function validateTaskUpdate(db: SlayzoneDb, data: UpdateTaskInput): Promise<void> {
  assertValidTaskUpdate(data, await readUpdateTarget(db, data))
}

/**
 * Where a chat's settings go once a computer owns the chat (robustness plan §9,
 * decision 2): that computer holds the only copy. The hub's composition installs
 * it; without one (tests, a hub with no computers) `provider_config` chat keys are
 * plain starting values.
 */
export interface ChatSettingsDelegate {
  /** The task's chat modes whose chat a computer owns (or is taking over). */
  ownedModes(taskId: string): Promise<ReadonlySet<string>>
  /** Change those settings on the chat's computer. */
  apply(taskId: string, mode: string, settings: Record<string, unknown>): Promise<void>
}
let chatSettingsDelegate: ChatSettingsDelegate | null = null
export function setChatSettingsDelegate(delegate: ChatSettingsDelegate | null): void {
  chatSettingsDelegate = delegate
}

/**
 * A task's worktree path and base dir live on its computer (robustness plan §9, P0,
 * Phase 7a; 7e, v211: the hub keeps no copy, only `has_worktree` / `has_base_dir`):
 * that computer runs every write. The hub's composition installs this; every writer
 * here reports the values it wrote after its flag write. Without one (tests, a hub
 * with no computers) the paths have nowhere to live: only the flags change.
 */
export type TaskPathChange =
  /** The fields this write sets (absent = unchanged; null clears). */
  | { op: 'set'; worktreePath?: string | null; baseDir?: string | null }
  | { op: 'inherit'; parentTaskId: string }
  | { op: 'clear' }
/** The worktree a cleanup may remove, on `computerId`; `shared`: a live task keeps it. */
export interface TaskPathRelease {
  worktreePath: string | null
  shared: boolean
  computerId: string
}
export interface TaskPathsDelegate {
  /** The task's paths changed as `change`: run it on the computer holding its folders. */
  changed(taskId: string, change: TaskPathChange): Promise<void>
  /**
   * The task's checkout is about to be removed: its worktree (as the computer holding
   * it knows) and whether a task in `liveTaskIds` still names it. Throws when that
   * computer cannot be asked.
   */
  release(taskId: string, liveTaskIds: readonly string[]): Promise<TaskPathRelease>
  /**
   * A path the user sets: written on the computer holding the task's folders (a task
   * with none yet: where its work runs, which then holds them) before the hub records
   * that it is set. Throws when that computer is away or refuses the path.
   */
  apply(
    taskId: string,
    patch: { worktreePath?: string | null; baseDir?: string | null }
  ): Promise<void>
  /** A purged task's checkout is dealt with: its computer may forget the path. */
  forget(taskId: string, computerId: string): Promise<void>
  /**
   * The tasks' paths as the computer holding each answers (§9 Phase 7d): `offline`
   * for a task whose computer is not connected. Never answers from a hub copy.
   */
  read(taskIds: readonly string[]): Promise<Record<string, TaskPathState>>
}
let taskPathsDelegate: TaskPathsDelegate | null = null
export function setTaskPathsDelegate(delegate: TaskPathsDelegate | null): void {
  taskPathsDelegate = delegate
}
/** The installed delegate (tests that stand in for a computer restore it). */
export function getTaskPathsDelegate(): TaskPathsDelegate | null {
  return taskPathsDelegate
}
/**
 * The tasks' paths from their computers (§9 Phase 7d). Without a delegate (a hub with
 * no computers) every task answers `offline`: there is nowhere the paths live.
 */
export async function readTaskPaths(
  taskIds: readonly string[]
): Promise<Record<string, TaskPathState>> {
  if (!taskPathsDelegate)
    return Object.fromEntries(taskIds.map((id) => [id, { state: 'offline', computerId: null }]))
  return taskPathsDelegate.read(taskIds)
}

/**
 * Tell the task's computer; never fails the hub write (the delegate stages what it
 * cannot send). Then every client re-reads the task's paths (`task:paths-changed`):
 * nothing else tells them a path changed (B2 — their reads are not keyed on the row's
 * version).
 */
export async function notifyTaskPaths(taskId: string, change: TaskPathChange): Promise<void> {
  try {
    await taskPathsDelegate?.changed(taskId, change)
  } catch (error) {
    console.warn(`[task] paths of ${taskId} not handed to its computer:`, error)
  }
  taskEvents.emit('task:paths-changed', { taskId })
}

export async function updateTask(db: SlayzoneDb, data: UpdateTaskInput): Promise<Task | null> {
  const target = await readUpdateTarget(db, data)
  assertValidTaskUpdate(data, target)
  const { existing, targetProjectId, targetColumns, projectChanged } = target
  // A project change is a move — subtasks, tags, detaching — and has exactly one
  // path: `applyProjectChange` / `moveTasksToProject` (ops/move-to-project.ts),
  // which the update ops run before handing the rest of the update here.
  if (projectChanged)
    throw new Error('A project change goes through moveTasksToProject, not updateTask')

  // Auto-promote a temporary task when its title is renamed. Mirrors "Turn into task" behavior:
  // clears is_temporary and moves status into the `started` category. Caller can opt out by
  // passing isTemporary explicitly.
  const shouldPromoteFromTemp =
    data.title !== undefined && existing?.is_temporary === 1 && data.isTemporary === undefined

  let normalizedStatusForWrite: string | undefined
  if (data.status !== undefined) {
    normalizedStatusForWrite = data.status
  } else if (shouldPromoteFromTemp) {
    normalizedStatusForWrite =
      getStatusByCategory('started', targetColumns) ?? getDefaultStatus(targetColumns)
  }

  // Status-regression telemetry — catches an unexpected demotion of a task back
  // into the project's default/triage column (the "task keeps jumping to inbox"
  // class of bug). Fires only on the signature — a write that moves the task
  // from a MORE-advanced workflow category down to `getDefaultStatus` (a project
  // move, which legitimately re-homes statuses, never comes through here). The
  // stack trace (built only in this rare branch, so the common path pays
  // nothing) names the offending caller. level:'error' forces an immediate
  // diagnostics flush so a crash/restart can't lose it. Query via:
  //   SELECT * FROM diagnostics_events WHERE event='task.status_regression'
  if (normalizedStatusForWrite !== undefined && existing?.status) {
    const defaultStatus = getDefaultStatus(targetColumns)
    const categoryRank = (statusId: string): number => {
      const category = getColumnById(statusId, targetColumns)?.category
      const rank = category ? WORKFLOW_CATEGORIES.indexOf(category) : -1
      return rank
    }
    const isDemotionToDefault =
      normalizedStatusForWrite === defaultStatus &&
      normalizedStatusForWrite !== existing.status &&
      categoryRank(existing.status) > categoryRank(normalizedStatusForWrite)
    if (isDemotionToDefault) {
      recordDiagnosticEvent({
        level: 'error',
        source: 'task',
        event: 'task.status_regression',
        taskId: data.id,
        message: `${existing.status} -> ${normalizedStatusForWrite}`,
        payload: {
          incoming: data.status ?? null,
          existing: existing.status,
          resolved: normalizedStatusForWrite,
          shouldPromoteFromTemp,
          stack: new Error('status-regression-stack').stack
        }
      })
    }
  }

  const fields: string[] = []
  const values: unknown[] = []
  /** The paths this update writes, for the computer holding the task's folders. */
  const pathPatch: { worktreePath?: string | null; baseDir?: string | null } = {}
  const chatSettingsPushes: Array<{ mode: string; settings: Record<string, unknown> }> = []
  /** A worktree / base-dir change: every tab's session resets (below). */
  let resetsWholeTask = false

  if (data.title !== undefined) {
    fields.push('title = ?')
    values.push(data.title)
  }
  if (data.description !== undefined) {
    fields.push('description = ?', "description_format = 'markdown'")
    values.push(data.description)
  }
  if (data.status !== undefined || normalizedStatusForWrite !== undefined) {
    fields.push('status = ?')
    values.push(normalizedStatusForWrite ?? data.status)
  }
  if (data.assignee !== undefined) {
    fields.push('assignee = ?')
    values.push(data.assignee)
  }
  if (data.priority !== undefined) {
    fields.push('priority = ?')
    values.push(data.priority)
  }
  if (data.progress !== undefined) {
    fields.push('progress = ?')
    values.push(Math.max(0, Math.min(100, Math.round(data.progress))))
  }
  if (data.dueDate !== undefined) {
    fields.push('due_date = ?')
    values.push(data.dueDate)
  }
  if (data.parentId !== undefined) {
    // `validateReparent` does synchronous `lookup(id)` calls (task, parent, and the
    // ancestor chain walking up from parent). Pre-fetch every row it could touch into
    // a Map up-front, then back the sync lookup with it. The recursive CTE collects the
    // task row, the parent row, and all ancestors of the parent.
    const lookupRows =
      data.parentId === null
        ? await db.all<ReparentTaskRow>(
            'SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = ?',
            [data.id]
          )
        : await db.all<ReparentTaskRow>(
            `WITH RECURSIVE ancestors(id, project_id, parent_id, archived_at, deleted_at) AS (
               SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = ?
               UNION
               SELECT t.id, t.project_id, t.parent_id, t.archived_at, t.deleted_at
               FROM tasks t JOIN ancestors a ON t.id = a.parent_id
             )
             SELECT id, project_id, parent_id, archived_at, deleted_at FROM ancestors
             UNION
             SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = ?`,
            [data.parentId, data.id]
          )
    const lookupMap = new Map(lookupRows.map((r) => [r.id, r]))
    const result = validateReparent({
      taskId: data.id,
      parentId: data.parentId,
      targetProjectId,
      lookup: (id) => lookupMap.get(id) ?? null
    })
    if (!result.ok) {
      throw new Error(
        reparentErrorMessage(result.error, { taskId: data.id, parentId: data.parentId })
      )
    }
    fields.push('parent_id = ?')
    values.push(data.parentId)
  }
  if (data.agentId !== undefined) {
    fields.push('agent_id = ?')
    values.push(data.agentId)
  }
  if (data.terminalShell !== undefined) {
    fields.push('terminal_shell = ?')
    values.push(data.terminalShell)
  }

  // --- Provider config: merge providerConfig + legacy per-field updates ---
  {
    const legacyMappings: Array<{
      mode: string
      col: string
      flags?: string
      hasFlags: boolean
    }> = [
      {
        mode: 'claude-code',
        col: 'claude',
        flags: data.claudeFlags,
        hasFlags: data.claudeFlags !== undefined
      },
      {
        mode: 'codex',
        col: 'codex',
        flags: data.codexFlags,
        hasFlags: data.codexFlags !== undefined
      },
      {
        mode: 'cursor-agent',
        col: 'cursor',
        flags: data.cursorFlags,
        hasFlags: data.cursorFlags !== undefined
      },
      {
        mode: 'gemini',
        col: 'gemini',
        flags: data.geminiFlags,
        hasFlags: data.geminiFlags !== undefined
      },
      {
        mode: 'opencode',
        col: 'opencode',
        flags: data.opencodeFlags,
        hasFlags: data.opencodeFlags !== undefined
      }
    ]
    const hasLegacyUpdate = legacyMappings.some((m) => m.hasFlags)
    const shouldResetConversationIds =
      (data.worktreePath !== undefined || data.baseDir !== undefined) &&
      data.providerConfig === undefined &&
      !hasLegacyUpdate
    resetsWholeTask = shouldResetConversationIds

    if (
      data.providerConfig !== undefined ||
      hasLegacyUpdate ||
      data.agentId !== undefined ||
      shouldResetConversationIds
    ) {
      // Read current provider_config
      const currentRow = await db.get<{ provider_config: string }>(
        'SELECT provider_config FROM tasks WHERE id = ?',
        [data.id]
      )
      const current: ProviderConfig =
        (safeJsonParse(currentRow?.provider_config) as ProviderConfig) ?? {}
      // Deep merge: per-mode entry merge so partial updates don't clobber existing fields
      const merged: ProviderConfig = { ...current }

      if (data.providerConfig !== undefined) {
        const owned =
          chatSettingsDelegate &&
          Object.values(data.providerConfig).some((entry) =>
            COMPUTER_OWNED_CHAT_KEYS.some((key) => entry && Object.hasOwn(entry, key))
          )
            ? await chatSettingsDelegate.ownedModes(data.id)
            : null
        for (const [mode, entry] of Object.entries(data.providerConfig)) {
          if (owned?.has(mode) && entry) {
            // A computer owns this chat: its settings change there, and the hub
            // keeps no copy. The session id is never set through a task update.
            const rest: Record<string, unknown> = { ...entry }
            const settings: Record<string, unknown> = {}
            for (const key of COMPUTER_OWNED_CHAT_KEYS) {
              if (Object.hasOwn(rest, key) && key !== 'chatConversationId')
                settings[key] = rest[key]
              delete rest[key]
            }
            if (Object.keys(settings).length) chatSettingsPushes.push({ mode, settings })
            const kept: Record<string, unknown> = { ...current[mode], ...rest }
            for (const key of COMPUTER_OWNED_CHAT_KEYS) delete kept[key]
            merged[mode] = kept as ProviderConfig[string]
            continue
          }
          // Session ids are never the hub's (robustness plan §9): an older client's
          // `conversationId` / `conversationHistory` is dropped, not stored.
          const {
            conversationId: _id,
            conversationHistory: _history,
            ...hubKeys
          } = (entry ?? {}) as Record<string, unknown>
          merged[mode] = { ...current[mode], ...hubKeys }
        }
      }

      // Apply legacy field updates on top
      for (const m of legacyMappings) {
        if (m.hasFlags) merged[m.mode] = { ...merged[m.mode], flags: m.flags }
      }

      // Seed default flags when switching agent (not for Claude chat,
      // whose pills own its spawn flags)
      if (data.agentId !== undefined && !chatOwnsSpawnFlags(data.agentId)) {
        const defaultFlags = await getModeDefaultFlags(db, data.agentId)
        if (defaultFlags !== undefined) {
          merged[data.agentId] = { ...merged[data.agentId], flags: defaultFlags }
        }
      }

      fields.push('provider_config = ?')
      values.push(JSON.stringify(merged))

      // Dual-write to legacy columns
      for (const m of legacyMappings) {
        const entry = merged[m.mode]
        if (!entry) continue
        if (m.hasFlags || data.providerConfig !== undefined) {
          fields.push(`${m.col}_flags = ?`)
          values.push(entry.flags ?? '')
        }
      }
    }
  }
  if (data.panelVisibility !== undefined) {
    fields.push('panel_visibility = ?')
    values.push(data.panelVisibility ? JSON.stringify(data.panelVisibility) : null)
  }
  if (data.panelSizes !== undefined) {
    fields.push('panel_sizes = ?')
    values.push(data.panelSizes ? JSON.stringify(data.panelSizes) : null)
  }
  // A project move clears these too (`moveTasksToProject`).
  if (data.worktreePath !== undefined) pathPatch.worktreePath = data.worktreePath || null
  if (data.worktreeParentBranch !== undefined) {
    fields.push('worktree_parent_branch = ?')
    values.push(data.worktreeParentBranch)
  }
  if (data.baseDir !== undefined) pathPatch.baseDir = data.baseDir || null
  if (data.browserUrl !== undefined) {
    fields.push('browser_url = ?')
    values.push(data.browserUrl)
  }
  if (data.prUrl !== undefined) {
    fields.push('pr_url = ?')
    values.push(data.prUrl)
  }
  if (data.browserTabs !== undefined) {
    // Preserve server-authoritative per-tab flags (`agentTouched`, `locked`)
    // when the renderer writes back tabs via generic updates (URL/title from
    // did-navigate, etc.). Those flags have dedicated write paths
    // (`markTabAgentTouched` in REST, `setTabLockedOp` in IPC) and must not
    // be clobbered by stale renderer state.
    const merged = data.browserTabs
      ? await (async () => {
          if (!data.browserTabs) return null
          const existingRow = await db.get<{ browser_tabs: string | null }>(
            'SELECT browser_tabs FROM tasks WHERE id = ?',
            [data.id]
          )
          let existingTabs: { id: string; agentTouched?: boolean; locked?: boolean }[] = []
          if (existingRow?.browser_tabs) {
            try {
              const parsed = JSON.parse(existingRow.browser_tabs) as { tabs?: typeof existingTabs }
              if (Array.isArray(parsed.tabs)) existingTabs = parsed.tabs
            } catch {
              /* ignore */
            }
          }
          const existingById = new Map(existingTabs.map((t) => [t.id, t]))
          return {
            ...data.browserTabs,
            tabs: data.browserTabs.tabs.map((t) => {
              const prev = existingById.get(t.id)
              if (!prev) return t
              return {
                ...t,
                ...(prev.agentTouched !== undefined ? { agentTouched: prev.agentTouched } : {}),
                ...(prev.locked !== undefined ? { locked: prev.locked } : {})
              }
            })
          }
        })()
      : null
    fields.push('browser_tabs = ?')
    values.push(merged ? JSON.stringify(merged) : null)
  }
  if (data.webPanelUrls !== undefined) {
    fields.push('web_panel_urls = ?')
    values.push(data.webPanelUrls ? JSON.stringify(data.webPanelUrls) : null)
  }
  if (data.editorOpenFiles !== undefined) {
    fields.push('editor_open_files = ?')
    values.push(data.editorOpenFiles ? JSON.stringify(data.editorOpenFiles) : null)
  }
  if (data.diffCollapsedFiles !== undefined) {
    fields.push('diff_collapsed_files = ?')
    values.push(
      data.diffCollapsedFiles && data.diffCollapsedFiles.length
        ? JSON.stringify(data.diffCollapsedFiles)
        : null
    )
  }
  if (data.gitActiveTab !== undefined) {
    fields.push('git_active_tab = ?')
    values.push(data.gitActiveTab)
  }
  if (data.mergeState !== undefined) {
    fields.push('merge_state = ?')
    values.push(data.mergeState)
  }
  if (data.mergeContext !== undefined) {
    fields.push('merge_context = ?')
    values.push(data.mergeContext ? JSON.stringify(data.mergeContext) : null)
  }
  if (data.loopConfig !== undefined) {
    fields.push('loop_config = ?')
    values.push(data.loopConfig ? JSON.stringify(data.loopConfig) : null)
  }
  if (data.snoozedUntil !== undefined) {
    fields.push('snoozed_until = ?')
    values.push(data.snoozedUntil)
  }
  if (data.isTemporary !== undefined) {
    fields.push('is_temporary = ?')
    values.push(data.isTemporary ? 1 : 0)
  } else if (shouldPromoteFromTemp) {
    fields.push('is_temporary = ?')
    values.push(0)
  }
  if (data.isBlocked !== undefined) {
    fields.push('is_blocked = ?')
    values.push(data.isBlocked ? 1 : 0)
  }
  if (data.blockedComment !== undefined) {
    fields.push('blocked_comment = ?')
    values.push(data.blockedComment)
  }
  if (data.repoName !== undefined) {
    fields.push('repo_name = ?')
    values.push(data.repoName)
  }
  if (data.activeArtifactId !== undefined) {
    fields.push('active_artifact_id = ?')
    values.push(data.activeArtifactId)
  }
  if (data.artifactsSidebar !== undefined) {
    fields.push('artifacts_sidebar = ?')
    values.push(data.artifactsSidebar ? JSON.stringify(data.artifactsSidebar) : null)
  }
  if (data.needsAttention !== undefined) {
    fields.push('needs_attention = ?')
    values.push(data.needsAttention ? 1 : 0)
  }
  if (data.devUrlToastDismissed !== undefined) {
    fields.push('dev_url_toast_dismissed = ?')
    values.push(data.devUrlToastDismissed ? 1 : 0)
  }
  if (data.pinned !== undefined) {
    fields.push('pinned = ?')
    values.push(data.pinned ? 1 : 0)
  }
  if (data.pinOrder !== undefined) {
    fields.push('pin_order = ?')
    values.push(data.pinOrder)
  }
  if (data.treeCollapsed !== undefined) {
    fields.push('tree_collapsed = ?')
    values.push(data.treeCollapsed ? 1 : 0)
  }
  if (data.commitGraphConfig !== undefined) {
    fields.push('commit_graph_config = ?')
    values.push(data.commitGraphConfig ? JSON.stringify(data.commitGraphConfig) : null)
  }

  if (fields.length === 0) {
    const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [data.id])
    return parseTask(row)
  }

  // The hub keeps only whether each path is set (§9 Phase 7e); the values live on
  // the computer holding the task's folders. A path the USER sets is written there
  // first — that computer judges it (never inside another task's or project's
  // folder) and must be connected; a refusal fails the update. Clears (a project
  // change) are handed over after, staged while it is away.
  const userPaths = data.worktreePath !== undefined || data.baseDir !== undefined
  if (userPaths) {
    if (!taskPathsDelegate)
      throw new TaskFoldersUnavailableError(
        "No computer holds this task's folders: its paths cannot be set"
      )
    await taskPathsDelegate.apply(data.id, pathPatch)
  }
  if (pathPatch.worktreePath !== undefined || pathPatch.baseDir !== undefined) {
    if (pathPatch.worktreePath !== undefined) {
      fields.push('has_worktree = ?')
      values.push(pathPatch.worktreePath ? 1 : 0)
    }
    if (pathPatch.baseDir !== undefined) {
      fields.push('has_base_dir = ?')
      values.push(pathPatch.baseDir ? 1 : 0)
    }
  }
  fields.push("updated_at = datetime('now')")
  values.push(data.id)

  // Field UPDATE + diff-derived activity events commit ATOMICALLY via the worker
  // `task:update` txn (same primitive restore/unarchive use). The "after" Task is
  // projected from the prior row + the exact values this UPDATE writes — no
  // read-after-write diff needed — so a failed activity-event insert rolls back
  // the field write too, keeping task mutations consistent with their audit log.
  // Mirrors the conditions/values of the field pushes above for the columns
  // buildTaskUpdatedEvents diffs (title/description/status/assignee/priority/due).
  const beforeRow = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [
    data.id
  ])
  const beforeTask = parseTask(beforeRow)
  const eventOverrides: Record<string, unknown> = {}
  if (data.title !== undefined) eventOverrides.title = data.title
  if (data.description !== undefined) {
    eventOverrides.description = data.description
    eventOverrides.description_format = 'markdown'
  }
  if (data.status !== undefined || normalizedStatusForWrite !== undefined)
    eventOverrides.status = normalizedStatusForWrite ?? data.status
  if (data.assignee !== undefined) eventOverrides.assignee = data.assignee
  if (data.priority !== undefined) eventOverrides.priority = data.priority
  if (data.dueDate !== undefined) eventOverrides.due_date = data.dueDate
  const afterTask = beforeRow ? parseTask({ ...beforeRow, ...eventOverrides }) : null
  const updateEvents = beforeTask && afterTask ? buildTaskUpdatedEvents(beforeTask, afterTask) : []

  await db.namedTxn('task:update', {
    sql: `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`,
    params: values,
    events: updateEvents
  })

  if (!userPaths && (pathPatch.worktreePath !== undefined || pathPatch.baseDir !== undefined))
    await notifyTaskPaths(data.id, { op: 'set', ...pathPatch })
  // A path the user set was written on its computer above (`apply`): clients re-read it.
  else if (userPaths) taskEvents.emit('task:paths-changed', { taskId: data.id })

  // A worktree / base-dir change: every tab's agent ran in the old folder,
  // so the WHOLE task resets — every tab, every mode (a reset intent the hub
  // delivers to the task's computers, robustness plan §9).
  if (resetsWholeTask) {
    try {
      await resetConversation(db, { taskId: data.id, scope: 'all-tabs' })
    } catch {
      /* best-effort: the task update is committed */
    }
  }
  for (const push of chatSettingsPushes) {
    const ordered = Object.fromEntries(
      CHAT_SETTING_KEYS.filter((key) => Object.hasOwn(push.settings, key)).map((key) => [
        key,
        push.settings[key]
      ])
    )
    try {
      await chatSettingsDelegate?.apply(data.id, push.mode, ordered)
    } catch (error) {
      // The task update is committed; the chat's computer is unreachable or
      // refused. The hub keeps no copy to retry from: report it.
      console.warn(`[task] chat settings of ${data.id} (${push.mode}) not applied:`, error)
    }
  }
  const effectiveStatus = normalizedStatusForWrite
  const reachedTerminal =
    effectiveStatus !== undefined && isTerminalStatus(effectiveStatus, targetColumns)
  // `previouslyTerminal` uses the PRE-write status.
  const previouslyTerminal = existing?.status
    ? isTerminalStatus(existing.status, targetColumns)
    : false
  const revived = effectiveStatus !== undefined && !reachedTerminal && previouslyTerminal
  if (reachedTerminal) {
    runtimeAdapters.onReachedTerminal(data.id)
  }
  // Clear snooze when task reaches terminal status
  if (reachedTerminal && !fields.some((f) => f.startsWith('snoozed_until'))) {
    await db.run(
      'UPDATE tasks SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL',
      [data.id]
    )
  }
  // Revive path: task moved from a terminal status (e.g. `done`) back to an active
  // one (e.g. `in_progress`). Signal the renderer to respawn the main AI tab so
  // the user can continue typing without manual Retry. See GitHub issue #77.
  if (revived) {
    runtimeAdapters.requestPtyRespawn(data.id)
  }

  const row = await db.get<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', [data.id])
  return parseTask(row)
}

export interface OpDeps {
  /** Optional: the in-process IPC bus used to fan out `db:tasks:*:done` events to
   *  app/main listeners. Absent when ops are called from a tRPC procedure (the task
   *  router injects ops with `{}` deps). Emit sites guard with `?.`. */
  ipcMain?: { emit(channel: string, ...args: unknown[]): boolean }
  /** Post-mutation refresh signal. An op passes a `TasksChange` only when it
   *  touched exactly those task rows and nothing else the board shows; without
   *  one the renderer reloads the whole board (see `TasksChange`). */
  onMutation?: (change?: TasksChange) => void
  /**
   * The warm pool's `reserveWarmTaskId` (terminal domain). Injected rather than
   * imported because terminal depends on task, never the reverse. Wired only where
   * the pool runs (the hub) for the renderer's create; absent everywhere else, which
   * simply means no task takes a warm agent's id.
   */
  reserveWarmTaskId?: (criteria: {
    projectId: string
    mode: string
    flags: string | null
  }) => Promise<string | null>
}

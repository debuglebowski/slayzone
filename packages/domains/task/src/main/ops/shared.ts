import { app } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ProviderConfig, Task, UpdateTaskInput } from '@slayzone/task/shared'
import { validateReparent, reparentErrorMessage, type ReparentTaskRow } from '@slayzone/task/shared'
import { recordConversation } from './task-conversations.js'
import type { ColumnConfig } from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  getStatusByCategory,
  isKnownStatus,
  isTerminalStatus,
  parseColumnsConfig
} from '@slayzone/projects/shared'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import path from 'path'
import { existsSync, rmSync } from 'fs'
import {
  removeWorktree,
  createWorktree,
  runWorktreeSetupScript,
  getCurrentBranch,
  isGitRepo,
  copyIgnoredFiles,
  resolveCopyBehavior,
  getWorktreeColor,
  ensureProjectWorktreeColors
} from '@slayzone/worktrees/server'
import {
  DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  resolveWorktreeBasePathTemplate
} from '@slayzone/worktrees/shared'

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

export interface TaskRuntimeAdapters {
  killPtysByTaskId: (taskId: string) => void
  killTaskProcesses: (taskId: string) => void
  recordDiagnosticEvent: (event: DiagnosticEventPayload) => void
  /** Broadcast a respawn request to the renderer when a task transitions from a
   *  terminal status back to a non-terminal one. Renderer decides whether to act. */
  requestPtyRespawn: (taskId: string) => void
  /** Single invariant: all side-effects of "task reached a terminal status".
   *  Wired by the app to terminal/main's onTaskReachedTerminal. Add new side
   *  effects there, not at call sites. */
  onReachedTerminal: (taskId: string) => void
}

const defaultRuntimeAdapters: TaskRuntimeAdapters = {
  killPtysByTaskId: () => {},
  killTaskProcesses: () => {},
  recordDiagnosticEvent: () => {},
  requestPtyRespawn: () => {},
  onReachedTerminal: () => {}
}

let runtimeAdapters: TaskRuntimeAdapters = defaultRuntimeAdapters

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
  return {
    ...row,
    dangerously_skip_permissions: Boolean(row.dangerously_skip_permissions),
    provider_config: providerConfig,
    // Backfill deprecated per-provider fields from provider_config
    claude_conversation_id: providerConfig['claude-code']?.conversationId ?? null,
    codex_conversation_id: providerConfig['codex']?.conversationId ?? null,
    cursor_conversation_id: providerConfig['cursor-agent']?.conversationId ?? null,
    gemini_conversation_id: providerConfig['gemini']?.conversationId ?? null,
    opencode_conversation_id: providerConfig['opencode']?.conversationId ?? null,
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

/** Attaches transient worktree_color field. Lazy-detects for cold projects (one IPC per
 *  unique project per process lifetime). Tasks without worktree_path are returned untouched. */
export async function attachWorktreeColors(db: SlayzoneDb, tasks: Task[]): Promise<Task[]> {
  const projectIds = new Set<string>()
  for (const t of tasks) {
    if (t.worktree_path && t.project_id) projectIds.add(t.project_id)
  }
  if (projectIds.size === 0) return tasks

  const ids = [...projectIds]
  const placeholders = ids.map(() => '?').join(',')
  const rows = (await db.all<{ id: string; path: string }>(
    `SELECT id, path FROM projects WHERE id IN (${placeholders})`,
    ids
  )) as { id: string; path: string }[]
  const projectPaths = new Map(rows.filter((r) => r.path).map((r) => [r.id, r.path]))

  await Promise.all([...projectPaths.values()].map((p) => ensureProjectWorktreeColors(p)))

  return tasks.map((t) => {
    if (!t.worktree_path) return t
    const ppath = projectPaths.get(t.project_id)
    if (!ppath) return t
    const color = getWorktreeColor(ppath, t.worktree_path)
    return color ? { ...t, worktree_color: color } : t
  })
}

/**
 * Populate `currentConversationByMode` from the append-only
 * `task_conversations` ledger. The renderer reads this field instead of
 * `provider_config.{mode}.conversationId` so manual-reset and provenance
 * gating are honored on every read. Single query per task per call (cheap;
 * indexed). Modes with no rows at all are simply absent from the record.
 */
async function attachCurrentConversationByMode(
  db: SlayzoneDb,
  tasks: Task[]
): Promise<Task[]> {
  if (tasks.length === 0) return tasks
  const placeholders = tasks.map(() => '?').join(',')
  const ids = tasks.map((t) => t.id)
  // ROW_NUMBER window: deterministically picks the latest honored row per
  // (task_id, mode) strictly after any manual-reset cutoff. SQLite's `GROUP BY
  // + HAVING max(created_at)` does NOT guarantee which row's column values are
  // returned for the group — the window form is correct by spec.
  const rows = await db.all<{
    task_id: string
    mode: string
    conversation_id: string | null
  }>(
    `WITH reset AS (
       SELECT task_id, mode, max(created_at) AS at
       FROM task_conversations
       WHERE task_id IN (${placeholders}) AND origin = 'manual-reset'
       GROUP BY task_id, mode
     ),
     ranked AS (
       SELECT
         tc.task_id,
         tc.mode,
         tc.conversation_id,
         ROW_NUMBER() OVER (
           PARTITION BY tc.task_id, tc.mode
           ORDER BY tc.created_at DESC
         ) AS rn
       FROM task_conversations tc
       LEFT JOIN reset r ON r.task_id = tc.task_id AND r.mode = tc.mode
       WHERE tc.task_id IN (${placeholders})
         AND tc.origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
         AND tc.created_at > coalesce(r.at, 0)
     )
     SELECT task_id, mode, conversation_id FROM ranked WHERE rn = 1`,
    [...ids, ...ids]
  )
  const byTask = new Map<string, Record<string, string | null>>()
  for (const r of rows) {
    let entry = byTask.get(r.task_id)
    if (!entry) {
      entry = {}
      byTask.set(r.task_id, entry)
    }
    entry[r.mode] = r.conversation_id
  }
  return tasks.map((t) => ({
    ...t,
    currentConversationByMode: byTask.get(t.id) ?? {}
  }))
}

export async function parseAndColorTasks(
  db: SlayzoneDb,
  rows: Record<string, unknown>[]
): Promise<Task[]> {
  const colored = await attachWorktreeColors(db, parseTasks(rows))
  return attachCurrentConversationByMode(db, colored)
}

export async function parseAndColorTask(
  db: SlayzoneDb,
  row: Record<string, unknown> | undefined
): Promise<Task | null> {
  const task = parseTask(row)
  if (!task) return null
  const [colored] = await attachWorktreeColors(db, [task])
  const [withConv] = await attachCurrentConversationByMode(db, [colored])
  return withConv
}

export async function colorOne<T extends Task | null | undefined>(
  db: SlayzoneDb,
  task: T
): Promise<T> {
  if (!task) return task
  const [colored] = await attachWorktreeColors(db, [task])
  return colored as T
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

export type TerminalModeFlagsRow = { id: string; default_flags: string | null }

export async function getEnabledModeDefaults(db: SlayzoneDb): Promise<TerminalModeFlagsRow[]> {
  let rows: TerminalModeFlagsRow[] = []
  try {
    rows = await db.all<TerminalModeFlagsRow>(
      'SELECT id, default_flags FROM terminal_modes WHERE enabled = 1'
    )
  } catch {
    rows = []
  }

  if (rows.length > 0) return rows

  return DEFAULT_TERMINAL_MODES.filter((mode) => mode.enabled).map((mode) => ({
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
      'SELECT default_flags FROM terminal_modes WHERE id = ?',
      [modeId]
    )
    if (row) return row.default_flags ?? ''
  } catch {
    // Fall back to built-in defaults when terminal_modes is unavailable or unseeded.
  }

  const fallback = DEFAULT_TERMINAL_MODES.find((mode) => mode.id === modeId)
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
  batchIds: string[] = [taskId]
): Promise<void> {
  cleanupTaskImmediate(taskId)
  runtimeAdapters.killTaskProcesses(taskId)
  // Clean up artifact files on disk
  const artifactsBaseDir = path.join(
    process.env.SLAYZONE_DB_DIR || app.getPath('userData'),
    'artifacts',
    taskId
  )
  if (existsSync(artifactsBaseDir)) rmSync(artifactsBaseDir, { recursive: true, force: true })

  const task = await db.get<{ worktree_path: string | null; project_id: string }>(
    'SELECT worktree_path, project_id FROM tasks WHERE id = ?',
    [taskId]
  )

  if (!task?.worktree_path) return

  // Skip removal if any other live task (outside this batch) still references the same worktree.
  // Subtasks inherit parent's worktree_path; first batch member to run cleanup actually removes,
  // siblings short-circuit on `existsSync(worktreePath)` inside removeWorktree.
  const ids = batchIds.length > 0 ? batchIds : [taskId]
  const placeholders = ids.map(() => '?').join(',')
  const sharedRow = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE worktree_path = ? AND id NOT IN (${placeholders}) AND archived_at IS NULL AND deleted_at IS NULL`,
    [task.worktree_path, ...ids]
  )
  if ((sharedRow?.n ?? 0) > 0) return

  const project = await db.get<{ path: string }>('SELECT path FROM projects WHERE id = ?', [
    task.project_id
  ])

  if (project?.path) {
    try {
      await removeWorktree(project.path, task.worktree_path)
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
    }
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

async function isAutoCreateWorktreeEnabled(db: SlayzoneDb, projectId: string): Promise<boolean> {
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

  const projectRow = await db.get<{
    path: string | null
    worktree_source_branch: string | null
  }>('SELECT path, worktree_source_branch FROM projects WHERE id = ?', [projectId])
  if (!projectRow?.path) {
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

  // Resolve effective repo path (child repo if multi-repo, otherwise project.path)
  let repoPath = projectRow.path
  if (repoName) {
    const childPath = path.join(projectRow.path, repoName)
    if (await isGitRepo(childPath)) {
      repoPath = childPath
    }
  }

  if (!(await isGitRepo(repoPath))) {
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
      ?.value || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE
  const basePath = resolveWorktreeBasePathTemplate(baseTemplate, repoPath)
  const branch = slugify(taskTitle) || `task-${taskId.slice(0, 8)}`
  const worktreePath = path.join(basePath, branch)
  const parentBranch = await getCurrentBranch(repoPath)

  const sourceBranch = projectRow.worktree_source_branch ?? undefined

  // Block A: Create worktree and link to task immediately
  try {
    await createWorktree(repoPath, worktreePath, branch, sourceBranch)
  } catch (err) {
    // Git may exit non-zero after creating the worktree (e.g. post-checkout hook failure).
    // If the dir exists, still link it — better than orphaning a worktree the user can see.
    if (existsSync(worktreePath)) {
      await db.run(
        `
        UPDATE tasks
        SET worktree_path = ?, worktree_parent_branch = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
        [worktreePath, parentBranch, taskId]
      )
      runtimeAdapters.recordDiagnosticEvent({
        level: 'warn',
        source: 'task',
        event: 'task.auto_worktree_recovered',
        taskId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
        payload: { projectPath: projectRow.path, worktreePath, branch, parentBranch, sourceBranch }
      })
    } else {
      runtimeAdapters.recordDiagnosticEvent({
        level: 'error',
        source: 'task',
        event: 'task.auto_worktree_create_failed',
        taskId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
        payload: { projectPath: projectRow.path, baseTemplate, basePath, branch, worktreePath }
      })
    }
    return
  }

  // Worktree created — link to task before any post-creation steps
  await db.run(
    `
    UPDATE tasks
    SET worktree_path = ?, worktree_parent_branch = ?, updated_at = datetime('now')
    WHERE id = ?
  `,
    [worktreePath, parentBranch, taskId]
  )
  runtimeAdapters.recordDiagnosticEvent({
    level: 'info',
    source: 'task',
    event: 'task.auto_worktree_created',
    taskId,
    projectId,
    payload: { projectPath: projectRow.path, worktreePath, branch, parentBranch, sourceBranch }
  })

  // Block B: Post-creation extras (non-critical, won't affect linkage)
  try {
    const { behavior: copyBehavior, customPaths } = await resolveCopyBehavior(db, projectId)
    if (copyBehavior === 'all' || copyBehavior === 'custom') {
      await copyIgnoredFiles(repoPath, worktreePath, copyBehavior, customPaths)
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

  // Fire-and-forget: don't block task creation on setup script
  void runWorktreeSetupScript(worktreePath, repoPath, sourceBranch)
}

export async function updateTask(db: SlayzoneDb, data: UpdateTaskInput): Promise<Task | null> {
  const existing = await db.get<{ project_id: string; status: string; is_temporary: number }>(
    'SELECT project_id, status, is_temporary FROM tasks WHERE id = ?',
    [data.id]
  )
  const targetProjectId = data.projectId ?? existing?.project_id
  const targetColumns = targetProjectId ? await getProjectColumns(db, targetProjectId) : null
  const projectChanged = data.projectId !== undefined && existing?.project_id !== data.projectId

  // Auto-promote a temporary task when its title is renamed. Mirrors "Turn into task" behavior:
  // clears is_temporary and moves status into the `started` category. Caller can opt out by
  // passing isTemporary explicitly.
  const shouldPromoteFromTemp =
    data.title !== undefined && existing?.is_temporary === 1 && data.isTemporary === undefined

  let normalizedStatusForWrite: string | undefined
  if (data.status !== undefined) {
    normalizedStatusForWrite = isKnownStatus(data.status, targetColumns)
      ? data.status
      : getDefaultStatus(targetColumns)
  } else if (shouldPromoteFromTemp) {
    normalizedStatusForWrite =
      getStatusByCategory('started', targetColumns) ?? getDefaultStatus(targetColumns)
  } else if (projectChanged && existing?.status && !isKnownStatus(existing.status, targetColumns)) {
    normalizedStatusForWrite = getDefaultStatus(targetColumns)
  }

  const fields: string[] = []
  const values: unknown[] = []
  /**
   * Conversation-id mutations the merge produced. Recorded into the
   * append-only `task_conversations` ledger after the UPDATE commits so the
   * renderer's `currentConversationByMode` view (computed from the ledger)
   * tracks every legacy-field write. Origin tag:
   *   - newId === null  → `manual-reset` (clear)
   *   - newId !== null  → `slay-spawned-fresh` (the agent in slay's PTY
   *     reports/asserts this is its session)
   */
  const convIdChanges: Array<{ mode: string; newId: string | null }> = []

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
  if (data.projectId !== undefined) {
    fields.push('project_id = ?')
    values.push(data.projectId)
    if (projectChanged) {
      // Clear repo/worktree/base_dir fields — child repos and worktrees may differ across projects
      if (data.repoName === undefined) {
        fields.push('repo_name = ?')
        values.push(null)
      }
      if (data.worktreePath === undefined) {
        fields.push('worktree_path = ?')
        values.push(null)
      }
      if (data.worktreeParentBranch === undefined) {
        fields.push('worktree_parent_branch = ?')
        values.push(null)
      }
      if (data.baseDir === undefined) {
        fields.push('base_dir = ?')
        values.push(null)
      }
    }
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
  if (data.terminalMode !== undefined) {
    fields.push('terminal_mode = ?')
    values.push(data.terminalMode)
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
      convId?: string | null
      flags?: string
      hasConvId: boolean
      hasFlags: boolean
    }> = [
      {
        mode: 'claude-code',
        col: 'claude',
        convId: data.claudeConversationId,
        flags: data.claudeFlags,
        hasConvId: data.claudeConversationId !== undefined,
        hasFlags: data.claudeFlags !== undefined
      },
      {
        mode: 'codex',
        col: 'codex',
        convId: data.codexConversationId,
        flags: data.codexFlags,
        hasConvId: data.codexConversationId !== undefined,
        hasFlags: data.codexFlags !== undefined
      },
      {
        mode: 'cursor-agent',
        col: 'cursor',
        convId: data.cursorConversationId,
        flags: data.cursorFlags,
        hasConvId: data.cursorConversationId !== undefined,
        hasFlags: data.cursorFlags !== undefined
      },
      {
        mode: 'gemini',
        col: 'gemini',
        convId: data.geminiConversationId,
        flags: data.geminiFlags,
        hasConvId: data.geminiConversationId !== undefined,
        hasFlags: data.geminiFlags !== undefined
      },
      {
        mode: 'opencode',
        col: 'opencode',
        convId: data.opencodeConversationId,
        flags: data.opencodeFlags,
        hasConvId: data.opencodeConversationId !== undefined,
        hasFlags: data.opencodeFlags !== undefined
      }
    ]
    const hasLegacyUpdate = legacyMappings.some((m) => m.hasConvId || m.hasFlags)
    const shouldResetConversationIds =
      (data.worktreePath !== undefined || data.baseDir !== undefined || projectChanged) &&
      data.providerConfig === undefined &&
      !hasLegacyUpdate

    if (
      data.providerConfig !== undefined ||
      hasLegacyUpdate ||
      data.terminalMode !== undefined ||
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

      // Clear stale conversation IDs when worktree changes
      if (shouldResetConversationIds) {
        for (const mode of Object.keys(merged)) {
          merged[mode] = { ...merged[mode], conversationId: null }
        }
      }

      if (data.providerConfig !== undefined) {
        for (const [mode, entry] of Object.entries(data.providerConfig)) {
          merged[mode] = { ...current[mode], ...entry }
        }
      }

      // Apply legacy field updates on top
      for (const m of legacyMappings) {
        if (m.hasConvId || m.hasFlags) {
          merged[m.mode] = { ...merged[m.mode] }
          if (m.hasConvId) merged[m.mode].conversationId = m.convId
          if (m.hasFlags) merged[m.mode].flags = m.flags
        }
      }

      // Seed default flags when switching terminal mode
      if (data.terminalMode !== undefined) {
        const defaultFlags = await getModeDefaultFlags(db, data.terminalMode)
        if (defaultFlags !== undefined) {
          merged[data.terminalMode] = { ...merged[data.terminalMode], flags: defaultFlags }
        }
      }

      // Track every conversation-id change so we can append a row to the
      // append-only `task_conversations` ledger AFTER the legacy UPDATE
      // commits. This is the funnel that makes any updateTask write — Detect
      // banner, Reset Terminal, slay-internal — flow through the ledger,
      // matching what hook-driven + chat-mode paths already do. Without this
      // funnel the renderer's `currentConversationByMode` (computed from the
      // ledger) goes stale after Detect/Reset writes, surfacing as the
      // session-id banner re-appearing post-Update.
      const modesToCompare = new Set<string>([
        ...Object.keys(current),
        ...Object.keys(merged)
      ])
      for (const m of modesToCompare) {
        const oldId = current[m]?.conversationId ?? null
        const newId = merged[m]?.conversationId ?? null
        if (oldId === newId) continue
        convIdChanges.push({ mode: m, newId })
      }

      fields.push('provider_config = ?')
      values.push(JSON.stringify(merged))

      // Dual-write to legacy columns
      for (const m of legacyMappings) {
        const entry = merged[m.mode]
        if (!entry) continue
        if (m.hasConvId || data.providerConfig !== undefined || shouldResetConversationIds) {
          fields.push(`${m.col}_conversation_id = ?`)
          values.push(entry.conversationId ?? null)
        }
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
  // Note: these also get cleared to null on project change (see projectChanged block above)
  if (data.worktreePath !== undefined) {
    fields.push('worktree_path = ?')
    values.push(data.worktreePath)
  }
  if (data.worktreeParentBranch !== undefined) {
    fields.push('worktree_parent_branch = ?')
    values.push(data.worktreeParentBranch)
  }
  if (data.baseDir !== undefined) {
    fields.push('base_dir = ?')
    values.push(data.baseDir)
  }
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

  fields.push("updated_at = datetime('now')")
  values.push(data.id)

  await db.run(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, values)

  // Funnel: every conversation-id mutation from updateTask flows into the
  // append-only ledger so the renderer's currentConversationByMode reflects
  // every write. recordConversation itself dual-writes to the legacy field
  // for HONORED origins — the legacy UPDATE just ran with the same target
  // value, so the re-write is idempotent (matching value). For manual-reset,
  // recordConversation also clears the legacy field — also idempotent vs
  // the UPDATE we just ran. Best-effort: a ledger write failure must not
  // fail the parent updateTask (e.g. callers that update unrelated fields).
  //
  // CAUTION — provenance boundary: this funnel records every conv-id change
  // here as HONORED (`slay-spawned-fresh` for non-null, `manual-reset` for
  // null). Today's callers are trusted by convention:
  //   - renderer Detect → parses /status from slay's own PTY (the agent's
  //     real sessionId)
  //   - renderer Reset Terminal → writes null
  //   - server-internal terminal-mode / worktree paths → don't carry foreign
  //     conv-ids
  // If you add an `updateTask` caller that takes a user-controlled or
  // network-supplied conversation id and threads it through `providerConfig`,
  // DO NOT route it through here. Add a dedicated IPC with provenance
  // verification (e.g. matching against /status output of a live slay PTY),
  // or introduce a new non-honored origin (e.g. `external-update`). Otherwise
  // you reintroduce an UPDATE-based eager-persist clobber.
  for (const change of convIdChanges) {
    try {
      await recordConversation(db, {
        taskId: data.id,
        mode: change.mode,
        conversationId: change.newId,
        origin: change.newId === null ? 'manual-reset' : 'slay-spawned-fresh'
      })
    } catch {
      /* ledger write is best-effort; legacy write already committed */
    }
  }

  const effectiveStatus = normalizedStatusForWrite
  const reachedTerminal =
    effectiveStatus !== undefined && isTerminalStatus(effectiveStatus, targetColumns)
  // `previouslyTerminal` uses the PRE-write status. Compute before project-change
  // logic may invalidate the old status's known-ness. Use same column config (pre-change)
  // only when project didn't change; otherwise semantics are ambiguous and we skip respawn.
  const previouslyTerminal =
    !projectChanged && existing?.status ? isTerminalStatus(existing.status, targetColumns) : false
  const revived = effectiveStatus !== undefined && !reachedTerminal && previouslyTerminal
  if (reachedTerminal) {
    runtimeAdapters.onReachedTerminal(data.id)
  } else if (projectChanged) {
    // Project change rehomes the task — kill its PTYs but no other "terminal" semantics.
    runtimeAdapters.killPtysByTaskId(data.id)
  }
  // Clear snooze when task reaches terminal status
  if (reachedTerminal && !fields.some((f) => f.startsWith('snoozed_until'))) {
    await db.run('UPDATE tasks SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL', [
      data.id
    ])
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
  ipcMain?: import('electron').IpcMain
  onMutation?: () => void
}

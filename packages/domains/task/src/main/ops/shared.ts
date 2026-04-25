import { app } from 'electron'
import type { Database } from 'better-sqlite3'
import type { ProviderConfig, Task, UpdateTaskInput } from '@slayzone/task/shared'
import { validateReparent, reparentErrorMessage, type ReparentTaskRow } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getDefaultStatus, isKnownStatus, isTerminalStatus, parseColumnsConfig } from '@slayzone/projects/shared'
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
  ensureProjectWorktreeColors,
} from '@slayzone/worktrees/main'

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
  try { return JSON.parse(value) } catch { return null }
}

// Parse JSON columns from DB row
export function parseTask(row: Record<string, unknown> | undefined): Task | null {
  if (!row) return null
  const providerConfig: ProviderConfig = (safeJsonParse(row.provider_config) as ProviderConfig) ?? {}
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
    browser_tabs: safeJsonParse(row.browser_tabs),
    web_panel_urls: safeJsonParse(row.web_panel_urls),
    editor_open_files: safeJsonParse(row.editor_open_files),
    diff_collapsed_files: safeJsonParse(row.diff_collapsed_files),
    git_active_tab: (row.git_active_tab as Task['git_active_tab']) ?? null,
    merge_context: safeJsonParse(row.merge_context),
    loop_config: safeJsonParse(row.loop_config),
    is_temporary: Boolean(row.is_temporary),
    is_blocked: Boolean(row.is_blocked),
    active_asset_id: (row.active_asset_id as string) ?? null,
    manager_mode: Boolean(row.manager_mode)
  } as Task
}

export function parseTasks(rows: Record<string, unknown>[]): Task[] {
  return rows.map((row) => parseTask(row)!)
}

/** Attaches transient worktree_color field. Lazy-detects for cold projects (one IPC per
 *  unique project per process lifetime). Tasks without worktree_path are returned untouched. */
export async function attachWorktreeColors(db: Database, tasks: Task[]): Promise<Task[]> {
  const projectIds = new Set<string>()
  for (const t of tasks) {
    if (t.worktree_path && t.project_id) projectIds.add(t.project_id)
  }
  if (projectIds.size === 0) return tasks

  const ids = [...projectIds]
  const placeholders = ids.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT id, path FROM projects WHERE id IN (${placeholders})`)
    .all(...ids) as { id: string; path: string }[]
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

export async function parseAndColorTasks(db: Database, rows: Record<string, unknown>[]): Promise<Task[]> {
  return attachWorktreeColors(db, parseTasks(rows))
}

export async function parseAndColorTask(db: Database, row: Record<string, unknown> | undefined): Promise<Task | null> {
  const task = parseTask(row)
  if (!task) return null
  const [colored] = await attachWorktreeColors(db, [task])
  return colored
}

export async function colorOne<T extends Task | null | undefined>(db: Database, task: T): Promise<T> {
  if (!task) return task
  const [colored] = await attachWorktreeColors(db, [task])
  return colored as T
}

export function getProjectColumns(db: Database, projectId: string): ColumnConfig[] | null {
  const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
    | { columns_config: string | null }
    | undefined
  return parseColumnsConfig(row?.columns_config)
}

export type TerminalModeFlagsRow = { id: string; default_flags: string | null }

export function getEnabledModeDefaults(db: Database): TerminalModeFlagsRow[] {
  let rows: TerminalModeFlagsRow[] = []
  try {
    rows = db.prepare('SELECT id, default_flags FROM terminal_modes WHERE enabled = 1').all() as TerminalModeFlagsRow[]
  } catch {
    rows = []
  }

  if (rows.length > 0) return rows

  return DEFAULT_TERMINAL_MODES
    .filter((mode) => mode.enabled)
    .map((mode) => ({ id: mode.id, default_flags: mode.defaultFlags ?? '' }))
}

export function getModeDefaultFlags(db: Database, modeId: string): string | undefined {
  try {
    const row = db.prepare('SELECT default_flags FROM terminal_modes WHERE id = ?')
      .get(modeId) as { default_flags: string | null } | undefined
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

/** Kill PTY + processes + remove worktree + asset files — used for archive and hard purge */
export async function cleanupTaskFull(db: Database, taskId: string): Promise<void> {
  cleanupTaskImmediate(taskId)
  runtimeAdapters.killTaskProcesses(taskId)
  // Clean up asset files on disk
  const assetsBaseDir = path.join(process.env.SLAYZONE_DB_DIR || app.getPath('userData'), 'assets', taskId)
  if (existsSync(assetsBaseDir)) rmSync(assetsBaseDir, { recursive: true, force: true })

  const task = db.prepare(
    'SELECT worktree_path, project_id FROM tasks WHERE id = ?'
  ).get(taskId) as { worktree_path: string | null; project_id: string } | undefined

  if (!task?.worktree_path) return

  const project = db.prepare(
    'SELECT path FROM projects WHERE id = ?'
  ).get(task.project_id) as { path: string } | undefined

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

const DEFAULT_WORKTREE_BASE_PATH_TEMPLATE = '{project}/..'

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

function resolveWorktreeBasePathTemplate(template: string, projectPath: string): string {
  const expanded = template.replaceAll('{project}', projectPath.replace(/[\\/]+$/, ''))
  return path.normalize(expanded)
}

function isAutoCreateWorktreeEnabled(db: Database, projectId: string): boolean {
  const projectRow = db.prepare(
    'SELECT auto_create_worktree_on_task_create FROM projects WHERE id = ?'
  ).get(projectId) as { auto_create_worktree_on_task_create: number | null } | undefined

  if (projectRow?.auto_create_worktree_on_task_create === 1) return true
  if (projectRow?.auto_create_worktree_on_task_create === 0) return false

  const globalRow = db.prepare(
    "SELECT value FROM settings WHERE key = 'auto_create_worktree_on_task_create'"
  ).get() as { value: string } | undefined
  return parseBooleanSetting(globalRow?.value)
}

export async function maybeAutoCreateWorktree(
  db: Database,
  taskId: string,
  projectId: string,
  taskTitle: string,
  repoName?: string | null
): Promise<void> {
  if (!isAutoCreateWorktreeEnabled(db, projectId)) return

  const projectRow = db.prepare('SELECT path, worktree_source_branch FROM projects WHERE id = ?').get(projectId) as
    | { path: string | null; worktree_source_branch: string | null }
    | undefined
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
    (db.prepare("SELECT value FROM settings WHERE key = 'worktree_base_path'")
      .get() as { value: string } | undefined)?.value || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE
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
      db.prepare(`
        UPDATE tasks
        SET worktree_path = ?, worktree_parent_branch = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(worktreePath, parentBranch, taskId)
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
  db.prepare(`
    UPDATE tasks
    SET worktree_path = ?, worktree_parent_branch = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(worktreePath, parentBranch, taskId)
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
    const { behavior: copyBehavior, customPaths } = resolveCopyBehavior(db, projectId)
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

export function updateTask(db: Database, data: UpdateTaskInput): Task | null {
  const existing = db.prepare('SELECT project_id, status FROM tasks WHERE id = ?').get(data.id) as
    | { project_id: string; status: string }
    | undefined
  const targetProjectId = data.projectId ?? existing?.project_id
  const targetColumns = targetProjectId ? getProjectColumns(db, targetProjectId) : null
  const projectChanged = data.projectId !== undefined && existing?.project_id !== data.projectId
  let normalizedStatusForWrite: string | undefined
  if (data.status !== undefined) {
    normalizedStatusForWrite = isKnownStatus(data.status, targetColumns)
      ? data.status
      : getDefaultStatus(targetColumns)
  } else if (projectChanged && existing?.status && !isKnownStatus(existing.status, targetColumns)) {
    normalizedStatusForWrite = getDefaultStatus(targetColumns)
  }

  const fields: string[] = []
  const values: unknown[] = []

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title) }
  if (data.description !== undefined) { fields.push('description = ?', "description_format = 'markdown'"); values.push(data.description) }
  if (data.status !== undefined || normalizedStatusForWrite !== undefined) {
    fields.push('status = ?')
    values.push(normalizedStatusForWrite ?? data.status)
  }
  if (data.assignee !== undefined) { fields.push('assignee = ?'); values.push(data.assignee) }
  if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority) }
  if (data.progress !== undefined) {
    fields.push('progress = ?')
    values.push(Math.max(0, Math.min(100, Math.round(data.progress))))
  }
  if (data.managerMode !== undefined) {
    fields.push('manager_mode = ?')
    values.push(data.managerMode ? 1 : 0)
  }
  if (data.dueDate !== undefined) { fields.push('due_date = ?'); values.push(data.dueDate) }
  if (data.projectId !== undefined) {
    fields.push('project_id = ?'); values.push(data.projectId)
    if (projectChanged) {
      // Clear repo/worktree/base_dir fields — child repos and worktrees may differ across projects
      if (data.repoName === undefined) { fields.push('repo_name = ?'); values.push(null) }
      if (data.worktreePath === undefined) { fields.push('worktree_path = ?'); values.push(null) }
      if (data.worktreeParentBranch === undefined) { fields.push('worktree_parent_branch = ?'); values.push(null) }
      if (data.baseDir === undefined) { fields.push('base_dir = ?'); values.push(null) }
    }
  }
  if (data.parentId !== undefined) {
    const lookupStmt = db.prepare('SELECT id, project_id, parent_id, archived_at, deleted_at FROM tasks WHERE id = ?')
    const result = validateReparent({
      taskId: data.id,
      parentId: data.parentId,
      targetProjectId,
      lookup: (id) => (lookupStmt.get(id) as ReparentTaskRow | undefined) ?? null,
    })
    if (!result.ok) {
      throw new Error(reparentErrorMessage(result.error, { taskId: data.id, parentId: data.parentId }))
    }
    fields.push('parent_id = ?'); values.push(data.parentId)
  }
  if (data.terminalMode !== undefined) { fields.push('terminal_mode = ?'); values.push(data.terminalMode) }
  if (data.terminalShell !== undefined) { fields.push('terminal_shell = ?'); values.push(data.terminalShell) }

  // --- Provider config: merge providerConfig + legacy per-field updates ---
  {
    const legacyMappings: Array<{ mode: string; col: string; convId?: string | null; flags?: string; hasConvId: boolean; hasFlags: boolean }> = [
      { mode: 'claude-code', col: 'claude', convId: data.claudeConversationId, flags: data.claudeFlags, hasConvId: data.claudeConversationId !== undefined, hasFlags: data.claudeFlags !== undefined },
      { mode: 'codex', col: 'codex', convId: data.codexConversationId, flags: data.codexFlags, hasConvId: data.codexConversationId !== undefined, hasFlags: data.codexFlags !== undefined },
      { mode: 'cursor-agent', col: 'cursor', convId: data.cursorConversationId, flags: data.cursorFlags, hasConvId: data.cursorConversationId !== undefined, hasFlags: data.cursorFlags !== undefined },
      { mode: 'gemini', col: 'gemini', convId: data.geminiConversationId, flags: data.geminiFlags, hasConvId: data.geminiConversationId !== undefined, hasFlags: data.geminiFlags !== undefined },
      { mode: 'opencode', col: 'opencode', convId: data.opencodeConversationId, flags: data.opencodeFlags, hasConvId: data.opencodeConversationId !== undefined, hasFlags: data.opencodeFlags !== undefined },
    ]
    const hasLegacyUpdate = legacyMappings.some(m => m.hasConvId || m.hasFlags)
    const shouldResetConversationIds = (data.worktreePath !== undefined || data.baseDir !== undefined || projectChanged) && data.providerConfig === undefined && !hasLegacyUpdate

    if (data.providerConfig !== undefined || hasLegacyUpdate || data.terminalMode !== undefined || shouldResetConversationIds) {
      // Read current provider_config
      const currentRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(data.id) as { provider_config: string } | undefined
      const current: ProviderConfig = (safeJsonParse(currentRow?.provider_config) as ProviderConfig) ?? {}
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
        const defaultFlags = getModeDefaultFlags(db, data.terminalMode)
        if (defaultFlags !== undefined) {
          merged[data.terminalMode] = { ...merged[data.terminalMode], flags: defaultFlags }
        }
      }

      fields.push('provider_config = ?'); values.push(JSON.stringify(merged))

      // Dual-write to legacy columns
      for (const m of legacyMappings) {
        const entry = merged[m.mode]
        if (!entry) continue
        if (m.hasConvId || data.providerConfig !== undefined || shouldResetConversationIds) {
          fields.push(`${m.col}_conversation_id = ?`); values.push(entry.conversationId ?? null)
        }
        if (m.hasFlags || data.providerConfig !== undefined) {
          fields.push(`${m.col}_flags = ?`); values.push(entry.flags ?? '')
        }
      }
    }
  }
  if (data.panelVisibility !== undefined) { fields.push('panel_visibility = ?'); values.push(data.panelVisibility ? JSON.stringify(data.panelVisibility) : null) }
  // Note: these also get cleared to null on project change (see projectChanged block above)
  if (data.worktreePath !== undefined) { fields.push('worktree_path = ?'); values.push(data.worktreePath) }
  if (data.worktreeParentBranch !== undefined) { fields.push('worktree_parent_branch = ?'); values.push(data.worktreeParentBranch) }
  if (data.baseDir !== undefined) { fields.push('base_dir = ?'); values.push(data.baseDir) }
  if (data.browserUrl !== undefined) { fields.push('browser_url = ?'); values.push(data.browserUrl) }
  if (data.prUrl !== undefined) { fields.push('pr_url = ?'); values.push(data.prUrl) }
  if (data.browserTabs !== undefined) { fields.push('browser_tabs = ?'); values.push(data.browserTabs ? JSON.stringify(data.browserTabs) : null) }
  if (data.webPanelUrls !== undefined) { fields.push('web_panel_urls = ?'); values.push(data.webPanelUrls ? JSON.stringify(data.webPanelUrls) : null) }
  if (data.editorOpenFiles !== undefined) { fields.push('editor_open_files = ?'); values.push(data.editorOpenFiles ? JSON.stringify(data.editorOpenFiles) : null) }
  if (data.diffCollapsedFiles !== undefined) { fields.push('diff_collapsed_files = ?'); values.push(data.diffCollapsedFiles && data.diffCollapsedFiles.length ? JSON.stringify(data.diffCollapsedFiles) : null) }
  if (data.gitActiveTab !== undefined) { fields.push('git_active_tab = ?'); values.push(data.gitActiveTab) }
  if (data.mergeState !== undefined) { fields.push('merge_state = ?'); values.push(data.mergeState) }
  if (data.mergeContext !== undefined) { fields.push('merge_context = ?'); values.push(data.mergeContext ? JSON.stringify(data.mergeContext) : null) }
  if (data.loopConfig !== undefined) { fields.push('loop_config = ?'); values.push(data.loopConfig ? JSON.stringify(data.loopConfig) : null) }
  if (data.snoozedUntil !== undefined) { fields.push('snoozed_until = ?'); values.push(data.snoozedUntil) }
  if (data.isTemporary !== undefined) { fields.push('is_temporary = ?'); values.push(data.isTemporary ? 1 : 0) }
  if (data.isBlocked !== undefined) { fields.push('is_blocked = ?'); values.push(data.isBlocked ? 1 : 0) }
  if (data.blockedComment !== undefined) { fields.push('blocked_comment = ?'); values.push(data.blockedComment) }
  if (data.repoName !== undefined) { fields.push('repo_name = ?'); values.push(data.repoName) }
  if (data.activeAssetId !== undefined) { fields.push('active_asset_id = ?'); values.push(data.activeAssetId) }

  if (fields.length === 0) {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseTask(row)
  }

  fields.push("updated_at = datetime('now')")
  values.push(data.id)

  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  const effectiveStatus = normalizedStatusForWrite
  const reachedTerminal = effectiveStatus !== undefined && isTerminalStatus(effectiveStatus, targetColumns)
  // `previouslyTerminal` uses the PRE-write status. Compute before project-change
  // logic may invalidate the old status's known-ness. Use same column config (pre-change)
  // only when project didn't change; otherwise semantics are ambiguous and we skip respawn.
  const previouslyTerminal = !projectChanged && existing?.status
    ? isTerminalStatus(existing.status, targetColumns)
    : false
  const revived = effectiveStatus !== undefined && !reachedTerminal && previouslyTerminal
  if (reachedTerminal) {
    runtimeAdapters.onReachedTerminal(data.id)
  } else if (projectChanged) {
    // Project change rehomes the task — kill its PTYs but no other "terminal" semantics.
    runtimeAdapters.killPtysByTaskId(data.id)
  }
  // Clear snooze when task reaches terminal status
  if (reachedTerminal && !fields.some((f) => f.startsWith('snoozed_until'))) {
    db.prepare('UPDATE tasks SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL').run(data.id)
  }
  // Revive path: task moved from a terminal status (e.g. `done`) back to an active
  // one (e.g. `in_progress`). Signal the renderer to respawn the main AI tab so
  // the user can continue typing without manual Retry. See GitHub issue #77.
  if (revived) {
    runtimeAdapters.requestPtyRespawn(data.id)
  }

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
  return parseTask(row)
}

export interface OpDeps {
  ipcMain: import('electron').IpcMain
  onMutation?: () => void
}

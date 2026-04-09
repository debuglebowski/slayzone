import type { IpcMain } from 'electron'
import { app, dialog, BrowserWindow, shell } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateTaskInput, UpdateTaskInput, Task, ProviderConfig, CreateAssetInput, UpdateAssetInput, TaskAsset, RenderMode, AssetFolder, CreateAssetFolderInput, UpdateAssetFolderInput } from '@slayzone/task/shared'
import { getExtensionFromTitle, getEffectiveRenderMode, canExportAsPdf } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getDefaultStatus, isKnownStatus, isTerminalStatus, parseColumnsConfig } from '@slayzone/projects/shared'
import { parseProject } from '@slayzone/projects/main'
import { DEFAULT_TERMINAL_MODES } from '@slayzone/terminal/shared'
import { getTemplateForTask } from './template-handlers'
import { recordActivityEvents } from '@slayzone/history/main'
import {
  buildTaskArchivedEvents,
  buildTaskCreatedEvents,
  buildTaskDeletedEvents,
  buildTaskRestoredEvents,
  buildTaskUnarchivedEvents,
  buildTaskUpdatedEvents,
} from './history'
import path from 'path'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync, copyFileSync, statSync, readdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { removeWorktree, createWorktree, runWorktreeSetupScript, getCurrentBranch, isGitRepo, copyIgnoredFiles, resolveCopyBehavior } from '@slayzone/worktrees/main'
import { marked } from 'marked'
import { tmpdir } from 'os'

type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

interface DiagnosticEventPayload {
  level: DiagnosticLevel
  source: 'task'
  event: string
  message?: string
  taskId?: string
  projectId?: string
  payload?: Record<string, unknown>
}

interface TaskRuntimeAdapters {
  killPtysByTaskId: (taskId: string) => void
  killTaskProcesses: (taskId: string) => void
  recordDiagnosticEvent: (event: DiagnosticEventPayload) => void
}

const defaultRuntimeAdapters: TaskRuntimeAdapters = {
  killPtysByTaskId: () => {},
  killTaskProcesses: () => {},
  recordDiagnosticEvent: () => {}
}

let runtimeAdapters: TaskRuntimeAdapters = defaultRuntimeAdapters

export function configureTaskRuntimeAdapters(adapters: Partial<TaskRuntimeAdapters>): void {
  runtimeAdapters = {
    ...defaultRuntimeAdapters,
    ...adapters
  }
}

function safeJsonParse(value: unknown): unknown {
  if (!value || typeof value !== 'string') return null
  try { return JSON.parse(value) } catch { return null }
}

// Parse JSON columns from DB row
function parseTask(row: Record<string, unknown> | undefined): Task | null {
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
    merge_context: safeJsonParse(row.merge_context),
    loop_config: safeJsonParse(row.loop_config),
    is_temporary: Boolean(row.is_temporary),
    is_blocked: Boolean(row.is_blocked),
    active_asset_id: (row.active_asset_id as string) ?? null
  } as Task
}

function parseTasks(rows: Record<string, unknown>[]): Task[] {
  return rows.map((row) => parseTask(row)!)
}

function getProjectColumns(db: Database, projectId: string): ColumnConfig[] | null {
  const row = db.prepare('SELECT columns_config FROM projects WHERE id = ?').get(projectId) as
    | { columns_config: string | null }
    | undefined
  return parseColumnsConfig(row?.columns_config)
}

type TerminalModeFlagsRow = { id: string; default_flags: string | null }

function getEnabledModeDefaults(db: Database): TerminalModeFlagsRow[] {
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

function getModeDefaultFlags(db: Database, modeId: string): string | undefined {
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
function cleanupTaskImmediate(taskId: string): void {
  runtimeAdapters.killPtysByTaskId(taskId)
}

/** Kill PTY + processes + remove worktree + asset files — used for archive and hard purge */
async function cleanupTaskFull(db: Database, taskId: string): Promise<void> {
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

async function maybeAutoCreateWorktree(
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
  if (reachedTerminal || projectChanged) {
    runtimeAdapters.killPtysByTaskId(data.id)
  }
  // Clear snooze when task reaches terminal status
  if (reachedTerminal && !fields.some((f) => f.startsWith('snoozed_until'))) {
    db.prepare('UPDATE tasks SET snoozed_until = NULL WHERE id = ? AND snoozed_until IS NOT NULL').run(data.id)
  }

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
  return parseTask(row)
}

export function registerTaskHandlers(ipcMain: IpcMain, db: Database, onMutation?: () => void): void {

  // Purge stale soft-deleted tasks from previous sessions
  const stale = db.prepare(
    `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-5 minutes')`
  ).all() as { id: string }[]
  void (async () => {
    for (const { id } of stale) {
      await cleanupTaskFull(db, id)
    }
  })()
  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',')
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...stale.map((r) => r.id))
    // Clean up per-task commit graph settings
    for (const { id } of stale) {
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(`commit_graph:task:${id}`)
    }
    console.log(`Purged ${stale.length} soft-deleted task(s)`)
  }

  // Task CRUD
  ipcMain.handle('db:tasks:getAll', () => {
    const rows = db
      .prepare(`SELECT t.*, el.external_url AS linear_url
        FROM tasks t
        LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
        WHERE t.deleted_at IS NULL
        ORDER BY t."order" ASC, t.created_at DESC`)
      .all() as Record<string, unknown>[]
    return parseTasks(rows)
  })

  ipcMain.handle('db:tasks:getByProject', (_, projectId: string) => {
    const rows = db
      .prepare(
        `SELECT t.*, el.external_url AS linear_url
        FROM tasks t
        LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
        WHERE t.project_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
        ORDER BY t."order" ASC, t.created_at DESC`
      )
      .all(projectId) as Record<string, unknown>[]
    return parseTasks(rows)
  })

  ipcMain.handle('db:tasks:get', (_, id: string) => {
    const row = db.prepare(
      `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.id = ?`
    ).get(id) as Record<string, unknown> | undefined
    return parseTask(row)
  })

  ipcMain.handle('db:tasks:create', async (_, data: CreateTaskInput) => {
    const id = crypto.randomUUID()
    const projectColumns = getProjectColumns(db, data.projectId)

    // Resolve template (explicit > project default > none)
    const template = getTemplateForTask(db, data.projectId, data.templateId)

    const initialStatus =
      data.status && isKnownStatus(data.status, projectColumns)
        ? data.status
        : (template?.default_status && isKnownStatus(template.default_status, projectColumns))
          ? template.default_status
          : getDefaultStatus(projectColumns)
    const terminalMode = data.terminalMode
      ?? template?.terminal_mode
      ?? (db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
          .get() as { value: string } | undefined)?.value
      ?? 'claude-code'

    // Build provider_config from terminal_modes defaults + template + overrides
    const providerConfig: ProviderConfig = {}
    const legacyOverrides: Record<string, string | undefined> = {
      'claude-code': data.claudeFlags, 'codex': data.codexFlags,
      'cursor-agent': data.cursorFlags, 'gemini': data.geminiFlags, 'opencode': data.opencodeFlags,
    }
    const allModes = getEnabledModeDefaults(db)
    for (const row of allModes) {
      providerConfig[row.id] = {
        flags: legacyOverrides[row.id]
          ?? template?.provider_config?.[row.id]?.flags
          ?? row.default_flags ?? ''
      }
    }

    const ccsDefaultProfile = template?.ccs_profile
      ?? (db.prepare('SELECT value FROM settings WHERE key = ?')
        .get('ccs_default_profile') as { value: string } | undefined)?.value ?? null

    const priority = data.priority ?? template?.default_priority ?? 3
    const dangerouslySkipPerms = template?.dangerously_skip_permissions ? 1 : 0
    const panelVisibility = template?.panel_visibility ? JSON.stringify(template.panel_visibility) : null
    const browserTabs = template?.browser_tabs ? JSON.stringify(template.browser_tabs) : null
    const webPanelUrls = template?.web_panel_urls ? JSON.stringify(template.web_panel_urls) : null

    const stmt = db.prepare(`
      INSERT INTO tasks (
        id, project_id, parent_id, title, description, description_format, assignee,
        status, priority, due_date, terminal_mode, provider_config,
        claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
        is_temporary, ccs_profile, repo_name,
        dangerously_skip_permissions, panel_visibility, browser_tabs, web_panel_urls
      ) VALUES (?, ?, ?, ?, ?, 'markdown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const initialTask = db.transaction(() => {
      stmt.run(
        id, data.projectId, data.parentId ?? null,
        data.title, data.description ?? null, data.assignee ?? null,
        initialStatus, priority, data.dueDate ?? null,
        terminalMode, JSON.stringify(providerConfig),
        providerConfig['claude-code']?.flags ?? '',
        providerConfig['codex']?.flags ?? '',
        providerConfig['cursor-agent']?.flags ?? '',
        providerConfig['gemini']?.flags ?? '',
        providerConfig['opencode']?.flags ?? '',
        data.isTemporary ? 1 : 0,
        ccsDefaultProfile,
        data.repoName ?? null,
        dangerouslySkipPerms, panelVisibility, browserTabs, webPanelUrls
      )

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      const task = parseTask(row)
      if (!task) return null

      recordActivityEvents(db, buildTaskCreatedEvents(task))
      return task
    })()

    if (!initialTask) return null

    await maybeAutoCreateWorktree(db, id, data.projectId, data.title, data.repoName)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const task = parseTask(row)
    if (task) {
      ipcMain.emit('db:tasks:create:done', null, id, data.projectId)
      onMutation?.()
    }
    return task
  })

  ipcMain.handle('db:tasks:getSubTasks', (_, parentId: string) => {
    const rows = db
      .prepare(
        `SELECT t.*, el.external_url AS linear_url
        FROM tasks t
        LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
        WHERE t.parent_id = ? AND t.archived_at IS NULL AND t.deleted_at IS NULL
        ORDER BY t."order" ASC, t.created_at DESC`
      )
      .all(parentId) as Record<string, unknown>[]
    return parseTasks(rows)
  })

  ipcMain.handle('db:tasks:update', (_, data: UpdateTaskInput) => {
    const result = db.transaction(() => {
      const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
      const previousTask = parseTask(previousRow)
      const nextTask = updateTask(db, data)

      if (previousTask && nextTask) {
        recordActivityEvents(db, buildTaskUpdatedEvents(previousTask, nextTask))
      }

      return {
        previousTask,
        nextTask,
      }
    })()

    if (result.nextTask) {
      ipcMain.emit('db:tasks:update:done', null, data.id, { oldStatus: result.previousTask?.status })
      onMutation?.()
    }
    return result.nextTask
  })

  // Soft-delete: kill PTY but preserve worktree for undo
  // Block deletion of tasks linked to external providers — archive instead
  ipcMain.handle('db:tasks:delete', (_, id: string) => {
    const previousRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    const previousTask = parseTask(previousRow)
    const linkCount = (db.prepare(
      'SELECT COUNT(*) as count FROM external_links WHERE task_id = ?'
    ).get(id) as { count: number }).count
    if (linkCount > 0) {
      return { blocked: true, reason: 'linked_to_provider' }
    }

    cleanupTaskImmediate(id)
    const result = db.transaction(() => {
      const updateResult = db.prepare(`
        UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
      `).run(id)
      if (updateResult.changes > 0 && previousTask) {
        recordActivityEvents(db, buildTaskDeletedEvents(previousTask))
      }
      return updateResult
    })()
    if (result.changes > 0) {
      onMutation?.()
    }
    return result.changes > 0
  })

  // Restore a soft-deleted task
  ipcMain.handle('db:tasks:restore', (_, id: string) => {
    const task = db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?
      `).run(id)
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      const nextTask = parseTask(row)
      if (nextTask) {
        recordActivityEvents(db, buildTaskRestoredEvents(nextTask))
      }
      return nextTask
    })()
    onMutation?.()
    return task
  })

  // Archive operations
  ipcMain.handle('db:tasks:archive', async (_, id: string) => {
    const toArchiveRows = db.prepare('SELECT * FROM tasks WHERE id = ? OR parent_id = ?').all(id, id) as Record<string, unknown>[]
    const toArchiveTasks = parseTasks(toArchiveRows)
    await cleanupTaskFull(db, id)
    // Also archive sub-tasks
    const childIds = (db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL').all(id) as { id: string }[]).map(r => r.id)
    for (const childId of childIds) { await cleanupTaskFull(db, childId) }
    const archivedTask = db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, base_dir = NULL, updated_at = datetime('now')
        WHERE id = ? OR parent_id = ?
      `).run(id, id)
      recordActivityEvents(db, buildTaskArchivedEvents(toArchiveTasks))
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      return parseTask(row)
    })()
    ipcMain.emit('db:tasks:archive:done', null, id)
    onMutation?.()
    return archivedTask
  })

  ipcMain.handle('db:tasks:archiveMany', async (_, ids: string[]) => {
    if (ids.length === 0) return
    const placeholdersForExisting = ids.map(() => '?').join(',')
    const existingRows = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholdersForExisting}) OR parent_id IN (${placeholdersForExisting})`).all(...ids, ...ids) as Record<string, unknown>[]
    const existingTasks = parseTasks(existingRows)
    for (const id of ids) {
      await cleanupTaskFull(db, id)
    }
    // Also archive sub-tasks of all given parents
    const parentPlaceholders = ids.map(() => '?').join(',')
    const childIds = (db.prepare(`SELECT id FROM tasks WHERE parent_id IN (${parentPlaceholders}) AND archived_at IS NULL`).all(...ids) as { id: string }[]).map(r => r.id)
    for (const childId of childIds) { await cleanupTaskFull(db, childId) }
    const allIds = [...ids, ...childIds]
    const placeholders = allIds.map(() => '?').join(',')
    db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, base_dir = NULL, updated_at = datetime('now')
        WHERE id IN (${placeholders})
      `).run(...allIds)
      recordActivityEvents(db, buildTaskArchivedEvents(existingTasks.filter((task) => allIds.includes(task.id))))
    })()
    for (const id of allIds) {
      ipcMain.emit('db:tasks:archive:done', null, id)
    }
    onMutation?.()
  })

  ipcMain.handle('db:tasks:unarchive', (_, id: string) => {
    const task = db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET archived_at = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(id)
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
      const nextTask = parseTask(row)
      if (nextTask) {
        recordActivityEvents(db, buildTaskUnarchivedEvents(nextTask))
      }
      return nextTask
    })()
    ipcMain.emit('db:tasks:unarchive:done', null, id)
    onMutation?.()
    return task
  })

  ipcMain.handle('db:tasks:getArchived', () => {
    const rows = db
      .prepare('SELECT * FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL ORDER BY archived_at DESC')
      .all() as Record<string, unknown>[]
    return parseTasks(rows)
  })

  // Reorder
  ipcMain.handle('db:tasks:reorder', (_, taskIds: string[]) => {
    const stmt = db.prepare('UPDATE tasks SET "order" = ? WHERE id = ?')
    db.transaction(() => {
      taskIds.forEach((id, index) => {
        stmt.run(index, id)
      })
    })()
  })

  // Task Dependencies
  ipcMain.handle('db:taskDependencies:getBlockers', (_, taskId: string) => {
    const rows = db
      .prepare(
        `SELECT tasks.* FROM tasks
         JOIN task_dependencies ON tasks.id = task_dependencies.task_id
         WHERE task_dependencies.blocks_task_id = ?`
      )
      .all(taskId) as Record<string, unknown>[]
    return parseTasks(rows)
  })

  ipcMain.handle('db:taskDependencies:getAllBlockedTaskIds', () => {
    const rows = db
      .prepare(`SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
        UNION
        SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`)
      .all() as { id: string }[]
    return rows.map((r) => r.id)
  })

  ipcMain.handle('db:taskDependencies:getBlocking', (_, taskId: string) => {
    const rows = db
      .prepare(
        `SELECT tasks.* FROM tasks
         JOIN task_dependencies ON tasks.id = task_dependencies.blocks_task_id
         WHERE task_dependencies.task_id = ?`
      )
      .all(taskId) as Record<string, unknown>[]
    return parseTasks(rows)
  })

  ipcMain.handle(
    'db:taskDependencies:addBlocker',
    (_, taskId: string, blockerTaskId: string) => {
      db.prepare(
        'INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)'
      ).run(blockerTaskId, taskId)
    }
  )

  ipcMain.handle(
    'db:taskDependencies:removeBlocker',
    (_, taskId: string, blockerTaskId: string) => {
      db.prepare(
        'DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?'
      ).run(blockerTaskId, taskId)
    }
  )

  ipcMain.handle(
    'db:taskDependencies:setBlockers',
    (_, taskId: string, blockerTaskIds: string[]) => {
      const deleteStmt = db.prepare('DELETE FROM task_dependencies WHERE blocks_task_id = ?')
      const insertStmt = db.prepare(
        'INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)'
      )

      db.transaction(() => {
        deleteStmt.run(taskId)
        for (const blockerTaskId of blockerTaskIds) {
          insertStmt.run(blockerTaskId, taskId)
        }
      })()
    }
  )

  // Batched load for board data — single IPC round-trip instead of 5
  ipcMain.handle('db:loadBoardData', () => {
    const taskRows = db
      .prepare(`SELECT t.*, el.external_url AS linear_url
        FROM tasks t
        LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
        WHERE t.deleted_at IS NULL
        ORDER BY t."order" ASC, t.created_at DESC`)
      .all() as Record<string, unknown>[]

    const projectRows = db.prepare('SELECT * FROM projects ORDER BY sort_order').all() as Record<string, unknown>[]

    const tagRows = db.prepare('SELECT * FROM tags ORDER BY sort_order, name').all()

    const taskTagRows = db.prepare('SELECT task_id, tag_id FROM task_tags').all() as { task_id: string; tag_id: string }[]
    const taskTagMap: Record<string, string[]> = {}
    for (const row of taskTagRows) {
      if (!taskTagMap[row.task_id]) taskTagMap[row.task_id] = []
      taskTagMap[row.task_id].push(row.tag_id)
    }

    const blockedRows = db
      .prepare(`SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
        UNION
        SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`)
      .all() as { id: string }[]

    return {
      tasks: parseTasks(taskRows),
      projects: projectRows.map((row) => parseProject(row)!),
      tags: tagRows,
      taskTags: taskTagMap,
      blockedTaskIds: blockedRows.map((r) => r.id)
    }
  })

  // --- Task Assets ---

  const assetsDir = path.join(process.env.SLAYZONE_DB_DIR || app.getPath('userData'), 'assets')

  function getAssetFilePath(taskId: string, assetId: string, title: string): string {
    const ext = getExtensionFromTitle(title) || '.txt'
    return path.join(assetsDir, taskId, `${assetId}${ext}`)
  }

  function parseAsset(row: Record<string, unknown> | undefined): TaskAsset | null {
    if (!row) return null
    return {
      id: row.id as string,
      task_id: row.task_id as string,
      folder_id: (row.folder_id as string) ?? null,
      title: row.title as string,
      render_mode: (row.render_mode as RenderMode) ?? null,
      language: (row.language as string) ?? null,
      order: row.order as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }
  }

  function parseFolder(row: Record<string, unknown> | undefined): AssetFolder | null {
    if (!row) return null
    return {
      id: row.id as string,
      task_id: row.task_id as string,
      parent_id: (row.parent_id as string) ?? null,
      name: row.name as string,
      order: row.order as number,
      created_at: row.created_at as string,
    }
  }

  ipcMain.handle('db:assets:getByTask', (_, taskId: string) => {
    const rows = db
      .prepare('SELECT * FROM task_assets WHERE task_id = ? ORDER BY "order" ASC, created_at ASC')
      .all(taskId) as Record<string, unknown>[]
    return rows.map(parseAsset).filter(Boolean)
  })

  ipcMain.handle('db:assets:get', (_, id: string) => {
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:create', (_, data: CreateAssetInput) => {
    const id = randomUUID()
    const folderId = data.folderId ?? null
    const maxOrder = (db.prepare(
      folderId
        ? 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id = ?'
        : 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id IS NULL'
    ).get(...(folderId ? [data.taskId, folderId] : [data.taskId])) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO task_assets (id, task_id, folder_id, title, render_mode, language, "order")
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.taskId, folderId, data.title, data.renderMode ?? null, data.language ?? null, maxOrder + 1)

    // Write content to disk
    const filePath = getAssetFilePath(data.taskId, id, data.title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, data.content ?? '', 'utf-8')

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:update', (_, data: UpdateAssetInput) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []
    if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title) }
    if (data.folderId !== undefined) { sets.push('folder_id = ?'); values.push(data.folderId) }
    if (data.renderMode !== undefined) { sets.push('render_mode = ?'); values.push(data.renderMode) }
    if (data.language !== undefined) { sets.push('language = ?'); values.push(data.language) }
    if (sets.length > 0) {
      sets.push('updated_at = datetime(\'now\')')
      values.push(data.id)
      db.prepare(`UPDATE task_assets SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    // If title changed and extension changed, rename file on disk
    const taskId = existing.task_id as string
    const oldTitle = existing.title as string
    const newTitle = data.title ?? oldTitle
    if (data.title !== undefined) {
      const oldExt = getExtensionFromTitle(oldTitle) || '.txt'
      const newExt = getExtensionFromTitle(newTitle) || '.txt'
      if (oldExt !== newExt) {
        const oldPath = path.join(assetsDir, taskId, `${data.id}${oldExt}`)
        const newPath = path.join(assetsDir, taskId, `${data.id}${newExt}`)
        if (existsSync(oldPath)) {
          const content = readFileSync(oldPath, 'utf-8')
          writeFileSync(newPath, content, 'utf-8')
          unlinkSync(oldPath)
        }
      }
    }

    // Write content to disk if provided
    if (data.content !== undefined) {
      const filePath = getAssetFilePath(taskId, data.id, newTitle)
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, data.content, 'utf-8')
    }

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:delete', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (existsSync(filePath)) unlinkSync(filePath)

    db.prepare('DELETE FROM task_assets WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle('db:assets:reorder', (_, data: string[] | { folderId: string | null; assetIds: string[] }) => {
    const assetIds = Array.isArray(data) ? data : data.assetIds
    const stmt = db.prepare('UPDATE task_assets SET "order" = ? WHERE id = ?')
    db.transaction(() => {
      assetIds.forEach((id, index) => {
        stmt.run(index, id)
      })
    })()
  })

  ipcMain.handle('db:assets:readContent', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(filePath)) return ''
    return readFileSync(filePath, 'utf-8')
  })

  ipcMain.handle('db:assets:getFilePath', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    return getAssetFilePath(existing.task_id as string, id, existing.title as string)
  })

  ipcMain.handle('db:assets:upload', (_, data: { taskId: string; sourcePath: string; title?: string }) => {
    const id = randomUUID()
    const title = data.title ?? path.basename(data.sourcePath)
    const maxOrder = (db.prepare('SELECT MAX("order") as m FROM task_assets WHERE task_id = ?').get(data.taskId) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO task_assets (id, task_id, title, "order")
      VALUES (?, ?, ?, ?)
    `).run(id, data.taskId, title, maxOrder + 1)

    const filePath = getAssetFilePath(data.taskId, id, title)
    mkdirSync(path.dirname(filePath), { recursive: true })
    copyFileSync(data.sourcePath, filePath)

    onMutation?.()
    const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseAsset(row)
  })

  ipcMain.handle('db:assets:getFileSize', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return null
    const filePath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(filePath)) return null
    return statSync(filePath).size
  })

  ipcMain.handle('db:assets:uploadDir', (_, data: { taskId: string; dirPath: string; parentFolderId: string | null }) => {
    const createdFolders: ReturnType<typeof parseFolder>[] = []
    const createdAssets: ReturnType<typeof parseAsset>[] = []

    function walkDir(dirPath: string, parentFolderId: string | null) {
      const entries = readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          const folderId = randomUUID()
          const maxOrder = (db.prepare(
            parentFolderId
              ? 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id = ?'
              : 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id IS NULL'
          ).get(...(parentFolderId ? [data.taskId, parentFolderId] : [data.taskId])) as { m: number | null }).m ?? -1

          db.prepare(`
            INSERT INTO asset_folders (id, task_id, parent_id, name, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(folderId, data.taskId, parentFolderId, entry.name, maxOrder + 1)

          const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
          createdFolders.push(parseFolder(row))
          walkDir(fullPath, folderId)
        } else if (entry.isFile()) {
          const assetId = randomUUID()
          const title = entry.name
          const maxOrder = (db.prepare(
            parentFolderId
              ? 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id = ?'
              : 'SELECT MAX("order") as m FROM task_assets WHERE task_id = ? AND folder_id IS NULL'
          ).get(...(parentFolderId ? [data.taskId, parentFolderId] : [data.taskId])) as { m: number | null }).m ?? -1

          db.prepare(`
            INSERT INTO task_assets (id, task_id, folder_id, title, "order")
            VALUES (?, ?, ?, ?, ?)
          `).run(assetId, data.taskId, parentFolderId, title, maxOrder + 1)

          const filePath = getAssetFilePath(data.taskId, assetId, title)
          mkdirSync(path.dirname(filePath), { recursive: true })
          copyFileSync(fullPath, filePath)

          const row = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(assetId) as Record<string, unknown> | undefined
          createdAssets.push(parseAsset(row))
        }
      }
    }

    db.transaction(() => {
      walkDir(data.dirPath, data.parentFolderId)
    })()

    onMutation?.()
    return { folders: createdFolders.filter(Boolean), assets: createdAssets.filter(Boolean) }
  })

  // Cleanup asset files when a task is permanently deleted
  ipcMain.handle('db:assets:cleanupTask', (_, taskId: string) => {
    const taskDir = path.join(assetsDir, taskId)
    if (existsSync(taskDir)) rmSync(taskDir, { recursive: true, force: true })
  })

  // --- Asset Download ---

  ipcMain.handle('db:assets:downloadFile', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false
    const srcPath = getAssetFilePath(existing.task_id as string, id, existing.title as string)
    if (!existsSync(srcPath)) return false

    const defaultPath = path.join(app.getPath('downloads'), existing.title as string)
    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showSaveDialog(win, { title: 'Download Asset', defaultPath })
      : await dialog.showSaveDialog({ title: 'Download Asset', defaultPath })
    if (result.canceled || !result.filePath) return false

    copyFileSync(srcPath, result.filePath)
    return true
  })

  ipcMain.handle('db:assets:downloadFolder', async (_, folderId: string) => {
    const folder = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(folderId) as Record<string, unknown> | undefined
    if (!folder) return false

    const win = BrowserWindow.getFocusedWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Download Folder To', properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return false

    const destRoot = result.filePaths[0]
    const taskId = folder.task_id as string

    // Build folder path map: folderId -> name segments
    const allFolders = db.prepare('SELECT * FROM asset_folders WHERE task_id = ?').all(taskId) as Record<string, unknown>[]
    const byId = new Map(allFolders.map(f => [f.id as string, f]))
    function folderPath(id: string): string {
      const f = byId.get(id)
      if (!f) return ''
      const parent = f.parent_id as string | null
      return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
    }

    // Collect target folder ids (folderId + all descendants)
    const targetIds = new Set<string>([folderId])
    let changed = true
    while (changed) {
      changed = false
      for (const f of allFolders) {
        const id = f.id as string
        const parentId = f.parent_id as string | null
        if (parentId && targetIds.has(parentId) && !targetIds.has(id)) {
          targetIds.add(id)
          changed = true
        }
      }
    }

    // Compute relative path from the target folder's parent
    const rootFolderPath = folderPath(folderId)
    const rootParentPath = path.dirname(rootFolderPath)

    // Create all subdirectories
    for (const id of targetIds) {
      const rel = rootParentPath === '.' ? folderPath(id) : path.relative(rootParentPath, folderPath(id))
      mkdirSync(path.join(destRoot, rel), { recursive: true })
    }

    // Copy assets in target folders
    const assets = db.prepare('SELECT * FROM task_assets WHERE task_id = ? AND folder_id IN (' + [...targetIds].map(() => '?').join(',') + ')').all(taskId, ...targetIds) as Record<string, unknown>[]
    for (const asset of assets) {
      const srcPath = getAssetFilePath(taskId, asset.id as string, asset.title as string)
      if (!existsSync(srcPath)) continue
      const folderRel = rootParentPath === '.' ? folderPath(asset.folder_id as string) : path.relative(rootParentPath, folderPath(asset.folder_id as string))
      copyFileSync(srcPath, path.join(destRoot, folderRel, asset.title as string))
    }

    return true
  })

  // --- Download as PDF ---

  const PDF_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; background: white; line-height: 1.6; padding: 2rem; font-size: 14px; }
    h1 { font-size: 1.8em; margin: 1em 0 0.5em; font-weight: 700; }
    h2 { font-size: 1.4em; margin: 1em 0 0.4em; font-weight: 600; }
    h3 { font-size: 1.2em; margin: 0.8em 0 0.3em; font-weight: 600; }
    h4, h5, h6 { font-size: 1em; margin: 0.6em 0 0.2em; font-weight: 600; }
    p { margin: 0.5em 0; }
    a { color: #2563eb; text-decoration: underline; }
    ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
    li { margin: 0.2em 0; }
    blockquote { border-left: 3px solid #d1d5db; padding-left: 1em; margin: 0.5em 0; color: #4b5563; font-style: italic; }
    code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; background: #f3f4f6; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
    pre { background: #f3f4f6; padding: 1em; border-radius: 6px; overflow-x: auto; margin: 0.8em 0; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
    th, td { border: 1px solid #d1d5db; padding: 0.5em 0.75em; text-align: left; }
    th { background: #f9fafb; font-weight: 600; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #d1d5db; margin: 1.5em 0; }
    .line-numbers { color: #9ca3af; text-align: right; padding-right: 1em; user-select: none; border-right: 1px solid #e5e7eb; }
    .code-table { width: 100%; border: none; }
    .code-table td { border: none; padding: 0 0.5em; white-space: pre; vertical-align: top; }
    @page { margin: 1.5cm; }
  `

  function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  function buildPdfHtml(content: string, mode: string, title: string): string {
    let body = ''

    switch (mode) {
      case 'markdown':
        body = marked.parse(content, { async: false }) as string
        break

      case 'html-preview':
        body = content
        break

      case 'svg-preview':
        body = `<div style="display:flex;justify-content:center;padding:2rem">${content}</div>`
        break

      case 'code': {
        const lines = content.split('\n')
        const rows = lines.map((line, i) =>
          `<tr><td class="line-numbers">${i + 1}</td><td>${escapeHtml(line) || ' '}</td></tr>`
        ).join('\n')
        body = `<pre style="background:none;padding:0"><table class="code-table">${rows}</table></pre>`
        break
      }

      default:
        body = `<pre><code>${escapeHtml(content)}</code></pre>`
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PDF_CSS}</style></head><body>${body}</body></html>`
  }

  function buildMermaidPdfHtml(content: string, title: string): string {
    let mermaidJs = ''
    try {
      const mermaidPath = require.resolve('mermaid/dist/mermaid.min.js')
      mermaidJs = readFileSync(mermaidPath, 'utf-8')
    } catch {
      // Fallback: render as code
      return buildPdfHtml(content, 'code', title)
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${PDF_CSS} .mermaid svg { max-width: 100%; }</style>
</head><body>
<pre class="mermaid">${escapeHtml(content)}</pre>
<script>${mermaidJs}</script>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'default' });
  mermaid.run().then(() => {
    document.title = 'MERMAID_READY';
  }).catch(() => {
    document.title = 'MERMAID_READY';
  });
</script>
</body></html>`
  }

  ipcMain.handle('db:assets:downloadAsPdf', async (_, id: string) => {
    const existing = db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false

    const title = existing.title as string
    const mode = getEffectiveRenderMode(title, (existing.render_mode as string | null) as any)
    if (!canExportAsPdf(mode)) return false

    const srcPath = getAssetFilePath(existing.task_id as string, id, title)
    if (!existsSync(srcPath)) return false
    const content = readFileSync(srcPath, 'utf-8')

    // Build HTML
    const isMermaid = mode === 'mermaid-preview'
    const html = isMermaid ? buildMermaidPdfHtml(content, title) : buildPdfHtml(content, mode, title)

    // Write to temp file
    const tempPath = path.join(tmpdir(), `slayzone-pdf-${id}.html`)
    writeFileSync(tempPath, html, 'utf-8')

    let offscreen: BrowserWindow | null = null
    try {
      offscreen = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
      })

      await offscreen.loadFile(tempPath)

      // For mermaid, wait for rendering
      if (isMermaid) {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          const ready = await offscreen.webContents.executeJavaScript('document.title')
          if (ready === 'MERMAID_READY') break
          await new Promise(r => setTimeout(r, 100))
        }
      }

      const pdfBuffer = await offscreen.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'default' },
      })

      // Show save dialog
      const baseName = title.replace(/\.[^.]+$/, '') || title
      const defaultPath = path.join(app.getPath('downloads'), `${baseName}.pdf`)
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showSaveDialog(win, { title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
        : await dialog.showSaveDialog({ title: 'Download as PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] })
      if (result.canceled || !result.filePath) return false

      writeFileSync(result.filePath, pdfBuffer)
      shell.showItemInFolder(result.filePath)
      return true
    } finally {
      offscreen?.destroy()
      try { unlinkSync(tempPath) } catch {}
    }
  })

  // --- Asset Folders ---

  ipcMain.handle('db:assetFolders:getByTask', (_, taskId: string) => {
    const rows = db
      .prepare('SELECT * FROM asset_folders WHERE task_id = ? ORDER BY "order" ASC, created_at ASC')
      .all(taskId) as Record<string, unknown>[]
    return rows.map(parseFolder).filter(Boolean)
  })

  ipcMain.handle('db:assetFolders:create', (_, data: CreateAssetFolderInput) => {
    const id = randomUUID()
    const parentId = data.parentId ?? null
    const maxOrder = (db.prepare(
      parentId
        ? 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id = ?'
        : 'SELECT MAX("order") as m FROM asset_folders WHERE task_id = ? AND parent_id IS NULL'
    ).get(...(parentId ? [data.taskId, parentId] : [data.taskId])) as { m: number | null }).m ?? -1

    db.prepare(`
      INSERT INTO asset_folders (id, task_id, parent_id, name, "order")
      VALUES (?, ?, ?, ?, ?)
    `).run(id, data.taskId, parentId, data.name, maxOrder + 1)

    onMutation?.()
    const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseFolder(row)
  })

  ipcMain.handle('db:assetFolders:update', (_, data: UpdateAssetFolderInput) => {
    const existing = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []
    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name) }
    if (data.parentId !== undefined) { sets.push('parent_id = ?'); values.push(data.parentId) }
    if (sets.length > 0) {
      values.push(data.id)
      db.prepare(`UPDATE asset_folders SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    }

    onMutation?.()
    const row = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseFolder(row)
  })

  ipcMain.handle('db:assetFolders:delete', (_, id: string) => {
    const existing = db.prepare('SELECT * FROM asset_folders WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!existing) return false
    db.prepare('DELETE FROM asset_folders WHERE id = ?').run(id)
    onMutation?.()
    return true
  })

  ipcMain.handle('db:assetFolders:reorder', (_, data: { parentId: string | null; folderIds: string[] }) => {
    const stmt = db.prepare('UPDATE asset_folders SET "order" = ? WHERE id = ?')
    db.transaction(() => {
      data.folderIds.forEach((id, index) => {
        stmt.run(index, id)
      })
    })()
  })
}

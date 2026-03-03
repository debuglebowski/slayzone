import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import type { CreateTaskInput, UpdateTaskInput, Task, ProviderConfig } from '@slayzone/task/shared'
import { PROVIDER_DEFAULTS } from '@slayzone/task/shared'
import type { ColumnConfig } from '@slayzone/projects/shared'
import { getDefaultStatus, isKnownStatus, isTerminalStatus, parseColumnsConfig } from '@slayzone/projects/shared'
import path from 'path'
import { removeWorktree, createWorktree, runWorktreeSetupScript, getCurrentBranch, isGitRepo } from '@slayzone/worktrees/main'

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

function clearProviderConversationIds(cfg: ProviderConfig): ProviderConfig {
  const next: ProviderConfig = {}
  for (const [mode, entry] of Object.entries(cfg)) {
    next[mode] = { ...entry, conversationId: null }
  }
  return next
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
    is_temporary: Boolean(row.is_temporary)
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

/** Kill PTY only — used for soft-delete (preserves worktree for undo) */
function cleanupTaskImmediate(taskId: string): void {
  runtimeAdapters.killPtysByTaskId(taskId)
}

/** Kill PTY + processes + remove worktree — used for archive and hard purge */
function cleanupTaskFull(db: Database, taskId: string): void {
  cleanupTaskImmediate(taskId)
  runtimeAdapters.killTaskProcesses(taskId)

  const task = db.prepare(
    'SELECT worktree_path, project_id FROM tasks WHERE id = ?'
  ).get(taskId) as { worktree_path: string | null; project_id: string } | undefined

  if (!task?.worktree_path) return

  const project = db.prepare(
    'SELECT path FROM projects WHERE id = ?'
  ).get(task.project_id) as { path: string } | undefined

  if (project?.path) {
    try {
      removeWorktree(project.path, task.worktree_path)
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

function maybeAutoCreateWorktree(
  db: Database,
  taskId: string,
  projectId: string,
  taskTitle: string
): void {
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

  if (!isGitRepo(projectRow.path)) {
    runtimeAdapters.recordDiagnosticEvent({
      level: 'info',
      source: 'task',
      event: 'task.auto_worktree_skipped',
      taskId,
      projectId,
      message: 'Project path is not a git repository',
      payload: { projectPath: projectRow.path }
    })
    return
  }

  const baseTemplate =
    (db.prepare("SELECT value FROM settings WHERE key = 'worktree_base_path'")
      .get() as { value: string } | undefined)?.value || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE
  const basePath = resolveWorktreeBasePathTemplate(baseTemplate, projectRow.path)
  const branch = slugify(taskTitle) || `task-${taskId.slice(0, 8)}`
  const worktreePath = path.join(basePath, branch)
  const parentBranch = getCurrentBranch(projectRow.path)

  const sourceBranch = projectRow.worktree_source_branch ?? undefined

  try {
    createWorktree(projectRow.path, worktreePath, branch, sourceBranch)
    // Fire-and-forget: don't block task creation on setup script
    void runWorktreeSetupScript(worktreePath, projectRow.path, sourceBranch)
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
      payload: {
        projectPath: projectRow.path,
        worktreePath,
        branch,
        parentBranch,
        sourceBranch
      }
    })
  } catch (err) {
    runtimeAdapters.recordDiagnosticEvent({
      level: 'error',
      source: 'task',
      event: 'task.auto_worktree_create_failed',
      taskId,
      projectId,
      message: err instanceof Error ? err.message : String(err),
      payload: {
        projectPath: projectRow.path,
        baseTemplate,
        basePath,
        branch,
        worktreePath
      }
    })
  }
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
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description) }
  if (data.status !== undefined || normalizedStatusForWrite !== undefined) {
    fields.push('status = ?')
    values.push(normalizedStatusForWrite ?? data.status)
  }
  if (data.assignee !== undefined) { fields.push('assignee = ?'); values.push(data.assignee) }
  if (data.priority !== undefined) { fields.push('priority = ?'); values.push(data.priority) }
  if (data.dueDate !== undefined) { fields.push('due_date = ?'); values.push(data.dueDate) }
  if (data.projectId !== undefined) { fields.push('project_id = ?'); values.push(data.projectId) }
  if (data.claudeSessionId !== undefined) { fields.push('claude_session_id = ?'); values.push(data.claudeSessionId) }
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
    const shouldResetConversationIds = data.worktreePath !== undefined && data.providerConfig === undefined && !hasLegacyUpdate

    if (data.providerConfig !== undefined || hasLegacyUpdate || shouldResetConversationIds) {
      // Read current provider_config
      const currentRow = db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(data.id) as { provider_config: string } | undefined
      const current: ProviderConfig = (safeJsonParse(currentRow?.provider_config) as ProviderConfig) ?? {}
      // Deep merge: per-mode entry merge so partial updates don't clobber existing fields
      const merged: ProviderConfig = { ...current }
      if (shouldResetConversationIds) {
        const reset = clearProviderConversationIds(current)
        for (const [mode, entry] of Object.entries(reset)) {
          merged[mode] = { ...merged[mode], ...entry }
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
  if (data.worktreePath !== undefined) { fields.push('worktree_path = ?'); values.push(data.worktreePath) }
  if (data.worktreeParentBranch !== undefined) { fields.push('worktree_parent_branch = ?'); values.push(data.worktreeParentBranch) }
  if (data.browserUrl !== undefined) { fields.push('browser_url = ?'); values.push(data.browserUrl) }
  if (data.browserTabs !== undefined) { fields.push('browser_tabs = ?'); values.push(data.browserTabs ? JSON.stringify(data.browserTabs) : null) }
  if (data.webPanelUrls !== undefined) { fields.push('web_panel_urls = ?'); values.push(data.webPanelUrls ? JSON.stringify(data.webPanelUrls) : null) }
  if (data.editorOpenFiles !== undefined) { fields.push('editor_open_files = ?'); values.push(data.editorOpenFiles ? JSON.stringify(data.editorOpenFiles) : null) }
  if (data.mergeState !== undefined) { fields.push('merge_state = ?'); values.push(data.mergeState) }
  if (data.mergeContext !== undefined) { fields.push('merge_context = ?'); values.push(data.mergeContext ? JSON.stringify(data.mergeContext) : null) }
  if (data.isTemporary !== undefined) { fields.push('is_temporary = ?'); values.push(data.isTemporary ? 1 : 0) }
  if (data.ccsProfile !== undefined) { fields.push('ccs_profile = ?'); values.push(data.ccsProfile) }

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

  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
  return parseTask(row)
}

export function registerTaskHandlers(ipcMain: IpcMain, db: Database): void {

  // Purge stale soft-deleted tasks from previous sessions
  const stale = db.prepare(
    `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-5 minutes')`
  ).all() as { id: string }[]
  for (const { id } of stale) {
    cleanupTaskFull(db, id)
  }
  if (stale.length > 0) {
    const placeholders = stale.map(() => '?').join(',')
    db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...stale.map((r) => r.id))
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

  ipcMain.handle('db:tasks:create', (_, data: CreateTaskInput) => {
    const id = crypto.randomUUID()
    const projectColumns = getProjectColumns(db, data.projectId)
    const initialStatus =
      data.status && isKnownStatus(data.status, projectColumns)
        ? data.status
        : getDefaultStatus(projectColumns)
    const terminalMode = data.terminalMode
      ?? (db.prepare("SELECT value FROM settings WHERE key = 'default_terminal_mode'")
          .get() as { value: string } | undefined)?.value
      ?? 'claude-code'

    // Build provider_config from defaults + overrides
    const providerConfig: ProviderConfig = {}
    const legacyOverrides: Record<string, string | undefined> = {
      'claude-code': data.claudeFlags, 'codex': data.codexFlags,
      'cursor-agent': data.cursorFlags, 'gemini': data.geminiFlags, 'opencode': data.opencodeFlags,
    }
    for (const [mode, def] of Object.entries(PROVIDER_DEFAULTS)) {
      const dbDefault = (db.prepare('SELECT value FROM settings WHERE key = ?')
        .get(def.settingsKey) as { value: string } | undefined)?.value ?? def.fallback
      providerConfig[mode] = { flags: legacyOverrides[mode] ?? dbDefault }
    }

    const ccsDefaultProfile = (db.prepare('SELECT value FROM settings WHERE key = ?')
      .get('ccs_default_profile') as { value: string } | undefined)?.value ?? null

    const stmt = db.prepare(`
      INSERT INTO tasks (
        id, project_id, parent_id, title, description, assignee,
        status, priority, due_date, terminal_mode, provider_config,
        claude_flags, codex_flags, cursor_flags, gemini_flags, opencode_flags,
        is_temporary, ccs_profile
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      id, data.projectId, data.parentId ?? null,
      data.title, data.description ?? null, data.assignee ?? null,
      initialStatus, data.priority ?? 3, data.dueDate ?? null,
      terminalMode, JSON.stringify(providerConfig),
      providerConfig['claude-code']?.flags ?? '',
      providerConfig['codex']?.flags ?? '',
      providerConfig['cursor-agent']?.flags ?? '',
      providerConfig['gemini']?.flags ?? '',
      providerConfig['opencode']?.flags ?? '',
      data.isTemporary ? 1 : 0,
      ccsDefaultProfile
    )
    maybeAutoCreateWorktree(db, id, data.projectId, data.title)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseTask(row)
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

  ipcMain.handle('db:tasks:update', (_, data: UpdateTaskInput) => updateTask(db, data))

  // Soft-delete: kill PTY but preserve worktree for undo
  ipcMain.handle('db:tasks:delete', (_, id: string) => {
    cleanupTaskImmediate(id)
    const result = db.prepare(`
      UPDATE tasks SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
    `).run(id)
    return result.changes > 0
  })

  // Restore a soft-deleted task
  ipcMain.handle('db:tasks:restore', (_, id: string) => {
    db.prepare(`
      UPDATE tasks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?
    `).run(id)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseTask(row)
  })

  // Archive operations
  ipcMain.handle('db:tasks:archive', (_, id: string) => {
    cleanupTaskFull(db, id)
    // Also archive sub-tasks
    const childIds = (db.prepare('SELECT id FROM tasks WHERE parent_id = ? AND archived_at IS NULL').all(id) as { id: string }[]).map(r => r.id)
    for (const childId of childIds) { cleanupTaskFull(db, childId) }
    db.prepare(`
      UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, updated_at = datetime('now')
      WHERE id = ? OR parent_id = ?
    `).run(id, id)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseTask(row)
  })

  ipcMain.handle('db:tasks:archiveMany', (_, ids: string[]) => {
    if (ids.length === 0) return
    for (const id of ids) {
      cleanupTaskFull(db, id)
    }
    // Also archive sub-tasks of all given parents
    const parentPlaceholders = ids.map(() => '?').join(',')
    const childIds = (db.prepare(`SELECT id FROM tasks WHERE parent_id IN (${parentPlaceholders}) AND archived_at IS NULL`).all(...ids) as { id: string }[]).map(r => r.id)
    for (const childId of childIds) { cleanupTaskFull(db, childId) }
    const allIds = [...ids, ...childIds]
    const placeholders = allIds.map(() => '?').join(',')
    db.prepare(`
      UPDATE tasks SET archived_at = datetime('now'), worktree_path = NULL, updated_at = datetime('now')
      WHERE id IN (${placeholders})
    `).run(...allIds)
  })

  ipcMain.handle('db:tasks:unarchive', (_, id: string) => {
    db.prepare(`
      UPDATE tasks SET archived_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(id)
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return parseTask(row)
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
      .prepare('SELECT DISTINCT blocks_task_id FROM task_dependencies')
      .all() as { blocks_task_id: string }[]
    return rows.map((r) => r.blocks_task_id)
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
}

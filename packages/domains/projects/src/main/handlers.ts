import type { IpcMain } from 'electron'
import { app } from 'electron'
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs'
import path from 'path'
import type { Database } from 'better-sqlite3'
import type {
  ColumnConfig,
  CreateProjectInput,
  UpdateProjectInput,
  WorkflowCategory
} from '@slayzone/projects/shared'
import {
  getDefaultStatus,
  parseColumnsConfig,
  prepareProjectCreate,
  resolveColumns,
  validateColumns
} from '@slayzone/projects/shared'

const ALLOWED_ICON_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function getProjectIconsDir(): string {
  return path.join(process.env.SLAYZONE_DB_DIR || app.getPath('userData'), 'project-icons')
}

function unlinkProjectIconFiles(projectId: string): void {
  const dir = getProjectIconsDir()
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`${projectId}.`)) {
      try { unlinkSync(path.join(dir, entry)) } catch { /* best-effort */ }
    }
  }
}

export function parseProject(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null
  return {
    ...row,
    columns_config: parseColumnsConfig(row.columns_config),
    execution_context: row.execution_context ? (() => { try { return JSON.parse(row.execution_context as string) } catch { return null } })() : null,
    task_automation_config: row.task_automation_config ? (() => { try { return JSON.parse(row.task_automation_config as string) } catch { return null } })() : null
  }
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { name: string } | undefined
  return Boolean(row)
}

function remapUnknownTaskStatuses(
  db: Database,
  projectId: string,
  columnsConfig: ColumnConfig[] | null
): void {
  const resolvedColumns = resolveColumns(columnsConfig)
  const knownStatuses = new Set(resolvedColumns.map((column) => column.id))
  const fallbackStatus = getDefaultStatus(columnsConfig)
  const tasks = db.prepare('SELECT id, status FROM tasks WHERE project_id = ?').all(projectId) as Array<{
    id: string
    status: string
  }>
  const updateTaskStatus = db.prepare(
    "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )

  for (const task of tasks) {
    if (!knownStatuses.has(task.status)) {
      updateTaskStatus.run(fallbackStatus, task.id)
    }
  }
}

function getLinearStateTypeForCategory(
  category: WorkflowCategory,
  availableStateTypes: Set<string>
): string | null {
  const candidates: Record<WorkflowCategory, string[]> = {
    triage: ['triage', 'unstarted', 'backlog'],
    backlog: ['backlog', 'unstarted', 'triage'],
    unstarted: ['unstarted', 'triage', 'backlog'],
    started: ['started'],
    completed: ['completed', 'canceled'],
    canceled: ['canceled', 'completed']
  }
  return candidates[category].find((stateType) => availableStateTypes.has(stateType)) ?? null
}

function reconcileLinearStateMappingsForProject(
  db: Database,
  projectId: string,
  columnsConfig: ColumnConfig[] | null
): void {
  if (!tableExists(db, 'integration_project_mappings') || !tableExists(db, 'integration_state_mappings')) {
    return
  }

  const mappings = db
    .prepare(`
      SELECT id
      FROM integration_project_mappings
      WHERE provider = 'linear' AND project_id = ?
    `)
    .all(projectId) as Array<{ id: string }>

  if (mappings.length === 0) return

  const resolvedColumns = resolveColumns(columnsConfig)
  const listStateMappings = db.prepare(`
    SELECT state_id, state_type
    FROM integration_state_mappings
    WHERE provider = 'linear' AND project_mapping_id = ?
    ORDER BY rowid ASC
  `)
  const deleteStateMappings = db.prepare(
    "DELETE FROM integration_state_mappings WHERE provider = 'linear' AND project_mapping_id = ?"
  )
  const insertStateMapping = db.prepare(`
    INSERT INTO integration_state_mappings (
      id, provider, project_mapping_id, local_status, state_id, state_type, created_at, updated_at
    ) VALUES (?, 'linear', ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)

  for (const mapping of mappings) {
    const existing = listStateMappings.all(mapping.id) as Array<{ state_id: string; state_type: string }>
    if (existing.length === 0) continue

    const stateIdByType = new Map<string, string>()
    for (const row of existing) {
      if (!stateIdByType.has(row.state_type)) {
        stateIdByType.set(row.state_type, row.state_id)
      }
    }
    const availableStateTypes = new Set(stateIdByType.keys())
    if (availableStateTypes.size === 0) continue

    const nextRows: Array<{ localStatus: string; stateId: string; stateType: string }> = []
    for (const column of resolvedColumns) {
      const stateType = getLinearStateTypeForCategory(column.category, availableStateTypes)
      if (!stateType) continue
      const stateId = stateIdByType.get(stateType)
      if (!stateId) continue
      nextRows.push({ localStatus: column.id, stateId, stateType })
    }

    if (nextRows.length === 0) continue

    deleteStateMappings.run(mapping.id)
    for (const row of nextRows) {
      insertStateMapping.run(crypto.randomUUID(), mapping.id, row.localStatus, row.stateId, row.stateType)
    }
  }
}

export function registerProjectHandlers(ipcMain: IpcMain, db: Database): void {

  ipcMain.handle('db:projects:getAll', () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY sort_order').all() as Record<string, unknown>[]
    return rows.map((row) => parseProject(row))
  })

  ipcMain.handle('db:projects:create', (_, data: CreateProjectInput) => {
    const prepared = prepareProjectCreate(data)
    return db.transaction(() => {
      const { sort_order: nextOrder } = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM projects'
      ).get() as { sort_order: number }
      const stmt = db.prepare(`
        INSERT INTO projects (id, name, color, path, columns_config, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(
        prepared.id,
        prepared.name,
        prepared.color,
        prepared.path,
        prepared.columnsConfigJson,
        nextOrder,
        prepared.createdAt,
        prepared.updatedAt
      )
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(prepared.id) as Record<string, unknown> | undefined
      return parseProject(row)
    })()
  })

  ipcMain.handle('db:projects:update', (_, data: UpdateProjectInput) => {
    const fields: string[] = []
    const values: unknown[] = []
    let normalizedColumns: ColumnConfig[] | null | undefined = undefined

    if (data.name !== undefined) {
      fields.push('name = ?')
      values.push(data.name)
    }
    if (data.color !== undefined) {
      fields.push('color = ?')
      values.push(data.color)
    }
    if (data.path !== undefined) {
      fields.push('path = ?')
      values.push(data.path)
    }
    if (data.autoCreateWorktreeOnTaskCreate !== undefined) {
      fields.push('auto_create_worktree_on_task_create = ?')
      if (data.autoCreateWorktreeOnTaskCreate === null) {
        values.push(null)
      } else {
        values.push(data.autoCreateWorktreeOnTaskCreate ? 1 : 0)
      }
    }
    if (data.worktreeSourceBranch !== undefined) {
      fields.push('worktree_source_branch = ?')
      values.push(data.worktreeSourceBranch)
    }
    if (data.worktreeCopyBehavior !== undefined) {
      fields.push('worktree_copy_behavior = ?')
      values.push(data.worktreeCopyBehavior)
    }
    if (data.worktreeCopyPaths !== undefined) {
      fields.push('worktree_copy_paths = ?')
      values.push(data.worktreeCopyPaths)
    }
    if (data.executionContext !== undefined) {
      fields.push('execution_context = ?')
      values.push(data.executionContext ? JSON.stringify(data.executionContext) : null)
    }
    if (data.selectedRepo !== undefined) {
      fields.push('selected_repo = ?')
      values.push(data.selectedRepo)
    }
    if (data.taskAutomationConfig !== undefined) {
      fields.push('task_automation_config = ?')
      values.push(data.taskAutomationConfig ? JSON.stringify(data.taskAutomationConfig) : null)
    }
    if (data.iconLetters !== undefined) {
      fields.push('icon_letters = ?')
      const trimmed = data.iconLetters?.trim()
      values.push(trimmed && trimmed.length > 0 ? trimmed.slice(0, 5) : null)
    }
    if (data.iconImagePath !== undefined) {
      fields.push('icon_image_path = ?')
      // If clearing, unlink any disk file for this project
      if (data.iconImagePath === null) {
        unlinkProjectIconFiles(data.id)
      }
      values.push(data.iconImagePath)
    }
    if (data.columnsConfig !== undefined) {
      fields.push('columns_config = ?')
      if (data.columnsConfig === null) {
        normalizedColumns = null
        values.push(null)
      } else {
        normalizedColumns = validateColumns(data.columnsConfig)
        values.push(JSON.stringify(normalizedColumns))
      }
    }

    if (fields.length === 0) {
      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
      return parseProject(row)
    }

    fields.push("updated_at = datetime('now')")
    values.push(data.id)

    db.transaction(() => {
      db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
      if (normalizedColumns !== undefined) {
        remapUnknownTaskStatuses(db, data.id, normalizedColumns)
        reconcileLinearStateMappingsForProject(db, data.id, normalizedColumns)
        // Clear stale automation config references
        const cols = normalizedColumns
        if (cols) {
          const projRow = db.prepare('SELECT task_automation_config FROM projects WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
          if (projRow?.task_automation_config) {
            try {
              const cfg = JSON.parse(projRow.task_automation_config as string) as { on_terminal_active: string | null; on_terminal_idle: string | null }
              const validIds = new Set(cols.map(c => c.id))
              let changed = false
              if (cfg.on_terminal_active && !validIds.has(cfg.on_terminal_active)) { cfg.on_terminal_active = null; changed = true }
              if (cfg.on_terminal_idle && !validIds.has(cfg.on_terminal_idle)) { cfg.on_terminal_idle = null; changed = true }
              if (changed) db.prepare('UPDATE projects SET task_automation_config = ? WHERE id = ?').run(JSON.stringify(cfg), data.id)
            } catch { /* ignore parse errors */ }
          }
        }
      }
    })()
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseProject(row)
  })

  ipcMain.handle('db:projects:delete', (_, id: string) => {
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    db.prepare('DELETE FROM settings WHERE key = ?').run(`commit_graph:project:${id}`)
    unlinkProjectIconFiles(id)
    return result.changes > 0
  })

  ipcMain.handle('db:projects:uploadIcon', (_, projectId: string, sourcePath: string) => {
    const ext = path.extname(sourcePath).toLowerCase()
    if (!ALLOWED_ICON_EXTS.has(ext)) {
      throw new Error(`Unsupported icon extension: ${ext}`)
    }
    const dir = getProjectIconsDir()
    mkdirSync(dir, { recursive: true })
    // Remove any prior file for this project (handles ext change png→jpg)
    unlinkProjectIconFiles(projectId)
    const destPath = path.join(dir, `${projectId}${ext}`)
    copyFileSync(sourcePath, destPath)

    db.prepare("UPDATE projects SET icon_image_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(destPath, projectId)
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined
    return parseProject(row)
  })

  ipcMain.handle('db:projects:reorder', (_, projectIds: string[]) => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }
    if (projectIds.length !== count) throw new Error(`Expected ${count} project IDs, got ${projectIds.length}`)
    const update = db.prepare("UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?")
    db.transaction(() => {
      projectIds.forEach((id, index) => update.run(index, id))
    })()
  })
}

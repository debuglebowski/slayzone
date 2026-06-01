import type { IpcMain } from 'electron'
import { app } from 'electron'
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'fs'
import path from 'path'
import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ColumnConfig,
  CreateProjectInput,
  UpdateProjectInput
} from '@slayzone/projects/shared'
import {
  parseColumnsConfig,
  prepareProjectCreate,
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
      try {
        unlinkSync(path.join(dir, entry))
      } catch {
        /* best-effort */
      }
    }
  }
}

export function parseProject(
  row: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!row) return null
  return {
    ...row,
    columns_config: parseColumnsConfig(row.columns_config),
    execution_context: row.execution_context
      ? (() => {
          try {
            return JSON.parse(row.execution_context as string)
          } catch {
            return null
          }
        })()
      : null,
    task_automation_config: row.task_automation_config
      ? (() => {
          try {
            return JSON.parse(row.task_automation_config as string)
          } catch {
            return null
          }
        })()
      : null,
    lock_config: row.lock_config
      ? (() => {
          try {
            return JSON.parse(row.lock_config as string)
          } catch {
            return null
          }
        })()
      : null
  }
}

export function registerProjectHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  ipcMain.handle('db:projects:getAll', async () => {
    const rows = await db.all<Record<string, unknown>>(
      'SELECT * FROM projects ORDER BY sort_order'
    )
    return rows.map((row) => parseProject(row))
  })

  ipcMain.handle('db:projects:create', async (_, data: CreateProjectInput) => {
    const prepared = prepareProjectCreate(data)
    const row = await db.namedTxn<Record<string, unknown> | undefined>('projects:create', {
      id: prepared.id,
      name: prepared.name,
      color: prepared.color,
      path: prepared.path,
      columnsConfigJson: prepared.columnsConfigJson,
      createdAt: prepared.createdAt,
      updatedAt: prepared.updatedAt
    })
    return parseProject(row)
  })

  ipcMain.handle('db:projects:update', async (_, data: UpdateProjectInput) => {
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
    if (data.worktreeSubmoduleInit !== undefined) {
      fields.push('worktree_submodule_init = ?')
      values.push(data.worktreeSubmoduleInit)
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
    if (data.lockConfig !== undefined) {
      fields.push('lock_config = ?')
      values.push(data.lockConfig ? JSON.stringify(data.lockConfig) : null)
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
      const row = await db.get<Record<string, unknown>>(
        'SELECT * FROM projects WHERE id = ?',
        [data.id]
      )
      return parseProject(row)
    }

    fields.push("updated_at = datetime('now')")
    values.push(data.id)

    const row = await db.namedTxn<Record<string, unknown> | undefined>('projects:update', {
      id: data.id,
      sql: `UPDATE projects SET ${fields.join(', ')} WHERE id = ?`,
      params: values,
      normalizedColumns
    })
    return parseProject(row)
  })

  ipcMain.handle('db:projects:delete', async (_, id: string) => {
    const result = await db.run('DELETE FROM projects WHERE id = ?', [id])
    await db.run('DELETE FROM settings WHERE key = ?', [`commit_graph:project:${id}`])
    unlinkProjectIconFiles(id)
    return result.changes > 0
  })

  ipcMain.handle('db:projects:uploadIcon', async (_, projectId: string, sourcePath: string) => {
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

    await db.run(
      "UPDATE projects SET icon_image_path = ?, updated_at = datetime('now') WHERE id = ?",
      [destPath, projectId]
    )
    const row = await db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [
      projectId
    ])
    return parseProject(row)
  })

  ipcMain.handle('db:projects:reorder', async (_, projectIds: string[]) => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return
    const { count } = (await db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM projects'
    )) as { count: number }
    if (projectIds.length !== count)
      throw new Error(`Expected ${count} project IDs, got ${projectIds.length}`)
    await db.batchTxn(
      projectIds.map((id, index) => ({
        type: 'run' as const,
        sql: "UPDATE projects SET sort_order = ?, updated_at = datetime('now') WHERE id = ?",
        params: [index, id]
      }))
    )
  })
}

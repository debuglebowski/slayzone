import type { IpcMain } from 'electron'
import type { Database } from 'better-sqlite3'
import path from 'node:path'
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
import {
  getRepoFeatureSyncConfig,
  syncAllProjectFeatureTasks,
  syncProjectFeatureTasks
} from './repo-feature-sync'

function parseProject(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null
  return {
    ...row,
    columns_config: parseColumnsConfig(row.columns_config)
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

function normalizeRepoFeaturesPath(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim()
  const candidate = raw.length > 0 ? raw : fallback
  const normalized = candidate
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')

  if (normalized.length === 0 || normalized === '.') return '.'
  if (normalized.startsWith('/')) {
    throw new Error('Features folder must be relative to the repository path')
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Features folder must be relative to the repository path')
  }

  const collapsed = normalized.split('/').reduce<string[]>((acc, segment) => {
    if (!segment || segment === '.') return acc
    if (segment === '..') {
      if (acc.length === 0) throw new Error('Features folder must stay inside the repository path')
      acc.pop()
      return acc
    }
    acc.push(segment)
    return acc
  }, [])

  return collapsed.join('/') || '.'
}

function assertFeaturesPathInsideRepo(repoPath: string, featuresPath: string): void {
  const repoRoot = path.resolve(repoPath)
  const resolved = path.resolve(repoPath, featuresPath)
  const relative = path.relative(repoRoot, resolved)
  if (relative === '') return
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Features folder must stay inside the repository path')
  }
}

export function registerProjectHandlers(ipcMain: IpcMain, db: Database): void {

  ipcMain.handle('db:projects:getAll', () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY name').all() as Record<string, unknown>[]
    return rows.map((row) => parseProject(row))
  })

  ipcMain.handle('db:projects:create', (_, data: CreateProjectInput) => {
    const prepared = prepareProjectCreate(data)
    const featureRepoIntegrationEnabled = data.featureRepoIntegrationEnabled === true ? 1 : 0
    const defaultFeaturesPath = getRepoFeatureSyncConfig(db).defaultFeaturesPath || 'docs/features'
    const featureRepoFeaturesPath = normalizeRepoFeaturesPath(data.featureRepoFeaturesPath, defaultFeaturesPath)
    if (featureRepoIntegrationEnabled === 1 && !prepared.path) {
      throw new Error('Repository path is required when feature.yaml integration is enabled')
    }
    if (featureRepoIntegrationEnabled === 1 && prepared.path) {
      assertFeaturesPathInsideRepo(prepared.path, featureRepoFeaturesPath)
    }

    const stmt = db.prepare(`
      INSERT INTO projects (
        id, name, color, path, columns_config, task_backend,
        feature_repo_integration_enabled, feature_repo_features_path,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'db', ?, ?, ?, ?)
    `)
    stmt.run(
      prepared.id,
      prepared.name,
      prepared.color,
      prepared.path,
      prepared.columnsConfigJson,
      featureRepoIntegrationEnabled,
      featureRepoFeaturesPath,
      prepared.createdAt,
      prepared.updatedAt
    )

    if (featureRepoIntegrationEnabled === 1) {
      syncProjectFeatureTasks(db, prepared.id)
    }

    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(prepared.id) as Record<string, unknown> | undefined
    return parseProject(row)
  })

  ipcMain.handle('db:projects:update', (_, data: UpdateProjectInput) => {
    const current = db.prepare(`
      SELECT path, feature_repo_integration_enabled, feature_repo_features_path
      FROM projects
      WHERE id = ?
    `).get(data.id) as
      | {
          path: string | null
          feature_repo_integration_enabled: number
          feature_repo_features_path: string
        }
      | undefined

    if (!current) throw new Error('Project not found')

    const fields: string[] = []
    const values: unknown[] = []
    let normalizedColumns: ColumnConfig[] | null | undefined = undefined
    let shouldSyncFeatures = false

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
      values.push(typeof data.path === 'string' ? (data.path.trim() || null) : data.path)
      shouldSyncFeatures = true
    }
    if (data.taskBackend !== undefined) {
      // Project tasks are DB-backed only.
      fields.push('task_backend = ?')
      values.push('db')
    }
    if (data.featureRepoIntegrationEnabled !== undefined) {
      fields.push('feature_repo_integration_enabled = ?')
      values.push(data.featureRepoIntegrationEnabled ? 1 : 0)
      shouldSyncFeatures = data.featureRepoIntegrationEnabled
    }
    if (data.featureRepoFeaturesPath !== undefined) {
      fields.push('feature_repo_features_path = ?')
      values.push(
        normalizeRepoFeaturesPath(
          data.featureRepoFeaturesPath,
          getRepoFeatureSyncConfig(db).defaultFeaturesPath || 'docs/features'
        )
      )
      shouldSyncFeatures = true
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

    const nextPath =
      data.path !== undefined
        ? (typeof data.path === 'string' ? data.path.trim() || null : data.path)
        : current.path
    const nextFeaturesPath =
      data.featureRepoFeaturesPath !== undefined
        ? normalizeRepoFeaturesPath(
            data.featureRepoFeaturesPath,
            getRepoFeatureSyncConfig(db).defaultFeaturesPath || 'docs/features'
          )
        : normalizeRepoFeaturesPath(
            current.feature_repo_features_path,
            getRepoFeatureSyncConfig(db).defaultFeaturesPath || 'docs/features'
          )
    const nextFeatureIntegrationEnabled =
      data.featureRepoIntegrationEnabled !== undefined
        ? data.featureRepoIntegrationEnabled
        : current.feature_repo_integration_enabled === 1
    const shouldDetachFeatureLinks =
      current.feature_repo_integration_enabled === 1 && !nextFeatureIntegrationEnabled
    if (nextFeatureIntegrationEnabled && !nextPath) {
      throw new Error('Repository path is required when feature.yaml integration is enabled')
    }
    if (nextFeatureIntegrationEnabled && nextPath) {
      assertFeaturesPathInsideRepo(nextPath, nextFeaturesPath)
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
      }
      if (shouldDetachFeatureLinks) {
        db.prepare('DELETE FROM project_feature_task_links WHERE project_id = ?').run(data.id)
      }
    })()
    if (shouldSyncFeatures && nextFeatureIntegrationEnabled) {
      syncProjectFeatureTasks(db, data.id)
    }
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(data.id) as Record<string, unknown> | undefined
    return parseProject(row)
  })

  ipcMain.handle('db:projects:syncFeatures', (_, projectId: string) => {
    return syncProjectFeatureTasks(db, projectId)
  })

  ipcMain.handle('db:projects:syncAllFeatures', () => {
    return syncAllProjectFeatureTasks(db)
  })

  ipcMain.handle('db:projects:getFeatureSyncConfig', () => {
    return getRepoFeatureSyncConfig(db)
  })

  ipcMain.handle(
    'db:projects:setFeatureSyncConfig',
    (_, input: { defaultFeaturesPath?: string; pollIntervalSeconds?: number }) => {
      if (input.defaultFeaturesPath !== undefined) {
        const normalized = normalizeRepoFeaturesPath(input.defaultFeaturesPath, 'docs/features')
        db.prepare(
          'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
        ).run('repo_features_default_features_path', normalized)
      }
      if (input.pollIntervalSeconds !== undefined) {
        const parsed = Number.isFinite(input.pollIntervalSeconds)
          ? Math.round(input.pollIntervalSeconds)
          : 30
        const normalized = Math.min(3600, Math.max(5, parsed))
        db.prepare(
          'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
        ).run('repo_features_poll_interval_seconds', String(normalized))
      }

      return getRepoFeatureSyncConfig(db)
    }
  )

  ipcMain.handle('db:projects:delete', (_, id: string) => {
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  })
}

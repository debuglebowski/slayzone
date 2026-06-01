import type { Database } from 'better-sqlite3'
import type { ColumnConfig, WorkflowCategory } from '@slayzone/projects/shared'
import { getDefaultStatus, resolveColumns } from '@slayzone/projects/shared'

/**
 * Named-transaction adapters for the projects domain. These are the conditional
 * read-modify-write operations that can't be shipped as a static `batchTxn` op
 * list because they read a row / MAX(...) and then write based on that value
 * inside the same atomic transaction. Registered into the worker's txn registry
 * via `@slayzone/projects/db`. Each function owns its own `db.transaction(...)`,
 * so the worker invokes it directly without re-wrapping.
 *
 * Pure: imports only better-sqlite3 + the worker-safe `@slayzone/projects/shared`
 * barrel (no electron / fs side-effects), so it is safe to pull into the worker
 * bundle (unlike the electron + fs-laden `/main` handlers module).
 *
 * Returns are kept structured-cloneable (raw rows / scalars): the IPC layer
 * parses rows via `parseProject` after the call.
 */

type Row = Record<string, unknown> | undefined

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
  const tasks = db
    .prepare('SELECT id, status FROM tasks WHERE project_id = ?')
    .all(projectId) as Array<{
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
  if (
    !tableExists(db, 'integration_project_mappings') ||
    !tableExists(db, 'integration_state_mappings')
  ) {
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
    const existing = listStateMappings.all(mapping.id) as Array<{
      state_id: string
      state_type: string
    }>
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
      insertStateMapping.run(
        crypto.randomUUID(),
        mapping.id,
        row.localStatus,
        row.stateId,
        row.stateType
      )
    }
  }
}

export interface CreateProjectTxnParams {
  id: string
  name: string
  color: string
  path: string
  columnsConfigJson: string
  createdAt: string
  updatedAt: string
}

export interface UpdateProjectTxnParams {
  id: string
  /** Pre-built `UPDATE projects SET ... WHERE id = ?` (caller computed the field list). */
  sql: string
  /** Params for `sql`, ending with the project id. */
  params: unknown[]
  /**
   * Present only when `columns_config` was part of the update — drives the
   * follow-up status remap + Linear reconciliation + stale-automation cleanup.
   * `undefined` means columns were untouched; `null` means cleared to defaults.
   */
  normalizedColumns?: ColumnConfig[] | null
}

export const projectsTxns = {
  // Reads MAX(sort_order)+1, then inserts at that order — conditional, so it
  // can't be a static op list. Returns the created row for `parseProject`.
  'projects:create': (db: Database, p: CreateProjectTxnParams): Row =>
    db.transaction(() => {
      const { sort_order: nextOrder } = db
        .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM projects')
        .get() as { sort_order: number }
      const stmt = db.prepare(`
        INSERT INTO projects (id, name, color, path, columns_config, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      stmt.run(p.id, p.name, p.color, p.path, p.columnsConfigJson, nextOrder, p.createdAt, p.updatedAt)
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) as Row
    })(),

  // UPDATE projects, then (when columns changed) remap unknown task statuses,
  // reconcile Linear state mappings, and clear stale automation config — all
  // read-modify-write, all atomic. Returns the updated row for `parseProject`.
  'projects:update': (db: Database, p: UpdateProjectTxnParams): Row =>
    db.transaction(() => {
      db.prepare(p.sql).run(...p.params)
      if (p.normalizedColumns !== undefined) {
        remapUnknownTaskStatuses(db, p.id, p.normalizedColumns)
        reconcileLinearStateMappingsForProject(db, p.id, p.normalizedColumns)
        // Clear stale automation config references
        const cols = p.normalizedColumns
        if (cols) {
          const projRow = db
            .prepare('SELECT task_automation_config FROM projects WHERE id = ?')
            .get(p.id) as Record<string, unknown> | undefined
          if (projRow?.task_automation_config) {
            try {
              const cfg = JSON.parse(projRow.task_automation_config as string) as {
                on_terminal_active: string | null
                on_terminal_idle: string | null
              }
              const validIds = new Set(cols.map((c) => c.id))
              let changed = false
              if (cfg.on_terminal_active && !validIds.has(cfg.on_terminal_active)) {
                cfg.on_terminal_active = null
                changed = true
              }
              if (cfg.on_terminal_idle && !validIds.has(cfg.on_terminal_idle)) {
                cfg.on_terminal_idle = null
                changed = true
              }
              if (changed)
                db.prepare('UPDATE projects SET task_automation_config = ? WHERE id = ?').run(
                  JSON.stringify(cfg),
                  p.id
                )
            } catch {
              /* ignore parse errors */
            }
          }
        }
      }
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id) as Row
    })()
} satisfies Record<string, (db: Database, params: never) => unknown>

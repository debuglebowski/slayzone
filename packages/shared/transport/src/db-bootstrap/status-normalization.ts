import type Database from 'better-sqlite3'
import { getDefaultStatus, parseColumnsConfig, resolveColumns } from '@slayzone/projects/shared'

export function normalizeProjectStatusData(db: Database.Database): void {
  const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all() as Array<{ name: string }>
  const hasColumnsConfig = projectColumns.some((column) => column.name === 'columns_config')
  if (!hasColumnsConfig) return

  const projects = db.prepare('SELECT id, columns_config FROM projects').all() as Array<{
    id: string
    columns_config: string | null
  }>

  if (projects.length === 0) return

  const updateProjectColumns = db.prepare(
    "UPDATE projects SET columns_config = ?, updated_at = datetime('now') WHERE id = ?"
  )
  const updateTaskStatus = db.prepare(
    "UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?"
  )
  const getProjectTasks = db.prepare('SELECT id, status FROM tasks WHERE project_id = ?')

  db.transaction(() => {
    for (const project of projects) {
      const parsedColumns = parseColumnsConfig(project.columns_config)
      const resolvedColumns = resolveColumns(parsedColumns)
      const normalizedJson = JSON.stringify(resolvedColumns)

      if (
        project.columns_config &&
        (parsedColumns === null || project.columns_config !== normalizedJson)
      ) {
        // Invalid/stale JSON configs are normalized to a canonical validated payload.
        updateProjectColumns.run(normalizedJson, project.id)
      }

      const knownStatusIds = new Set(resolvedColumns.map((column) => column.id))
      const fallbackStatus = getDefaultStatus(resolvedColumns)
      const tasks = getProjectTasks.all(project.id) as Array<{ id: string; status: string }>
      for (const task of tasks) {
        if (!knownStatusIds.has(task.status)) {
          updateTaskStatus.run(fallbackStatus, task.id)
        }
      }
    }
  })()
}

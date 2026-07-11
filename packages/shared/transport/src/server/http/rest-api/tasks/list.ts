import type { Express } from 'express'
import {
  isCompletedStatus,
  parseColumnsConfig,
  resolveStatusId,
  type ColumnConfig
} from '@slayzone/projects/shared'
import type { RestApiDeps } from '../types'
import { queryString } from '../resolve'

/**
 * GET /api/tasks — list tasks with the slay CLI's filters.
 * Mirrors `slay tasks list` (packages/apps/cli/src/commands/tasks/list.ts):
 * query params `project` (id or name substring), `status` (alias-resolved
 * against the project's columns config), `done` (completed-only), `limit`
 * (default 100). Response rows use the CLI's stable `--json` contract
 * (task-json.ts): narrow column set + `is_blocked` + tag names.
 */

/** Columns of the CLI's stable TaskJson contract (cli/src/commands/task-json.ts). */
const TASK_JSON_COLUMNS =
  't.id, t.project_id, t.title, t.description, t.status, t.priority, t.due_date, t.parent_id, t.created_at, t.updated_at'

interface TaskJsonRow extends Record<string, unknown> {
  id: string
  project_id: string
  project_name: string
  title: string
  description: string | null
  status: string
  priority: number
  due_date: string | null
  parent_id: string | null
  created_at: string
  updated_at: string
}

export function registerListTasksRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/tasks', async (req, res) => {
    const project = queryString(req.query.project)
    const doneFilter = ['1', 'true'].includes(queryString(req.query.done) ?? '')
    let status = doneFilter ? undefined : queryString(req.query.status)
    const rawLimit = queryString(req.query.limit) ?? '100'
    const limit = parseInt(rawLimit, 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      res.status(400).json({ ok: false, error: `Invalid limit: ${rawLimit}` })
      return
    }

    try {
      const db = deps.db
      // Per-project columns-config cache (done-filter reads it per task row).
      const columnsCache = new Map<string, ColumnConfig[] | null>()
      const columnsFor = async (projectId: string): Promise<ColumnConfig[] | null> => {
        if (!columnsCache.has(projectId)) {
          const row = await db.get<{ columns_config: string | null }>(
            `SELECT columns_config FROM projects WHERE id = ? LIMIT 1`,
            [projectId]
          )
          columnsCache.set(projectId, parseColumnsConfig(row?.columns_config ?? null))
        }
        return columnsCache.get(projectId) ?? null
      }

      // Resolve status aliases against the target project's columns (CLI parity:
      // only when a --project narrows the board; otherwise built-in aliases only).
      if (status) {
        let listColumns: ColumnConfig[] | null = null
        if (project) {
          const row = await db.get<{ id: string }>(
            `SELECT id FROM projects WHERE id = ? OR LOWER(name) LIKE ? LIMIT 1`,
            [project, `%${project.toLowerCase()}%`]
          )
          if (row) listColumns = await columnsFor(row.id)
        }
        status = resolveStatusId(status, listColumns) ?? status
      }

      const conditions = ['t.archived_at IS NULL', 't.deleted_at IS NULL', 't.is_temporary = 0']
      const params: unknown[] = []
      if (status) {
        conditions.push('t.status = ?')
        params.push(status)
      }
      if (project) {
        conditions.push('(p.id = ? OR LOWER(p.name) LIKE ?)')
        params.push(project, `%${project.toLowerCase()}%`)
      }

      const limitClause = doneFilter ? '' : 'LIMIT ?'
      const tasks = await db.all<TaskJsonRow>(
        `SELECT ${TASK_JSON_COLUMNS}, p.name AS project_name
         FROM tasks t
         JOIN projects p ON t.project_id = p.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t."order" ASC
         ${limitClause}`,
        doneFilter ? params : [...params, limit]
      )

      let filteredTasks = tasks
      if (doneFilter) {
        const kept: TaskJsonRow[] = []
        for (const task of tasks) {
          if (isCompletedStatus(task.status, await columnsFor(task.project_id))) kept.push(task)
        }
        filteredTasks = kept.slice(0, limit)
      }

      const blockedRows = await db.all<{ id: string }>(
        `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
         UNION
         SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`
      )
      const blockedIds = new Set(blockedRows.map((r) => r.id))

      const tagMap: Record<string, string[]> = {}
      if (filteredTasks.length > 0) {
        const placeholders = filteredTasks.map(() => '?').join(', ')
        const tagRows = await db.all<{ task_id: string; name: string }>(
          `SELECT tt.task_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
           WHERE tt.task_id IN (${placeholders})`,
          filteredTasks.map((t) => t.id)
        )
        for (const r of tagRows) {
          ;(tagMap[r.task_id] ??= []).push(r.name)
        }
      }

      const data = filteredTasks.map((t) => ({
        id: t.id,
        project_id: t.project_id,
        project_name: t.project_name,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        due_date: t.due_date,
        parent_id: t.parent_id,
        created_at: t.created_at,
        updated_at: t.updated_at,
        is_blocked: blockedIds.has(t.id),
        tags: tagMap[t.id] ?? []
      }))
      res.json({ ok: true, data })
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

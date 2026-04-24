import { openDb } from '../../db'
import { TASK_JSON_COLUMNS, serializeTaskForJson, type TaskJsonRow } from '../task-json'
import { isCompletedStatus, resolveStatusId, type ColumnConfig } from '@slayzone/projects/shared'
import { getProjectColumnsConfig, printTasks } from './_shared'

export interface ListOpts {
  project?: string
  status?: string
  done?: boolean
  limit?: string
  json?: boolean
}

export async function listAction(opts: ListOpts): Promise<void> {
  const db = openDb()

  const limit = parseInt(opts.limit ?? '100', 10)
  const doneFilter = Boolean(opts.done)
  let status = doneFilter ? undefined : opts.status

  if (status) {
    let listColumns: ColumnConfig[] | null = null
    if (opts.project) {
      const row = db.query<{ id: string }>(`SELECT id FROM projects WHERE id = :proj OR LOWER(name) LIKE :projLike LIMIT 1`, {
        ':proj': opts.project, ':projLike': `%${opts.project.toLowerCase()}%`
      })[0]
      if (row) listColumns = getProjectColumnsConfig(db, row.id)
    }
    status = resolveStatusId(status, listColumns) ?? status
  }

  const conditions: string[] = ['t.archived_at IS NULL', 't.is_temporary = 0']
  const params: Record<string, string | number | null> = {}

  if (status) {
    conditions.push('t.status = :status')
    params[':status'] = status
  }

  if (opts.project) {
    conditions.push('(p.id = :proj OR LOWER(p.name) LIKE :projLike)')
    params[':proj'] = opts.project
    params[':projLike'] = `%${opts.project.toLowerCase()}%`
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const limitClause = doneFilter ? '' : 'LIMIT :limit'
  const tasks = db.query<TaskJsonRow>(
    `SELECT ${TASK_JSON_COLUMNS.join(', ')}, p.name AS project_name
     FROM tasks t
     JOIN projects p ON t.project_id = p.id
     ${where}
     ORDER BY t."order" ASC
     ${limitClause}`,
    doneFilter ? params : { ...params, ':limit': limit }
  )

  const filteredTasks = doneFilter
    ? tasks.filter((task) => {
        const projectColumns = getProjectColumnsConfig(db, task.project_id)
        return isCompletedStatus(task.status, projectColumns)
      }).slice(0, limit)
    : tasks

  // Query blocked task IDs
  const blockedRows = db.query<{ id: string }>(
    `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
     UNION
     SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`
  )
  const blockedIds = new Set(blockedRows.map((r) => r.id))

  if (opts.json) {
    // Augment with tags and due_date
    const taskIds = filteredTasks.map((t) => t.id)
    const tagMap: Record<string, string[]> = {}
    if (taskIds.length > 0) {
      const placeholders = taskIds.map((_, i) => `:t${i}`).join(', ')
      const tagParams: Record<string, string> = {}
      taskIds.forEach((id, i) => { tagParams[`:t${i}`] = id })
      const tagRows = db.query<{ task_id: string; name: string }>(
        `SELECT tt.task_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id
         WHERE tt.task_id IN (${placeholders})`,
        tagParams
      )
      for (const r of tagRows) {
        (tagMap[r.task_id] ??= []).push(r.name)
      }
    }
    const enriched = filteredTasks.map((t) =>
      serializeTaskForJson(t, {
        isBlocked: blockedIds.has(t.id),
        tags: tagMap[t.id] ?? [],
      })
    )
    console.log(JSON.stringify(enriched, null, 2))
  } else {
    printTasks(filteredTasks, blockedIds)
  }
}

import { openDb } from '../../db'
import { printTasks, resolveId, type TaskRow } from './_shared'

export interface SubtasksOpts {
  json?: boolean
}

export async function subtasksAction(idPrefix: string | undefined, opts: SubtasksOpts): Promise<void> {
  idPrefix = resolveId(idPrefix)
  const db = openDb()

  const parents = db.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id LIKE :prefix || '%' LIMIT 2`,
    { ':prefix': idPrefix }
  )

  if (parents.length === 0) { console.error(`Task not found: ${idPrefix}`); process.exit(1) }
  if (parents.length > 1) {
    console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${parents.map((t) => t.id.slice(0, 8)).join(', ')}`)
    process.exit(1)
  }

  const tasks = db.query<TaskRow>(
    `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
     FROM tasks t JOIN projects p ON t.project_id = p.id
     WHERE t.parent_id = :id AND t.archived_at IS NULL
     ORDER BY t."order" ASC`,
    { ':id': parents[0].id }
  )

  if (opts.json) {
    console.log(JSON.stringify(tasks, null, 2))
  } else {
    printTasks(tasks)
  }
}

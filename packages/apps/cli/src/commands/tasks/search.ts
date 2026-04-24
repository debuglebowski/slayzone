import { openDb } from '../../db'
import { printTasks, type TaskRow } from './_shared'

export interface SearchOpts {
  project?: string
  limit?: string
  json?: boolean
}

export async function searchAction(query: string, opts: SearchOpts): Promise<void> {
  const db = openDb()
  const q = `%${query.toLowerCase()}%`
  const limit = parseInt(opts.limit ?? '50', 10)

  const conditions: string[] = [
    't.is_temporary = 0',
    '(LOWER(t.title) LIKE :q OR LOWER(COALESCE(t.description, \'\')) LIKE :q)',
  ]
  const params: Record<string, string | number | null> = { ':q': q, ':limit': limit }

  if (opts.project) {
    conditions.push('(p.id = :proj OR LOWER(p.name) LIKE :projLike)')
    params[':proj'] = opts.project
    params[':projLike'] = `%${opts.project.toLowerCase()}%`
  }

  const tasks = db.query<TaskRow>(
    `SELECT t.id, t.title, t.status, t.priority, p.name AS project_name, t.created_at
     FROM tasks t JOIN projects p ON t.project_id = p.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.updated_at DESC LIMIT :limit`,
    params
  )

  if (opts.json) {
    console.log(JSON.stringify(tasks, null, 2))
  } else {
    printTasks(tasks)
  }
}

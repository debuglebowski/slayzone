import type { Database } from 'better-sqlite3'
import type { Task } from '@slayzone/task/shared'
import { parseProject } from '@slayzone/projects/main'
import { parseTasks } from './shared.js'

export interface BoardData {
  tasks: Task[]
  projects: ReturnType<typeof parseProject>[]
  tags: unknown[]
  taskTags: Record<string, string[]>
  blockedTaskIds: string[]
}

export function loadBoardDataOp(db: Database): BoardData {
  const taskRows = db
    .prepare(`SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.deleted_at IS NULL
      ORDER BY t."order" ASC, t.created_at DESC`)
    .all() as Record<string, unknown>[]

  const projectRows = db.prepare('SELECT * FROM projects ORDER BY sort_order').all() as Record<string, unknown>[]

  const tagRows = db.prepare('SELECT * FROM tags ORDER BY sort_order, name').all()

  const taskTagRows = db.prepare('SELECT task_id, tag_id FROM task_tags').all() as { task_id: string; tag_id: string }[]
  const taskTagMap: Record<string, string[]> = {}
  for (const row of taskTagRows) {
    if (!taskTagMap[row.task_id]) taskTagMap[row.task_id] = []
    taskTagMap[row.task_id].push(row.tag_id)
  }

  const blockedRows = db
    .prepare(`SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
      UNION
      SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`)
    .all() as { id: string }[]

  return {
    tasks: parseTasks(taskRows),
    projects: projectRows.map((row) => parseProject(row)!),
    tags: tagRows,
    taskTags: taskTagMap,
    blockedTaskIds: blockedRows.map((r) => r.id)
  }
}

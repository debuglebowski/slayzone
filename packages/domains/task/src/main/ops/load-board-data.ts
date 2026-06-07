import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { parseProject } from '@slayzone/projects/main'
import { parseAndColorTasks } from './shared.js'

export interface BoardData {
  tasks: Task[]
  projects: ReturnType<typeof parseProject>[]
  tags: unknown[]
  taskTags: Record<string, string[]>
  blockedTaskIds: string[]
}

export async function loadBoardDataOp(db: SlayzoneDb): Promise<BoardData> {
  const taskRows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.deleted_at IS NULL
      ORDER BY t."order" ASC, t.created_at DESC`
  )

  const projectRows = await db.all<Record<string, unknown>>(
    'SELECT * FROM projects ORDER BY sort_order'
  )

  const tagRows = await db.all('SELECT * FROM tags ORDER BY sort_order, name')

  const taskTagRows = await db.all<{ task_id: string; tag_id: string }>(
    'SELECT task_id, tag_id FROM task_tags'
  )
  const taskTagMap: Record<string, string[]> = {}
  for (const row of taskTagRows) {
    if (!taskTagMap[row.task_id]) taskTagMap[row.task_id] = []
    taskTagMap[row.task_id].push(row.tag_id)
  }

  const blockedRows = await db.all<{ id: string }>(
    `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies
      UNION
      SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL`
  )

  // parseAndColorTasks (not bare parseTasks) so every task carries
  // `currentConversationByMode` from the ledger. Without it the boot board store
  // ships null conversation ids → auto-respawned terminals mint fresh sessions
  // that shadow real conversations (the restart-clobber bug). Same query cost as
  // getAllTasksOp, which already hydrates on every getTasks().
  const tasks = await parseAndColorTasks(db, taskRows)

  return {
    tasks,
    projects: projectRows.map((row) => parseProject(row)!),
    tags: tagRows,
    taskTags: taskTagMap,
    blockedTaskIds: blockedRows.map((r) => r.id)
  }
}

import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task/shared'
import { parseProject } from '@slayzone/projects/server'
import { parseAndColorTasks, TASK_ORDER_BY } from './shared.js'

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
      ${TASK_ORDER_BY}`
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

/** The board rows of specific tasks — `loadBoardRowsOp`'s answer. */
export interface BoardRows {
  /** Current rows of the requested tasks that are still on the board. A
   *  requested id absent here was deleted (or never existed). */
  tasks: Task[]
  /** Tag ids per requested task; a requested task without tags is absent. */
  taskTags: Record<string, string[]>
  /** The requested tasks that are blocked (same rule as the board). */
  blockedTaskIds: string[]
  /** Per returned task, the id of the row right after it in the board's order
   *  (`TASK_ORDER_BY`; null = last), so a created or moved row can be patched in
   *  where a full reload would put it. */
  nextTaskIds: Record<string, string | null>
}

/**
 * Just the given tasks' slice of `loadBoardDataOp` — same row SQL, same
 * hydration, same blocked rule — so the renderer can patch a few changed rows
 * into its board instead of reloading every task (multi-MB) on each
 * `tasks-changed` that names its rows.
 */
export async function loadBoardRowsOp(db: SlayzoneDb, ids: readonly string[]): Promise<BoardRows> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return { tasks: [], taskTags: {}, blockedTaskIds: [], nextTaskIds: {} }
  const ph = unique.map(() => '?').join(',')
  const taskRows = await db.all<Record<string, unknown>>(
    `SELECT t.*, el.external_url AS linear_url
      FROM tasks t
      LEFT JOIN external_links el ON el.task_id = t.id AND el.provider = 'linear'
      WHERE t.deleted_at IS NULL AND t.id IN (${ph})
      ${TASK_ORDER_BY}`,
    unique
  )
  const taskTagRows = await db.all<{ task_id: string; tag_id: string }>(
    `SELECT task_id, tag_id FROM task_tags WHERE task_id IN (${ph})`,
    unique
  )
  const taskTags: Record<string, string[]> = {}
  for (const row of taskTagRows) (taskTags[row.task_id] ??= []).push(row.tag_id)
  const blockedRows = await db.all<{ id: string }>(
    `SELECT DISTINCT blocks_task_id AS id FROM task_dependencies WHERE blocks_task_id IN (${ph})
      UNION
      SELECT id FROM tasks WHERE is_blocked = 1 AND deleted_at IS NULL AND id IN (${ph})`,
    [...unique, ...unique]
  )
  // LEAD over the board's own ORDER BY, so the successor is exactly the row a
  // full load lists next — including the rowid tie-break SQL alone can see.
  const nextRows = await db.all<{ id: string; next_id: string | null }>(
    `SELECT id, next_id FROM (
       SELECT t.id, LEAD(t.id) OVER (${TASK_ORDER_BY}) AS next_id
       FROM tasks t WHERE t.deleted_at IS NULL
     ) WHERE id IN (${ph})`,
    unique
  )
  const nextTaskIds: Record<string, string | null> = {}
  for (const row of nextRows) nextTaskIds[row.id] = row.next_id
  return {
    tasks: await parseAndColorTasks(db, taskRows),
    taskTags,
    blockedTaskIds: blockedRows.map((r) => r.id),
    nextTaskIds
  }
}

import type { SlayzoneDb } from '@slayzone/platform'

/**
 * One user's open task tabs on this hub (`open_task_tabs`): the tab bar every client
 * of that user shares — desktop and iPad open, close and reorder the same list. Only
 * this hub's own tasks (a task on another hub is that hub's row), so a deleted task's
 * tab goes with it (ON DELETE CASCADE).
 *
 * `user` is the signed-in user's id, or '' on a hub without login (one person). Every
 * write reports whether it changed anything, so the router pings other clients only
 * for a real change.
 */

export async function listOpenTabs(db: SlayzoneDb, user: string): Promise<string[]> {
  const rows = await db.all<{ task_id: string }>(
    'SELECT task_id FROM open_task_tabs WHERE user_id = ? ORDER BY position, rowid',
    [user]
  )
  return rows.map((r) => r.task_id)
}

/** Adds the tab at the end; a task already open, or not on this hub, is left alone. */
export async function openTab(db: SlayzoneDb, user: string, taskId: string): Promise<boolean> {
  const { changes } = await db.run(
    `INSERT OR IGNORE INTO open_task_tabs (user_id, task_id, position)
     SELECT ?, t.id, (SELECT COALESCE(MAX(position) + 1, 0) FROM open_task_tabs WHERE user_id = ?)
       FROM tasks t WHERE t.id = ?`,
    [user, user, taskId]
  )
  return changes > 0
}

export async function closeTab(db: SlayzoneDb, user: string, taskId: string): Promise<boolean> {
  const { changes } = await db.run('DELETE FROM open_task_tabs WHERE user_id = ? AND task_id = ?', [
    user,
    taskId
  ])
  return changes > 0
}

/**
 * Puts the named open tabs in the given order, inside the slots they already take:
 * a tab not named keeps its place, an id that is not open is ignored. So a client
 * that knows only some of the tabs (one opened elsewhere a moment ago) cannot move
 * the others, and a tab opened meanwhile stays at the end.
 */
export async function reorderTabs(
  db: SlayzoneDb,
  user: string,
  taskIds: readonly string[]
): Promise<boolean> {
  const unique = [...new Set(taskIds)]
  if (unique.length < 2) return false
  const current = await db.all<{ task_id: string; position: number }>(
    `SELECT task_id, position FROM open_task_tabs
      WHERE user_id = ? AND task_id IN (${unique.map(() => '?').join(',')})`,
    [user, ...unique]
  )
  const positionOf = new Map(current.map((r) => [r.task_id, r.position]))
  const named = unique.filter((id) => positionOf.has(id))
  const slots = named.map((id) => positionOf.get(id) as number).sort((a, b) => a - b)
  const moves = named.flatMap((id, i) => (positionOf.get(id) === slots[i] ? [] : [[id, slots[i]]]))
  if (moves.length === 0) return false
  await db.batchTxn(
    moves.map(([id, position]) => ({
      type: 'run' as const,
      sql: 'UPDATE open_task_tabs SET position = ? WHERE user_id = ? AND task_id = ?',
      params: [position, user, id]
    }))
  )
  return true
}

/**
 * Hand the open tabs saved while the hub had no login (user '') to `userId`, the
 * first admin — with the unowned projects and the legacy settings
 * (`apps/hub/src/ownership-backfill.ts`). A tab they already have keeps its place.
 * Idempotent. Returns how many tabs moved.
 */
export async function adoptLegacyOpenTabs(db: SlayzoneDb, userId: string): Promise<number> {
  const [moved] = (await db.batchTxn([
    {
      type: 'run',
      sql: `INSERT OR IGNORE INTO open_task_tabs (user_id, task_id, position)
            SELECT ?, task_id, position FROM open_task_tabs WHERE user_id = ''`,
      params: [userId]
    },
    { type: 'run', sql: "DELETE FROM open_task_tabs WHERE user_id = ''", params: [] }
  ])) as { changes: number }[]
  return moved?.changes ?? 0
}

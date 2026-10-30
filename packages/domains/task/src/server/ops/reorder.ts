import type { SlayzoneDb } from '@slayzone/platform'
import type { BatchOp } from '@slayzone/platform'
import type { OpDeps } from './shared.js'

type OrderRow = { id: string; order: number | null; pinned?: number | null }

/** The listed tasks' current ordering columns, keyed by id. */
async function readOrder(
  db: SlayzoneDb,
  taskIds: readonly string[],
  column: 'order' | 'pin_order'
): Promise<Map<string, OrderRow>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db.all<OrderRow>(
    `SELECT id, "${column}" AS "order", pinned FROM tasks WHERE id IN (${taskIds.map(() => '?').join(', ')})`,
    [...taskIds]
  )
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Write the board order of `taskIds` (`order = index`). The signal names the rows
 * whose order actually changed — moving one card shifts only the cards between its
 * old and new place, so a long column is not a full board reload on every client.
 * Tasks absent from the list keep their order and are untouched.
 */
export async function reorderTasksOp(
  db: SlayzoneDb,
  taskIds: string[],
  deps: Pick<OpDeps, 'onMutation'> = {}
): Promise<void> {
  const before = await readOrder(db, taskIds, 'order')
  const ops: BatchOp[] = taskIds.map((id, index) => ({
    type: 'run',
    sql: 'UPDATE tasks SET "order" = ? WHERE id = ?',
    params: [index, id]
  }))
  await db.batchTxn(ops)
  const moved = taskIds.filter((id, index) => {
    const row = before.get(id)
    return row !== undefined && row.order !== index
  })
  if (moved.length > 0) deps.onMutation?.({ taskIds: [...new Set(moved)] })
}

/**
 * Set the complete ordered list of pinned tasks: `pinned = 1` + `pin_order =
 * index` for each id. Doubles as the bulk "pin" path (passing newly-pinned ids
 * appended to the existing list). Does not touch tasks absent from the list —
 * unpinning is a separate write (mirrors `reorderTasksOp`). Signals the rows that
 * were newly pinned or changed place.
 */
export async function reorderPinnedTasksOp(
  db: SlayzoneDb,
  taskIds: string[],
  deps: Pick<OpDeps, 'onMutation'> = {}
): Promise<void> {
  const before = await readOrder(db, taskIds, 'pin_order')
  const ops: BatchOp[] = taskIds.map((id, index) => ({
    type: 'run',
    sql: 'UPDATE tasks SET pinned = 1, pin_order = ? WHERE id = ?',
    params: [index, id]
  }))
  await db.batchTxn(ops)
  const moved = taskIds.filter((id, index) => {
    const row = before.get(id)
    return row !== undefined && (row.pinned !== 1 || row.order !== index)
  })
  if (moved.length > 0) deps.onMutation?.({ taskIds: [...new Set(moved)] })
}

import type { SlayzoneDb } from '@slayzone/platform'
import type { BatchOp } from '@slayzone/platform'

export async function reorderTasksOp(db: SlayzoneDb, taskIds: string[]): Promise<void> {
  const ops: BatchOp[] = taskIds.map((id, index) => ({
    type: 'run',
    sql: 'UPDATE tasks SET "order" = ? WHERE id = ?',
    params: [index, id]
  }))
  await db.batchTxn(ops)
}

/**
 * Set the complete ordered list of pinned tasks: `pinned = 1` + `pin_order =
 * index` for each id. Doubles as the bulk "pin" path (passing newly-pinned ids
 * appended to the existing list). Does not touch tasks absent from the list —
 * unpinning is a separate write (mirrors `reorderTasksOp`).
 */
export async function reorderPinnedTasksOp(db: SlayzoneDb, taskIds: string[]): Promise<void> {
  const ops: BatchOp[] = taskIds.map((id, index) => ({
    type: 'run',
    sql: 'UPDATE tasks SET pinned = 1, pin_order = ? WHERE id = ?',
    params: [index, id]
  }))
  await db.batchTxn(ops)
}

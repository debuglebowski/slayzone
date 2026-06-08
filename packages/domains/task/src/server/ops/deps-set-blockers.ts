import type { SlayzoneDb } from '@slayzone/platform'
import type { BatchOp } from '@slayzone/platform'

export async function setBlockersOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskIds: string[]
): Promise<void> {
  // Pure delete-then-insert with all params known up-front — atomic batch op list.
  const ops: BatchOp[] = [
    { type: 'run', sql: 'DELETE FROM task_dependencies WHERE blocks_task_id = ?', params: [taskId] },
    ...blockerTaskIds.map(
      (blockerTaskId): BatchOp => ({
        type: 'run',
        sql: 'INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)',
        params: [blockerTaskId, taskId]
      })
    )
  ]
  await db.batchTxn(ops)
}

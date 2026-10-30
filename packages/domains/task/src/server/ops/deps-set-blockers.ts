import type { SlayzoneDb } from '@slayzone/platform'
import type { BatchOp } from '@slayzone/platform'
import type { OpDeps } from './shared.js'

export async function setBlockersOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskIds: string[],
  deps: Pick<OpDeps, 'onMutation'> = {}
): Promise<void> {
  // The blockers it loses are affected too: read them before they are replaced.
  const previous = await db.all<{ task_id: string }>(
    'SELECT task_id FROM task_dependencies WHERE blocks_task_id = ?',
    [taskId]
  )
  // Pure delete-then-insert with all params known up-front — atomic batch op list.
  const ops: BatchOp[] = [
    {
      type: 'run',
      sql: 'DELETE FROM task_dependencies WHERE blocks_task_id = ?',
      params: [taskId]
    },
    ...blockerTaskIds.map(
      (blockerTaskId): BatchOp => ({
        type: 'run',
        sql: 'INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)',
        params: [blockerTaskId, taskId]
      })
    )
  ]
  await db.batchTxn(ops)
  // The task's row (its blocked flag), and every blocker it lost or gained.
  deps.onMutation?.({
    taskIds: [...new Set([taskId, ...previous.map((r) => r.task_id), ...blockerTaskIds])]
  })
}

import type { SlayzoneDb } from '@slayzone/platform'
import type { OpDeps } from './shared.js'

export async function removeBlockerOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskId: string,
  deps: Pick<OpDeps, 'onMutation'> = {}
): Promise<void> {
  await db.run('DELETE FROM task_dependencies WHERE task_id = ? AND blocks_task_id = ?', [
    blockerTaskId,
    taskId
  ])
  // The blocked task's row (its blocked flag) and the blocker's dependents changed.
  deps.onMutation?.({ taskIds: [taskId, blockerTaskId] })
}

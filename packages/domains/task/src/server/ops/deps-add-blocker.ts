import type { SlayzoneDb } from '@slayzone/platform'
import type { OpDeps } from './shared.js'

export async function addBlockerOp(
  db: SlayzoneDb,
  taskId: string,
  blockerTaskId: string,
  deps: Pick<OpDeps, 'onMutation'> = {}
): Promise<void> {
  await db.run('INSERT OR IGNORE INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)', [
    blockerTaskId,
    taskId
  ])
  // The blocked task's row (its blocked flag) and the blocker's dependents changed.
  deps.onMutation?.({ taskIds: [taskId, blockerTaskId] })
}

import type { HubClient } from '../hub-board'
import type { MovePlan } from './moves'

/**
 * A move's writes to the hub that owns the task, all at once (desktop sends its
 * `task.update` and `task.reorder` together too): the update, the full ordered list,
 * and the cleared blockers when the task left the Blocked column. Resolves when every
 * write succeeded; rejects with the first failure.
 */
export async function sendMovePlan(client: Pick<HubClient, 'task'>, plan: MovePlan): Promise<void> {
  const writes: Promise<unknown>[] = []
  if (plan.update) writes.push(client.task.update.mutate(plan.update))
  if (plan.reorder) writes.push(client.task.reorder.mutate({ taskIds: plan.reorder }))
  if (plan.clearBlockers) {
    writes.push(client.task.setBlockers.mutate({ taskId: plan.taskId, blockerTaskIds: [] }))
  }
  await Promise.all(writes)
}

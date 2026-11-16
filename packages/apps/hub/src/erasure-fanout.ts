/**
 * The hub's erasure fan-out to one computer: one `task.erase` per task. One task
 * the computer cannot erase yet (a damaged archive, a lease) is recorded and the
 * other tasks are still erased and acknowledged. Only an unreachable computer
 * stops the fan-out, and the replies already received are still returned: the
 * erasure engine acknowledges per task (content-erasure `run()`).
 */
import { isComputerUnreachable } from '@slayzone/chat-runtime/hub'
import type { FaultLedger } from '@slayzone/platform/isolation'
import { forEachIsolated } from '@slayzone/platform/isolation'

export interface ErasureReply {
  taskId: string
  revision: number
  erased: true
}

export async function eraseTasksOnComputer(deps: {
  taskIds: readonly string[]
  /** The task's committed deletion revision; null = its deletion fence is missing. */
  revisionOf(taskId: string): Promise<number | null>
  erase(taskId: string, revision: number): Promise<ErasureReply>
  ledger?: FaultLedger
}): Promise<ErasureReply[]> {
  const replies: ErasureReply[] = []
  try {
    await forEachIsolated(
      deps.taskIds,
      {
        pass: 'hub-erasure-fanout',
        key: (taskId) => taskId,
        taskId: (taskId) => taskId,
        ledger: deps.ledger,
        // Erasure is the user's request: always try every task, never back off.
        ignoreGate: true,
        isFatal: isComputerUnreachable
      },
      async (taskId) => {
        const revision = await deps.revisionOf(taskId)
        if (revision == null) throw new Error('DELETION_FENCE_MISSING')
        replies.push(await deps.erase(taskId, revision))
      }
    )
  } catch (error) {
    if (!isComputerUnreachable(error)) throw error
    // Unreachable mid-way: keep what was erased; the engine retries the rest.
  }
  return replies
}

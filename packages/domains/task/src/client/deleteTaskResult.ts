import { toast } from '@slayzone/ui'

/**
 * What `task.delete` answers: `true` erased, `false` nothing deleted, `blocked` refused
 * (the task is linked to an external provider), `incomplete` deleted but some stored
 * data (e.g. copies on a computer) is not erased yet.
 */
export type DeleteTaskMutationResult =
  | boolean
  | { blocked: true; reason?: string }
  | {
      incomplete: true
      erasure: { computers: ReadonlyArray<{ name: string; deleted: boolean }> }
    }

/** The task was NOT deleted, and the user was already told why. */
export class TaskNotDeletedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskNotDeletedError'
  }
}

/**
 * Tells the user how a single-task delete ended. Throws `TaskNotDeletedError` when
 * the task still exists, so a caller only removes it from view (or closes its
 * window) after this returns.
 */
export function settleDeleteTaskResult(result: DeleteTaskMutationResult): void {
  if (typeof result === 'object' && 'blocked' in result) {
    toast.error('Unlink this task from its external provider before deleting it.')
    throw new TaskNotDeletedError('Task is linked to an external provider.')
  }
  if (result === false) {
    toast.error('Task was not deleted.')
    throw new TaskNotDeletedError('Task was not deleted.')
  }
  if (typeof result === 'object' && 'incomplete' in result) {
    const computers = result.erasure.computers
      .filter((computer) => !computer.deleted)
      .map((computer) => computer.name)
    toast.warning(
      computers.length
        ? `Data on ${computers.join(', ')} has not been deleted yet.`
        : 'Some data has not been deleted. Cleanup will retry.'
    )
  } else toast.success('Task permanently deleted.')
}

/** Reports a failed delete, unless `settleDeleteTaskResult` already did. */
export function reportDeleteTaskError(error: unknown): void {
  if (error instanceof TaskNotDeletedError) return
  toast.error(`Couldn't delete task: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * One read of a task's computer-only data (robustness plan §9): straight from the
 * computer holding it over the direct link when a `task` grant is available, else
 * through the hub relay. Both paths answer the same shape (the chat-runtime
 * `TaskDataResult`): the hub has no copy, so an offline computer is an answer
 * (`computer-offline`), never an error.
 *
 * A grant that ended or a dead socket falls back to the hub; an answer the computer
 * gave (it ran the read and failed) stands.
 *
 * @module transport/client/direct-task-data
 */
import { directCallFailure, withDirectDeadline } from './direct-call'
import type { DirectLinkManager } from './direct-link'

/** Structurally the chat-runtime `TaskDataResult` (this package does not import it). */
export type TaskDataReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: 'computer-offline' }

export async function readTaskData<T>(opts: {
  /** This hub's direct-link manager; null: the client uses the relay only. */
  manager: DirectLinkManager | null
  taskId: string
  request: unknown
  /** The same read through the hub (its tRPC procedure). */
  relay: () => Promise<TaskDataReadResult<T>>
}): Promise<TaskDataReadResult<T>> {
  const lease = opts.manager
    ? await opts.manager.acquire({ kind: 'task', taskId: opts.taskId }).catch(() => null)
    : null
  if (lease) {
    try {
      const value = (await withDirectDeadline(
        lease.client.task.read.query({ taskId: opts.taskId, request: opts.request })
      )) as T
      return { ok: true, value }
    } catch (error) {
      if (directCallFailure(error) === 'answered') throw error
    } finally {
      lease.release()
    }
  }
  return opts.relay()
}

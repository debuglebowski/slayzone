/**
 * Task data through the hub relay (robustness plan §9, P0).
 *
 * A task's computer-only data lives only on the computer holding it. A client reads it
 * over the direct link (a `task` grant) or, when that is unavailable, through here:
 * the hub hands the computer whatever it still held of the task (`flushTask`), then
 * relays the read. The hub keeps no copy, so with that computer not connected the
 * answer is `computer-offline` — never an error, and never a stale hub answer.
 *
 * @module hub/computer-task-data
 */
import {
  TASK_DATA_COMPUTER_OFFLINE,
  type TaskDataRequest,
  type TaskDataResult,
  taskDataRequestSchema
} from '@slayzone/chat-runtime/shared'

export interface ComputerTaskDataRelayDeps {
  /** The computer holding the task's data (`ComputerDataHandoff.target`), or null. */
  target(taskId: string): Promise<string | null>
  /** Whether that computer is connected and usable now. */
  usable(computerId: string): boolean
  /** Deliver the hub's remaining rows of the task there first. */
  flushTask(taskId: string, computerId: string): Promise<void>
  /** A `chat.request` to the computer. */
  request(computerId: string, request: unknown): Promise<unknown>
}

export function createComputerTaskDataRelay(deps: ComputerTaskDataRelayDeps) {
  return {
    async read<T = unknown>(taskId: string, raw: TaskDataRequest): Promise<TaskDataResult<T>> {
      const request = taskDataRequestSchema.parse(raw)
      const computerId = await deps.target(taskId)
      if (computerId === null || !deps.usable(computerId)) return TASK_DATA_COMPUTER_OFFLINE
      await deps.flushTask(taskId, computerId)
      const value = (await deps.request(computerId, { kind: 'taskData', taskId, request })) as T
      return { ok: true, value }
    }
  }
}

export type ComputerTaskDataRelay = ReturnType<typeof createComputerTaskDataRelay>

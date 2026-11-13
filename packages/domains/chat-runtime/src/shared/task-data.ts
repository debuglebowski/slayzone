/**
 * Computer-only task data (robustness plan §9, P0): the wire shapes of
 *
 *  - **handoff** (`data.import`): the hub delivers the rows it still holds of data
 *    that belongs to the computer owning their task, once; the computer is the only
 *    copy afterwards;
 *  - **task data** (`taskData`): an app reads (and later writes) that data on the
 *    computer, over the direct link or through the hub relay — the same request and
 *    answer either way.
 *
 * Kinds are added per moved datum; each names its own value schema. Import-light
 * (zod only): the shapes reach the hub, the computer and clients.
 *
 * @module chat-runtime/shared/task-data
 */
import { z } from 'zod'

const id = z.string().min(1).max(500)

/** One handed-off item: a stable key within its kind, the task it belongs to, its value. */
export const dataImportItemSchema = z.object({
  key: id,
  taskId: id,
  value: z.unknown()
})
export type DataImportItem = z.infer<typeof dataImportItemSchema>

/** Largest batch the hub sends in one `data.import`. */
export const DATA_IMPORT_MAX_ITEMS = 200

export const dataImportRequestSchema = z.object({
  kind: z.string().min(1).max(100),
  items: z.array(dataImportItemSchema).min(1).max(DATA_IMPORT_MAX_ITEMS)
})
export type DataImportRequest = z.infer<typeof dataImportRequestSchema>

/**
 * What the computer did with each item of a batch. The hub forgets `applied` and
 * `skipped` (the item's task is deleted here: nothing to keep) and quarantines
 * `rejected` (its value is invalid: retrying cannot help until it changes).
 */
export const dataImportResultSchema = z.object({
  applied: z.array(id),
  skipped: z.array(id),
  rejected: z.array(z.object({ key: id, message: z.string().max(2000) }))
})
export type DataImportResult = z.infer<typeof dataImportResultSchema>

/** A read of one task's computer-only data. Kinds grow per moved datum. */
export const taskDataRequestSchema = z.discriminatedUnion('kind', [
  /** Where the task's data lives: the computer, its chat store, the task's lifecycle there. */
  z.object({ kind: z.literal('describe') }),
  /**
   * The task's configuration of one mode, as this computer holds it: chat settings
   * and the chat session id are only here (robustness plan §9, decision 2).
   */
  z.object({ kind: z.literal('providerConfig'), mode: z.string().min(1).max(200) }),
  /**
   * The task's worktree path and base dir as this computer holds them (task-paths;
   * robustness plan §9, P0, Phase 7a): a `TaskPathRow`, or null.
   */
  z.object({ kind: z.literal('taskPath') })
])
export type TaskDataRequest = z.infer<typeof taskDataRequestSchema>

export interface TaskDataDescription {
  computerId: string
  storeId: string
  lifecycle: 'active' | 'paused' | 'deleted'
}

/**
 * The answer to a task-data request. `unavailable`: the computer holding the task's
 * data is not connected. That is an answer, never an error: the hub keeps no copy, so
 * the app shows the task's data as unavailable until the computer is back.
 */
export type TaskDataResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; unavailable: 'computer-offline' }

export const TASK_DATA_COMPUTER_OFFLINE: TaskDataResult<never> = {
  ok: false,
  unavailable: 'computer-offline'
}

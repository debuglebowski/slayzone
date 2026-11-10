/**
 * The computer's side of computer-only task data (robustness plan §9, P0):
 *
 *  - `importBatch`: one `data.import` from the hub. Each kind validates its items and
 *    upserts them by stable key in ONE transaction, never overwriting a newer local
 *    row, so a batch delivered twice (its acknowledgement lost) changes nothing. An
 *    item of a task deleted here is skipped (nothing to keep); an invalid value or an
 *    unknown kind is rejected for the hub to quarantine — never thrown, so one bad
 *    item never blocks its batch. Each item applies in its own savepoint: one whose
 *    apply throws (a malformed local row, a conversation deleted or owned elsewhere,
 *    a row of another task) is rejected the same way and its writes roll back; only
 *    a broken or busy database fails the whole batch (the hub retries it).
 *  - `read`: a task-data request, from a direct-link client or relayed by the hub.
 *
 * @module chat-runtime/server/task-data
 */
import { isStorageFatal } from '@slayzone/platform/isolation'
import type { z } from 'zod'
import {
  type DataImportResult,
  dataImportRequestSchema,
  type TaskDataDescription,
  taskDataRequestSchema
} from '../shared/task-data'
import type { ChatStorage } from './storage'

export interface DataImportKind<T = unknown> {
  /** The item's value. One that does not parse is rejected. */
  value: z.ZodType<T>
  /**
   * Upsert by `item.key`, keeping a newer local row. Runs in its own savepoint
   * inside the batch's transaction: throwing rejects only this item (the hub
   * quarantines it until its row changes) and undoes its writes; the batch's other
   * items still apply. Only a broken or busy database fails the whole batch.
   */
  apply(storage: ChatStorage, item: { key: string; taskId: string; value: T }): void
}

// biome-ignore lint/suspicious/noExplicitAny: each kind narrows its own value type.
export type DataImportKinds = Readonly<Record<string, DataImportKind<any>>>

/** The database is locked by another writer: transient, the batch is retried later. */
function isStorageBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error)
  return (text || 'Import failed').slice(0, 2000)
}

export function createComputerTaskData(opts: {
  storage: ChatStorage
  computerId: string
  imports?: DataImportKinds
  /** One (task, mode) configuration as this computer holds it. */
  providerConfig(taskId: string, mode: string): unknown
  /** The task's worktree path and base dir on this computer (task-paths.ts), or null. */
  taskPath?(taskId: string): unknown
}) {
  const imports: DataImportKinds = opts.imports ?? {}
  return {
    importBatch(raw: unknown): DataImportResult {
      const request = dataImportRequestSchema.parse(raw)
      const result: DataImportResult = { applied: [], skipped: [], rejected: [] }
      const kind = Object.hasOwn(imports, request.kind) ? imports[request.kind] : undefined
      if (!kind) {
        for (const item of request.items)
          result.rejected.push({ key: item.key, message: `Unknown data kind: ${request.kind}` })
        return result
      }
      const valid: Array<{ key: string; taskId: string; value: unknown }> = []
      for (const item of request.items) {
        if (opts.storage.taskLifecycle(item.taskId).state === 'deleted') {
          result.skipped.push(item.key)
          continue
        }
        const parsed = kind.value.safeParse(item.value)
        if (!parsed.success) {
          result.rejected.push({ key: item.key, message: parsed.error.message.slice(0, 2000) })
          continue
        }
        valid.push({ key: item.key, taskId: item.taskId, value: parsed.data })
      }
      opts.storage.transaction(() => {
        for (const item of valid) {
          try {
            // A savepoint per item: a failing item's own writes roll back, the
            // batch's other items still apply (one bad item never blocks a task).
            opts.storage.transaction(() => kind.apply(opts.storage, item))
            result.applied.push(item.key)
          } catch (error) {
            // The machine's disk or database is broken: no item can succeed here.
            // The whole batch fails and the hub retries it later.
            if (isStorageFatal(error) || isStorageBusy(error)) throw error
            result.rejected.push({ key: item.key, message: errorMessage(error) })
          }
        }
      })
      return result
    },

    read(taskId: string, raw: unknown): unknown {
      const request = taskDataRequestSchema.parse(raw)
      switch (request.kind) {
        case 'describe':
          return {
            computerId: opts.computerId,
            storeId: opts.storage.storeId(),
            lifecycle: opts.storage.taskLifecycle(taskId).state
          } satisfies TaskDataDescription
        case 'providerConfig':
          return opts.providerConfig(taskId, request.mode)
        case 'taskPath':
          return opts.taskPath?.(taskId) ?? null
      }
    }
  }
}

export type ComputerTaskData = ReturnType<typeof createComputerTaskData>

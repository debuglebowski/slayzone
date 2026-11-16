/** Worker-local maintenance composition; host process quiescence is an explicit lease. */
import { createChatRetention } from './retention'
import { createChatBlobBackfill } from './chat-blob-backfill'
import { createStorageCompaction } from './storage-compaction'
import type { ChatOwnership } from '../shared'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ComputerChatRuntimeOptions } from './computer-runtime'

export function createChatStoreJobs(
  services: ChatStoreServices,
  opts: ComputerChatRuntimeOptions,
  hooks: {
    quiesce(
      owner: ChatOwnership
    ): Promise<false | { resume(): Promise<void>; release(): Promise<void> }>
    changed(tabId: string): void
  }
) {
  const storage = services.storage
  const leases = new Map<string, { resume(): Promise<void>; release(): Promise<void> }>()
  const retention = createChatRetention({
    storage,
    local: services.local,
    automatic: !opts.maintenance,
    busy: () => false, // Host admission is held by quiesce's lease for the whole native pass.
    quiesce: async (tabId) => {
      const owner = storage.forTab(tabId)
      if (!owner) return false
      const lease = await hooks.quiesce(owner)
      if (!lease) return false
      leases.set(tabId, lease)
      return () => lease.resume()
    },
    releaseQuiesced: async (tabId) => {
      const lease = leases.get(tabId)
      leases.delete(tabId)
      await lease?.release()
    },
    collectGarbage: () => {
      services.attachments.collectGarbage()
      services.artifacts.collectGarbage()
    },
    changed: hooks.changed
  })
  const blobBackfill = createChatBlobBackfill({
    ...opts.blobBackfill,
    storage,
    automatic: opts.blobBackfill?.automatic ?? !opts.maintenance,
    ...(opts.log ? { log: opts.log } : {}),
    withQuiesced: (owner, work, options) => retention.withQuiesced(owner, work, options),
    pruning: (id) => retention.isPruning(id),
    changed: hooks.changed
  })
  const compaction = createStorageCompaction({
    automaticReclaim: !opts.maintenance,
    ...opts.compaction,
    storage,
    backfillDone: () => blobBackfill.done(),
    ...(opts.log ? { log: opts.log } : {})
  })
  storage.onTaskPurge(() => compaction.abort('Content was erased during compaction; start again'))
  let stopping: Promise<void> | null = null
  function stop() {
    return (stopping ??= (async () => {
      const errors: unknown[] = []
      for (const work of [
        () => compaction.close(),
        () => blobBackfill.close(),
        () => services.markerBackfill.close(),
        () => retention.close(),
        () => services.backups.close()
      ]) {
        try {
          await work()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length)
        throw new AggregateError(errors, 'Chat store maintenance cleanup failed', {
          cause: errors[0]
        })
    })())
  }
  return { retention, blobBackfill, compaction, stop, closing: () => !!stopping }
}
export type ChatStoreJobs = ReturnType<typeof createChatStoreJobs>

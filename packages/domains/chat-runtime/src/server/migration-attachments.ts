import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { BlobStore } from '@slayzone/task-artifacts/storage'
import type { HubChatOwnership } from './hub-ownership'
import type { MigrationAttachmentScope } from './migration-attachment-txns'
import type {} from './migration-attachment-txns'
import type {} from '@slayzone/task-artifacts/db'

type GcResult = { deletedBlobs: number; deferred: boolean }
const collectors = new WeakMap<SlayzoneDb, { collect(): Promise<GcResult> }>()
function migrationCollector(db: SlayzoneDb, dataRoot: string) {
  const prior = collectors.get(db)
  if (prior) return prior
  let pending: Promise<GcResult> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false
  function schedule(delay: number) {
    if (closed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void collect()
    }, delay)
    timer.unref()
  }
  function collect(): Promise<GcResult> {
    if (pending) return pending
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    let retry = false
    pending = (async () => {
      if (!(await db.get('SELECT 1 FROM artifact_blob_gc_pending WHERE id=1')))
        return { deletedBlobs: 0, deferred: false }
      // Older staged destinations may not yet have re-established frozen pins.
      // Let authenticated ownership recovery prove those references before GC.
      if (
        await db.get(`SELECT 1 FROM chat_ownership o WHERE o.computer_id IS NULL AND o.state IN ('copying','verified')
        AND NOT EXISTS(SELECT 1 FROM artifact_blob_pins p WHERE p.scope='legacy-chat-migration' AND p.owner_id=o.id AND p.token=o.migration_id AND p.owner_epoch=o.epoch) LIMIT 1`)
      ) {
        retry = true
        return { deletedBlobs: 0, deferred: true }
      }
      const result = await db.namedTxn('task-artifacts:blobs:collect', { dataDir: dataRoot })
      retry =
        result.deferred || !!(await db.get('SELECT 1 FROM artifact_blob_gc_pending WHERE id=1'))
      return { ...result, deferred: retry }
    })()
      .catch((error: unknown) => {
        closed = /database.*(?:not open|closed)/i.test(String(error))
        retry = !closed
        return { deletedBlobs: 0, deferred: true }
      })
      .finally(() => {
        pending = undefined
        schedule(retry ? 5000 : 30000)
      })
    return pending
  }
  const result = { collect }
  collectors.set(db, result)
  void collect()
  return result
}

export function createChatMigrationAttachmentReader(db: SlayzoneDb, dataRoot: string) {
  const blobs = new BlobStore(dataRoot)
  const collector = migrationCollector(db, dataRoot)
  const read = async (
    scope: MigrationAttachmentScope,
    ref: ChatAttachment
  ): Promise<Uint8Array> => {
    const pin = await db.namedTxn('chat-migration:read-attachment-pin', { scope, ref })
    const bytes = blobs.read(pin.hash)
    if (bytes.length !== pin.size) throw new Error('Migration attachment size integrity failure')
    return bytes
  }
  return Object.assign(read, { collectGarbage: collector.collect })
}

export async function migrationAttachmentScope(
  db: SlayzoneDb,
  owner: HubChatOwnership,
  migrationId?: string
): Promise<MigrationAttachmentScope> {
  const token =
    migrationId ??
    owner.migrationId ??
    (
      await db.get<{ migration_id: string }>('SELECT migration_id FROM chat_ownership WHERE id=?', [
        owner.id
      ])
    )?.migration_id
  if (!token) throw new Error('Migration attachment ownership has no migration token')
  return {
    id: owner.id,
    taskId: owner.taskId,
    tabId: owner.tabId,
    mode: owner.mode,
    epoch: owner.epoch,
    migrationId: token
  }
}

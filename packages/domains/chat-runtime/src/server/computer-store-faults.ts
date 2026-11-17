/** Store quarantine and native fault ledger stay with their owner. */
import { existsSync } from 'node:fs'
import { listQuarantine, restoreQuarantine, discardQuarantine } from '@slayzone/platform/quarantine'
import type { ItemFaultRef, ComputerFaultSnapshot } from '@slayzone/computers/shared'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ChatStoreJobs } from './computer-chat-store-jobs'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function createChatStoreFaults(
  r: Pick<ChatStoreServices, 'storage' | 'backups' | 'artifacts'> & Pick<ChatStoreJobs, 'retention'>
) {
  const root = (key: string) => {
    const [tag, id] = key.split(':', 2)
    const entry =
      tag === 'store' && id ? listQuarantine(r.storage.dir).find((e) => e.id === id) : null
    if (!entry) throw new Error('No such quarantined item')
    return entry
  }
  return {
    list(): ComputerFaultSnapshot {
      const ledger = r.storage.listFaults().map((row) => ({
        source: 'ledger' as const,
        pass: row.pass,
        key: row.item_key,
        taskId: row.task_id,
        kind: row.kind,
        message: row.message,
        attempts: row.attempts,
        firstAt: row.first_at,
        lastAt: row.last_at,
        retryable: true,
        discardable: row.pass === 'chat-archive-index' || row.pass === 'chat-archive-erasure'
      }))
      const quarantined = listQuarantine(r.storage.dir).map((entry) => ({
        source: 'quarantine' as const,
        pass: entry.pass,
        key: `store:${entry.id}`,
        taskId: entry.meta?.taskId ?? null,
        kind: 'structural' as const,
        message: entry.meta?.reason ?? 'Unreadable item set aside',
        attempts: 1,
        firstAt: entry.meta?.at ?? 0,
        lastAt: entry.meta?.at ?? 0,
        retryable: !!entry.meta && !existsSync(entry.meta.originalPath),
        discardable: true
      }))
      return { faults: [...quarantined, ...ledger] }
    },
    retry(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>) {
      if (ref.source === 'quarantine') {
        const entry = root(ref.key)
        if (!restoreQuarantine(r.storage.dir, entry.pass, entry.id))
          throw new Error('Something new already exists where this item came from')
        return
      }
      if (!r.storage.retryFault(ref.pass, ref.key)) throw new Error('No such fault')
      if (ref.pass === 'computer.task-file-cleanup') r.artifacts.cleanupDeletedTasks()
      else if (ref.pass === 'computer.chat-retention')
        void r.retention
          .runNow()
          .catch((error) => console.error('[chat-retention] retry failed:', error))
    },
    async discard(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>) {
      if (ref.source === 'quarantine') {
        const entry = root(ref.key)
        discardQuarantine(r.storage.dir, entry.pass, entry.id)
        return
      }
      if (!['chat-archive-index', 'chat-archive-erasure'].includes(ref.pass) || !UUID.test(ref.key))
        throw new Error('This item cannot be discarded; use Retry')
      await r.backups.discardArchive(ref.key, () => {
        r.storage.deleteFault(ref.pass, ref.key)
      })
    }
  }
}

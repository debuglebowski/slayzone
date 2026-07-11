import type { SlayzoneDb } from '@slayzone/platform'
import { listChatQueue, removeChatQueueItem, clearChatQueue } from '../chat-queue-store'
import type { QueuedChatMessage } from '../../shared/types'

/**
 * Data seam for the chat-queue runtime (hub/runner split, wave 1). The drain
 * loop + queue ops in `chat-queue-handlers.ts` consume this interface instead
 * of touching the DB directly, so an exec-side runner can be handed a remote
 * implementation later. `createDbChatQueueData` is the default (hub-side)
 * implementation — it runs the exact same SQL as before via the existing
 * `chat-queue-store.ts` functions and `db.namedTxn` registrations.
 */
export interface ChatQueueData {
  /** All queued messages for a tab, position ASC. */
  list(tabId: string): Promise<QueuedChatMessage[]>
  /** Append at tail (atomic MAX(position)+1 insert) and return the stored row. */
  push(tabId: string, send: string, original: string): Promise<QueuedChatMessage>
  /** Atomic pop of the queue head (select+delete in one txn); null when empty. */
  pop(tabId: string): Promise<QueuedChatMessage | null>
  /** Re-insert a popped message at head (send failed; next drain retries). */
  requeue(msg: QueuedChatMessage): Promise<void>
  /** Delete one item by id; true when a row was removed. */
  remove(id: string): Promise<boolean>
  /** Delete all items for a tab; returns the number of rows removed. */
  clear(tabId: string): Promise<number>
  /** Owning tab of a queue item (read before remove for the change broadcast). */
  getTabIdForItem(id: string): Promise<string | null>
}

/** Default local-DB implementation — same SQL/txns as the pre-seam code. */
export function createDbChatQueueData(db: SlayzoneDb): ChatQueueData {
  return {
    list: (tabId) => listChatQueue(db, tabId),

    push: (tabId, send, original) => db.namedTxn('chat-queue:push', { tabId, send, original }),

    pop: (tabId) => db.namedTxn('chat-queue:pop', { tabId }),

    requeue: async (msg) => {
      await db.namedTxn('chat-queue:requeue', { msg })
    },

    remove: (id) => removeChatQueueItem(db, id),

    clear: (tabId) => clearChatQueue(db, tabId),

    getTabIdForItem: async (id) => {
      const row = (await db.prepare('SELECT tab_id FROM chat_queue WHERE id = ?').get(id)) as
        | { tab_id: string }
        | undefined
      return row ? row.tab_id : null
    }
  }
}

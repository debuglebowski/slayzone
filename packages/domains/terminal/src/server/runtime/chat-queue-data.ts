import type { SlayzoneDb } from '@slayzone/platform'
import {
  listChatQueue,
  removeChatQueueItem,
  clearChatQueue,
  updateChatQueueItem
} from '../chat-queue-store'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
// Loads the TxnRegistry augmentation that types this file's `db.namedTxn` calls.
import type {} from '../chat-queue-txns'

/**
 * Data seam for the chat-queue runtime (hub/computer split, wave 1). The drain
 * loop + queue ops in `chat-queue-handlers.ts` consume this interface instead
 * of touching the DB directly, so an exec-side computer can be handed a remote
 * implementation later. `createDbChatQueueData` is the default (hub-side)
 * implementation — it runs the exact same SQL as before via the existing
 * `chat-queue-store.ts` functions and `db.namedTxn` registrations.
 */
export interface ChatQueueData {
  /** All queued messages for a tab, position ASC. */
  list(tabId: string): Promise<QueuedChatMessage[]>
  /** Append at tail (atomic MAX(position)+1 insert) and return the stored row. */
  push(
    tabId: string,
    send: string,
    original: string,
    opts?: { id?: string; content?: UserContentBlock[] }
  ): Promise<QueuedChatMessage>
  /** Atomic pop of the queue head (select+delete in one txn); null when empty or the head is held. */
  pop(tabId: string, heldIds?: string[]): Promise<QueuedChatMessage | null>
  /** Rewrite an item (an edit); false when it is gone. */
  update(
    id: string,
    next: { send: string; original: string; content: UserContentBlock[] }
  ): Promise<boolean>
  /** Move an item to `toIndex` in its tab's order; false when it is gone. */
  move(id: string, toIndex: number): Promise<boolean>
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

    push: (tabId, send, original, opts) =>
      db.namedTxn('chat-queue:push', { tabId, send, original, ...opts }),

    pop: (tabId, heldIds) =>
      db.namedTxn('chat-queue:pop', heldIds && heldIds.length > 0 ? { tabId, heldIds } : { tabId }),

    update: (id, next) => updateChatQueueItem(db, id, next),

    move: (id, toIndex) => db.namedTxn('chat-queue:move', { id, toIndex }),

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

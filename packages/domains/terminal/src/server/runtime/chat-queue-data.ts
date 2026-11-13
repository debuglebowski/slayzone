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
import {
  LegacyChatStorageRetiredError,
  legacyChatTables
} from '@slayzone/platform/legacy-chat-tables'

export interface QueueAdmission {
  key: string
  token: string
  expiresAt: number
}
export interface ChatQueueAdmissions {
  /** Reserve order before async file admission; no user content is stored here. */
  reserve(tabId: string, id: string, key: string, inputHash?: string): Promise<QueueAdmission>
  renewReservation(
    tabId: string,
    admission: Pick<QueueAdmission, 'key' | 'token'>
  ): Promise<QueueAdmission>
  cancelReservation(tabId: string, admission: Pick<QueueAdmission, 'key' | 'token'>): Promise<void>
}
export interface ChatQueuePushOptions {
  id?: string
  content?: UserContentBlock[]
  expectedConversationId?: string
  expectedMode?: string
  admission?: Pick<QueueAdmission, 'key' | 'token'>
  /** Data-adapter only: original blocks before asynchronous attachment sealing. */
  submittedContent?: UserContentBlock[]
}

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
  /** Recover a prior durable acceptance before attachment admission/transfer. */
  replay?(
    tabId: string,
    send: string,
    original: string,
    opts: ChatQueuePushOptions
  ): Promise<QueuedChatMessage | null>
  /** Append at tail (atomic MAX(position)+1 insert) and return the stored row. */
  push(
    tabId: string,
    send: string,
    original: string,
    opts?: ChatQueuePushOptions
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
  // The hub's legacy queue table is dropped once every chat migrated (robustness
  // plan §9 Phase 8): reads find nothing, writes are refused.
  const writable = async (what: string) => {
    if (!(await legacyChatTables(db))) throw new LegacyChatStorageRetiredError(what)
  }
  return {
    list: (tabId) => listChatQueue(db, tabId),

    push: async (tabId, send, original, opts) => {
      await writable('queued chat message')
      return db.namedTxn('chat-queue:push', { tabId, send, original, ...opts })
    },

    pop: async (tabId, heldIds) =>
      (await legacyChatTables(db))
        ? db.namedTxn(
            'chat-queue:pop',
            heldIds && heldIds.length > 0 ? { tabId, heldIds } : { tabId }
          )
        : null,

    update: (id, next) => updateChatQueueItem(db, id, next),

    move: async (id, toIndex) =>
      (await legacyChatTables(db)) ? db.namedTxn('chat-queue:move', { id, toIndex }) : false,

    requeue: async (msg) => {
      await writable('queued chat message')
      await db.namedTxn('chat-queue:requeue', { msg })
    },

    remove: (id) => removeChatQueueItem(db, id),

    clear: (tabId) => clearChatQueue(db, tabId),

    getTabIdForItem: async (id) => {
      if (!(await legacyChatTables(db))) return null
      const row = (await db.prepare('SELECT tab_id FROM chat_queue WHERE id = ?').get(id)) as
        | { tab_id: string }
        | undefined
      return row ? row.tab_id : null
    }
  }
}

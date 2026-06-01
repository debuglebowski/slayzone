import type { Database } from 'better-sqlite3'
import type { QueuedChatMessage } from '../shared/types'
import { pushChatQueue, popChatQueueHead, requeueAtHead } from './chat-queue-store'

/**
 * Named-transaction adapters for the chat queue. These are the conditional
 * read-modify-write operations (read MAX(position) then insert; atomic
 * select-then-delete) that can't be expressed as a static op list — they must
 * run as a single function inside the DB worker. Registered into the worker's
 * txn registry via `@slayzone/terminal/db`. Each underlying store function owns
 * its own `db.transaction(...)`, so the worker does NOT re-wrap these.
 *
 * Pure: imports only better-sqlite3 + shared types, so it is safe to pull into
 * the worker bundle (unlike the node-pty-laden `/main` barrel).
 */
export const chatQueueTxns = {
  'chat-queue:push': (db: Database, p: { tabId: string; send: string; original: string }) =>
    pushChatQueue(db, p.tabId, p.send, p.original),
  'chat-queue:pop': (db: Database, p: { tabId: string }) => popChatQueueHead(db, p.tabId),
  'chat-queue:requeue': (db: Database, p: { msg: QueuedChatMessage }) => {
    requeueAtHead(db, p.msg)
    return null
  }
} satisfies Record<string, (db: Database, params: never) => unknown>

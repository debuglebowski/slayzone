import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'
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
  'chat-queue:push': (
    db: Database,
    p: { tabId: string; send: string; original: string; id?: string; content?: UserContentBlock[] }
  ) => pushChatQueue(db, p.tabId, p.send, p.original, { id: p.id, content: p.content }),
  'chat-queue:pop': (db: Database, p: { tabId: string }) => popChatQueueHead(db, p.tabId),
  'chat-queue:requeue': (db: Database, p: { msg: QueuedChatMessage }) => {
    requeueAtHead(db, p.msg)
    return null
  }
}

// Types `db.namedTxn(...)` for these names. Every file that calls one imports this
// module (`import type {} from ...`), so any program that checks the call also loads
// this augmentation — see `TxnRegistry` in @slayzone/platform.
declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof chatQueueTxns> {}
}

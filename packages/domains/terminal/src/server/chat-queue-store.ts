import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { QueuedChatMessage } from '../shared/types'

interface Row {
  id: string
  tab_id: string
  send: string
  original: string
  position: number
  created_at: string
}

function rowToMessage(row: Row): QueuedChatMessage {
  return {
    id: row.id,
    tabId: row.tab_id,
    send: row.send,
    original: row.original,
    position: row.position,
    createdAt: row.created_at,
  }
}

export function listChatQueue(db: Database, tabId: string): QueuedChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM chat_queue WHERE tab_id = ? ORDER BY position ASC')
    .all(tabId) as Row[]
  return rows.map(rowToMessage)
}

export function pushChatQueue(
  db: Database,
  tabId: string,
  send: string,
  original: string
): QueuedChatMessage {
  const id = randomUUID()
  const insert = db.transaction(() => {
    const max = db
      .prepare('SELECT MAX(position) AS max_pos FROM chat_queue WHERE tab_id = ?')
      .get(tabId) as { max_pos: number | null } | undefined
    const nextPos = (max?.max_pos ?? -1) + 1
    db.prepare(
      'INSERT INTO chat_queue (id, tab_id, send, original, position) VALUES (?, ?, ?, ?, ?)'
    ).run(id, tabId, send, original, nextPos)
    return nextPos
  })
  insert()
  const row = db.prepare('SELECT * FROM chat_queue WHERE id = ?').get(id) as Row
  return rowToMessage(row)
}

export function removeChatQueueItem(db: Database, id: string): boolean {
  const info = db.prepare('DELETE FROM chat_queue WHERE id = ?').run(id)
  return info.changes > 0
}

export function clearChatQueue(db: Database, tabId: string): number {
  const info = db.prepare('DELETE FROM chat_queue WHERE tab_id = ?').run(tabId)
  return info.changes
}

/**
 * Atomic pop. Selects the head row + deletes it inside a single tx so two
 * concurrent drain triggers can't double-send. Caller must call
 * `sendUserMessage` AFTER this returns; if the send fails the caller is
 * responsible for re-inserting via `requeueAtHead`.
 */
export function popChatQueueHead(db: Database, tabId: string): QueuedChatMessage | null {
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM chat_queue WHERE tab_id = ? ORDER BY position ASC LIMIT 1')
      .get(tabId) as Row | undefined
    if (!row) return null
    db.prepare('DELETE FROM chat_queue WHERE id = ?').run(row.id)
    return rowToMessage(row)
  })
  return tx()
}

/**
 * Re-insert at head. Used when sendUserMessage fails after a successful pop —
 * we want the message back so the next drain can retry. Shifts existing
 * positions up to keep order stable.
 */
export function requeueAtHead(db: Database, msg: QueuedChatMessage): void {
  const tx = db.transaction(() => {
    db.prepare('UPDATE chat_queue SET position = position + 1 WHERE tab_id = ?').run(msg.tabId)
    db.prepare(
      'INSERT INTO chat_queue (id, tab_id, send, original, position) VALUES (?, ?, ?, ?, 0)'
    ).run(msg.id, msg.tabId, msg.send, msg.original)
  })
  tx()
}

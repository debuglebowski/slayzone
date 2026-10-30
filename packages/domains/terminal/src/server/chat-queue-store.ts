import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { SlayzoneDb } from '@slayzone/platform'
import type { QueuedChatMessage, UserContentBlock } from '@slayzone/terminal-contracts'

interface Row {
  id: string
  tab_id: string
  send: string
  original: string
  position: number
  created_at: string
  content: string | null
}

function parseContent(raw: string | null): UserContentBlock[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as UserContentBlock[]) : undefined
  } catch {
    return undefined
  }
}

function rowToMessage(row: Row): QueuedChatMessage {
  const content = parseContent(row.content)
  return {
    id: row.id,
    tabId: row.tab_id,
    send: row.send,
    original: row.original,
    position: row.position,
    createdAt: row.created_at,
    ...(content ? { content } : {})
  }
}

export async function listChatQueue(db: SlayzoneDb, tabId: string): Promise<QueuedChatMessage[]> {
  const rows = (await db
    .prepare('SELECT * FROM chat_queue WHERE tab_id = ? ORDER BY position ASC')
    .all(tabId)) as Row[]
  return rows.map(rowToMessage)
}

export function pushChatQueue(
  db: Database,
  tabId: string,
  send: string,
  original: string,
  opts: { id?: string; content?: UserContentBlock[] } = {}
): QueuedChatMessage {
  // The client may mint the id (it becomes the message's outbox id when sent).
  const id = opts.id ?? randomUUID()
  const insert = db.transaction(() => {
    const max = db
      .prepare('SELECT MAX(position) AS max_pos FROM chat_queue WHERE tab_id = ?')
      .get(tabId) as { max_pos: number | null } | undefined
    const nextPos = (max?.max_pos ?? -1) + 1
    db.prepare(
      'INSERT INTO chat_queue (id, tab_id, send, original, position, content) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, tabId, send, original, nextPos, opts.content ? JSON.stringify(opts.content) : null)
    return nextPos
  })
  insert()
  const row = db.prepare('SELECT * FROM chat_queue WHERE id = ?').get(id) as Row
  return rowToMessage(row)
}

export async function removeChatQueueItem(db: SlayzoneDb, id: string): Promise<boolean> {
  const info = await db.prepare('DELETE FROM chat_queue WHERE id = ?').run(id)
  return info.changes > 0
}

export async function clearChatQueue(db: SlayzoneDb, tabId: string): Promise<number> {
  const info = await db.prepare('DELETE FROM chat_queue WHERE tab_id = ?').run(tabId)
  return info.changes
}

/**
 * Rewrite a queued message (edited while it waited). Re-stamps `created_at`:
 * session retention ages a row from when its content was written. False when
 * it is gone (sent, removed, cleared).
 */
export async function updateChatQueueItem(
  db: SlayzoneDb,
  id: string,
  next: { send: string; original: string; content: UserContentBlock[] }
): Promise<boolean> {
  const info = await db
    .prepare(
      `UPDATE chat_queue SET send = ?, original = ?, content = ?, created_at = datetime('now') WHERE id = ?`
    )
    .run(next.send, next.original, JSON.stringify(next.content), id)
  return info.changes > 0
}

/**
 * Move a queued message to `toIndex` (clamped) in its tab's order, renumbering
 * the tab's positions 0…n-1 in one transaction. False when it is gone.
 */
export function moveChatQueueItem(db: Database, id: string, toIndex: number): boolean {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT tab_id FROM chat_queue WHERE id = ?').get(id) as
      | { tab_id: string }
      | undefined
    if (!row) return false
    const ids = (
      db
        .prepare('SELECT id FROM chat_queue WHERE tab_id = ? ORDER BY position ASC')
        .all(row.tab_id) as {
        id: string
      }[]
    ).map((r) => r.id)
    ids.splice(ids.indexOf(id), 1)
    ids.splice(Math.max(0, Math.min(toIndex, ids.length)), 0, id)
    const setPos = db.prepare('UPDATE chat_queue SET position = ? WHERE id = ?')
    ids.forEach((itemId, position) => setPos.run(position, itemId))
    return true
  })
  return tx()
}

/**
 * Atomic pop. Selects the head row + deletes it inside a single tx so two
 * concurrent drain triggers can't double-send. Caller must call
 * `sendUserMessage` AFTER this returns; if the send fails the caller is
 * responsible for re-inserting via `requeueAtHead`. A head in `heldIds` (being
 * edited) stays: nothing is popped, the queue waits for it (FIFO).
 */
export function popChatQueueHead(
  db: Database,
  tabId: string,
  heldIds: ReadonlyArray<string> = []
): QueuedChatMessage | null {
  const tx = db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM chat_queue WHERE tab_id = ? ORDER BY position ASC LIMIT 1')
      .get(tabId) as Row | undefined
    if (!row) return null
    if (heldIds.includes(row.id)) return null
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
      'INSERT INTO chat_queue (id, tab_id, send, original, position, content) VALUES (?, ?, ?, ?, 0, ?)'
    ).run(
      msg.id,
      msg.tabId,
      msg.send,
      msg.original,
      msg.content ? JSON.stringify(msg.content) : null
    )
  })
  tx()
}

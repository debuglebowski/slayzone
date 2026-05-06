import type { Database } from 'better-sqlite3'
import type { AgentEvent } from '../shared/agent-events'

export interface BufferedEvent {
  seq: number
  event: AgentEvent
}

/** Match in-memory MAX_BUFFER_EVENTS in chat-transport-manager. */
export const MAX_PERSISTED_EVENTS_PER_TAB = 2000

export function persistChatEvent(
  db: Database,
  tabId: string,
  seq: number,
  event: AgentEvent
): void {
  // INSERT OR REPLACE so a respawn that re-uses a seq overwrites cleanly.
  db.prepare(
    'INSERT OR REPLACE INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)'
  ).run(tabId, seq, JSON.stringify(event))

  // Retention: keep newest MAX rows per tab. Cheap because seq is monotonic.
  db.prepare(
    `DELETE FROM chat_events
     WHERE tab_id = ?
       AND seq <= (
         SELECT seq FROM chat_events
         WHERE tab_id = ?
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?
       )`
  ).run(tabId, tabId, MAX_PERSISTED_EVENTS_PER_TAB)
}

export function loadChatEvents(db: Database, tabId: string): BufferedEvent[] {
  const rows = db
    .prepare('SELECT seq, event FROM chat_events WHERE tab_id = ? ORDER BY seq ASC')
    .all(tabId) as Array<{ seq: number; event: string }>
  const out: BufferedEvent[] = []
  for (const row of rows) {
    try {
      out.push({ seq: row.seq, event: JSON.parse(row.event) as AgentEvent })
    } catch {
      // Drop corrupt rows silently — better than crashing the chat panel.
    }
  }
  return out
}

export function getNextSeqForTab(db: Database, tabId: string): number {
  const row = db
    .prepare('SELECT MAX(seq) AS max_seq FROM chat_events WHERE tab_id = ?')
    .get(tabId) as { max_seq: number | null } | undefined
  if (!row || row.max_seq === null) return 0
  return row.max_seq + 1
}

export function clearChatEventsForTab(db: Database, tabId: string): void {
  db.prepare('DELETE FROM chat_events WHERE tab_id = ?').run(tabId)
}

import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent } from '../shared/agent-events'

export interface BufferedEvent {
  seq: number
  event: AgentEvent
}

/** Match in-memory MAX_BUFFER_EVENTS in chat-transport-manager. */
export const MAX_PERSISTED_EVENTS_PER_TAB = 2000

export async function persistChatEvent(
  db: SlayzoneDb,
  tabId: string,
  seq: number,
  event: AgentEvent
): Promise<void> {
  // INSERT OR REPLACE so a respawn that re-uses a seq overwrites cleanly.
  await db
    .prepare('INSERT OR REPLACE INTO chat_events (tab_id, seq, event) VALUES (?, ?, ?)')
    .run(tabId, seq, JSON.stringify(event))

  // Retention: keep newest MAX rows per tab. Cheap because seq is monotonic.
  await db
    .prepare(
      `DELETE FROM chat_events
     WHERE tab_id = ?
       AND seq <= (
         SELECT seq FROM chat_events
         WHERE tab_id = ?
         ORDER BY seq DESC
         LIMIT 1 OFFSET ?
       )`
    )
    .run(tabId, tabId, MAX_PERSISTED_EVENTS_PER_TAB)
}

export async function loadChatEvents(db: SlayzoneDb, tabId: string): Promise<BufferedEvent[]> {
  const rows = (await db
    .prepare('SELECT seq, event FROM chat_events WHERE tab_id = ? ORDER BY seq ASC')
    .all(tabId)) as Array<{ seq: number; event: string }>
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

export async function getNextSeqForTab(db: SlayzoneDb, tabId: string): Promise<number> {
  const row = (await db
    .prepare('SELECT MAX(seq) AS max_seq FROM chat_events WHERE tab_id = ?')
    .get(tabId)) as { max_seq: number | null } | undefined
  if (!row || row.max_seq === null) return 0
  return row.max_seq + 1
}

export async function clearChatEventsForTab(db: SlayzoneDb, tabId: string): Promise<void> {
  await db.prepare('DELETE FROM chat_events WHERE tab_id = ?').run(tabId)
}

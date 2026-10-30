/**
 * Seed a chat tab's `chat_events` rows (seq = index), as a previous session
 * would have left them: one transaction per call into the hub (`__db.exec`, the
 * E2E-gated `/api/dev/sql`), each many 100-row INSERTs — a 100,000-event session
 * in ten round trips. (500-row statements made Electron die with SIGBUS; 100
 * rows each are fine.)
 */
import type { ElectronApplication } from '@playwright/test'

const ROWS_PER_INSERT = 100
const ROWS_PER_TRANSACTION = 10_000

/** A SQL string literal. */
const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`

export async function seedChatEvents(
  electronApp: ElectronApplication,
  tabId: string,
  events: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  for (let at = 0; at < events.length; at += ROWS_PER_TRANSACTION) {
    const end = Math.min(events.length, at + ROWS_PER_TRANSACTION)
    const statements: string[] = []
    for (let from = at; from < end; from += ROWS_PER_INSERT) {
      const rows: string[] = []
      for (let seq = from; seq < Math.min(end, from + ROWS_PER_INSERT); seq++) {
        rows.push(`(${sqlText(tabId)}, ${seq}, ${sqlText(JSON.stringify(events[seq]))})`)
      }
      statements.push(`INSERT INTO chat_events (tab_id, seq, event) VALUES ${rows.join(', ')};`)
    }
    await electronApp.evaluate(
      async ({}, sql) => {
        const db = (globalThis as Record<string, unknown>).__db as {
          exec: (sql: string) => Promise<unknown>
        }
        await db.exec(sql)
      },
      `BEGIN;\n${statements.join('\n')}\nCOMMIT;`
    )
  }
}

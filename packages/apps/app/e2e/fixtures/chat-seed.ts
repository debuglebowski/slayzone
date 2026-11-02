/**
 * Seed a chat tab's `chat_events` rows (seq = index), as a previous session
 * would have left them: SQL text into the hub (`__db.exec`, the E2E-gated
 * `/api/dev/sql`), one transaction per round trip, each many multi-row INSERTs.
 *
 * Batched by SIZE, not row count, so any session seeds — any number of events, of
 * any size: an INSERT holds at most `maxStatementChars` of SQL and a round trip at
 * most `maxRequestChars`; a single row bigger than that goes alone. (Batching by
 * count made a round trip's size whatever 10,000 events weighed: 4.5 MB for the
 * long session, but 640 MB for 10,000 events of 64 KiB — past one V8 string, one
 * `electronApp.evaluate` argument, one HTTP body.) The 10,000-event long session
 * is one round trip; 100,000 events are a handful.
 *
 * The budgets sit inside what was measured to work against the hub on 2026-11-02:
 * INSERTs of up to ~218 KB and round trips of up to ~45 MB (100,000 events in one
 * transaction). The SIGBUS once seen with 500-row INSERTs did not reproduce then —
 * not with 500, 2,000 or 10,000 rows per statement (literal or bound parameters).
 */
import type { ElectronApplication } from '@playwright/test'

export const SEED_LIMITS = {
  /** One multi-row INSERT, in characters of SQL. */
  maxStatementChars: 256 * 1024,
  /** One round trip (`BEGIN; … COMMIT;`), in characters of SQL. */
  maxRequestChars: 8 * 1024 * 1024
} as const

const INSERT = 'INSERT INTO chat_events (tab_id, seq, event) VALUES '
const BEGIN = 'BEGIN;\n'
const COMMIT = '\nCOMMIT;'

/** A SQL string literal. */
const sqlText = (value: string): string => `'${value.replaceAll("'", "''")}'`

/** The SQL of each round trip that seeds `events` into `tabId`, in order. Exported for tests. */
export function chatEventsSeedSql(
  tabId: string,
  events: ReadonlyArray<Record<string, unknown>>,
  limits: { maxStatementChars: number; maxRequestChars: number } = SEED_LIMITS
): string[] {
  const requests: string[] = []
  const tab = sqlText(tabId)
  let statements: string[] = []
  let requestChars = BEGIN.length + COMMIT.length
  let rows: string[] = []
  let statementChars = INSERT.length + 1 // + ';'

  const closeRequest = (): void => {
    if (statements.length === 0) return
    requests.push(`${BEGIN}${statements.join('\n')}${COMMIT}`)
    statements = []
    requestChars = BEGIN.length + COMMIT.length
  }
  const closeStatement = (): void => {
    if (rows.length === 0) return
    const statement = `${INSERT}${rows.join(', ')};`
    // + 1: the newline that joins it to the request's previous statement.
    if (statements.length > 0 && requestChars + 1 + statement.length > limits.maxRequestChars) {
      closeRequest()
    }
    requestChars += (statements.length > 0 ? 1 : 0) + statement.length
    statements.push(statement)
    rows = []
    statementChars = INSERT.length + 1
  }

  for (let seq = 0; seq < events.length; seq++) {
    const row = `(${tab}, ${seq}, ${sqlText(JSON.stringify(events[seq]))})`
    // + 2: the ', ' that joins it to the statement's previous row.
    if (rows.length > 0 && statementChars + 2 + row.length > limits.maxStatementChars) {
      closeStatement()
    }
    statementChars += (rows.length > 0 ? 2 : 0) + row.length
    rows.push(row)
  }
  closeStatement()
  closeRequest()
  return requests
}

export async function seedChatEvents(
  electronApp: ElectronApplication,
  tabId: string,
  events: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  for (const sql of chatEventsSeedSql(tabId, events)) {
    await electronApp.evaluate(async ({}, request) => {
      const db = (globalThis as Record<string, unknown>).__db as {
        exec: (sql: string) => Promise<unknown>
      }
      await db.exec(request)
    }, sql)
  }
}

/**
 * The drop of the hub's legacy chat tables (robustness plan §9, Phase 8), as one
 * atomic named transaction: the census and the drop see the same database.
 *
 * Pure (better-sqlite3 types + platform constants): safe in the DB worker bundle.
 */
import type { Database } from 'better-sqlite3'
import type { TxnSigOf } from '@slayzone/platform'
import {
  LEGACY_CHAT_CONTENT_TABLES,
  LEGACY_CHAT_TABLES,
  LEGACY_CHAT_TABLES_DROPPED_SETTING,
  legacyChatTablesSync
} from '@slayzone/platform/legacy-chat-tables'

export type LegacyChatTablesOutcome =
  /** Nothing to do: this install has none of them (already dropped, or never had them). */
  | { state: 'absent' }
  /** Dropped now. */
  | { state: 'dropped' }
  /** Still the migration source of chats not yet on their computer. */
  | { state: 'retained'; reason: string }

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

export function settleLegacyChatTablesTxn(db: Database, now: number): LegacyChatTablesOutcome {
  return db.transaction((): LegacyChatTablesOutcome => {
    const present = legacyChatTablesSync(db)
    if (!present.size) return { state: 'absent' }
    // A chat whose history the hub still holds or is still copying, or whose
    // migrated source the hub has not yet removed.
    const migrating = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM chat_ownership
          WHERE state IN ('legacy','copying','verified') OR (state='active' AND cleanup_pending=1)`
        )
        .get() as { n: number }
    ).n
    if (migrating)
      return {
        state: 'retained',
        reason: `${migrating} chat${migrating === 1 ? '' : 's'} still migrating from the hub`
      }
    for (const table of LEGACY_CHAT_CONTENT_TABLES)
      if (present.has(table) && db.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get())
        return { state: 'retained', reason: `legacy chat content in ${table}` }
    // Their own triggers and indexes go with them. Anything else that still names
    // one (a trigger on another table, a view) would break on its next use: refuse.
    const dropping = LEGACY_CHAT_TABLES.filter((t) => present.has(t))
    const dependents = (
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('trigger','view') AND sql IS NOT NULL"
        )
        .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>
    ).flatMap((o) =>
      (dropping as readonly string[]).includes(o.tbl_name)
        ? []
        : dropping
            .filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(o.sql))
            .map((t) => `${o.type} ${o.name} names ${t}`)
    )
    if (dependents.length)
      throw new Error(`Legacy chat tables cannot be dropped: ${dependents.join('; ')}`)
    for (const table of dropping) db.exec(`DROP TABLE ${quote(table)}`)
    db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(LEGACY_CHAT_TABLES_DROPPED_SETTING, String(now))
    return { state: 'dropped' }
  })()
}

export const chatLegacyTablesTxns = {
  'chat-legacy-tables:settle': (db: Database, p: { now: number }) =>
    settleLegacyChatTablesTxn(db, p.now)
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof chatLegacyTablesTxns> {}
}

/**
 * Hub boot step: drop the legacy (hub-era) chat tables once this install has
 * nothing left to migrate (robustness plan §9, Phase 8). The legacy migration
 * code stays (other installs still need it); every reader checks
 * `legacyChatTables(db)` (`@slayzone/platform/legacy-chat-tables`) first.
 *
 * It runs at hub BOOT, before any service is composed, so no reader can be between
 * its presence check and its query when a table disappears. A census that reaches
 * zero while the hub runs drops at the next boot; a restored backup relaunches the
 * hub, so a backup that brings the tables back is decided again.
 *
 * @module chat-runtime/server/legacy-tables
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { setLegacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import type { LegacyChatTablesOutcome } from './legacy-tables-txn'
import type {} from './legacy-tables-txn'

export type { LegacyChatTablesOutcome } from './legacy-tables-txn'

/** Fault-ledger pass of the boot step (shown under Needs attention when it fails). */
export const LEGACY_CHAT_TABLES_PASS = 'hub-legacy-chat-tables-drop'

export async function settleLegacyChatTables(
  db: SlayzoneDb,
  opts: { now?: number } = {}
): Promise<LegacyChatTablesOutcome> {
  setLegacyChatTables(db, undefined)
  try {
    const outcome = await db.namedTxn('chat-legacy-tables:settle', {
      now: opts.now ?? Date.now()
    })
    setLegacyChatTables(db, outcome.state === 'retained')
    return outcome
  } catch (error) {
    // Rolled back: whatever exists is looked up again by the first reader.
    setLegacyChatTables(db, undefined)
    throw error
  }
}

/**
 * Hub boot: drop the legacy chat tables once nothing is left to migrate
 * (robustness plan §9, Phase 8). Runs after the database opens and BEFORE the
 * services are composed (server.ts), so no reader is mid-query when a table goes.
 *
 * Never blocks boot: a failure (e.g. an unknown trigger that still names a legacy
 * table) is recorded under Needs attention and the tables stay, as before.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import {
  classifyFault,
  createAsyncFaultLedger,
  forEachIsolated
} from '@slayzone/platform/isolation'
import {
  LEGACY_CHAT_TABLES_PASS,
  type LegacyChatTablesOutcome,
  settleLegacyChatTables
} from '@slayzone/chat-runtime/hub'

export async function settleLegacyChatTablesAtBoot(
  db: SlayzoneDb,
  log: (line: string) => void = (line) => console.log(line)
): Promise<LegacyChatTablesOutcome | null> {
  let outcome: LegacyChatTablesOutcome | null = null
  await forEachIsolated(
    ['legacy-chat-tables'],
    {
      pass: LEGACY_CHAT_TABLES_PASS,
      key: (item) => item,
      ledger: createAsyncFaultLedger(db, { origin: 'hub' }),
      // The schema itself refuses (something else still names a legacy table): no
      // retry can help until the schema changes. Every boot tries again anyway.
      classify: (error) =>
        error instanceof Error && error.message.startsWith('Legacy chat tables cannot be dropped')
          ? 'structural'
          : classifyFault(error),
      ignoreGate: true
    },
    async () => {
      outcome = await settleLegacyChatTables(db)
    }
  )
  const settled = outcome as LegacyChatTablesOutcome | null
  if (settled?.state === 'dropped')
    log('[chat] legacy hub chat tables dropped (all chats migrated)')
  else if (settled?.state === 'retained')
    log(`[chat] legacy hub chat tables kept: ${settled.reason}`)
  return settled
}

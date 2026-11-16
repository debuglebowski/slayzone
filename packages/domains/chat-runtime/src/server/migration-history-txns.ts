import type { Database } from 'better-sqlite3'
import type { BatchOp, TxnSigOf } from '@slayzone/platform'
import { legacyChatTablesSync } from '@slayzone/platform/legacy-chat-tables'
import type { HubChatOwnership } from './hub-ownership'

export type LegacyHistoryIssue = 'timeline-without-events' | 'checkpoint-ahead-of-events'

/** Captured source identity, including the exact migration/cleanup generation. */
function assertOwner(db: Database, owner: HubChatOwnership, cleanup = false): void {
  if (
    owner.state === 'deleted' ||
    (cleanup && (owner.state !== 'active' || !owner.cleanupPending)) ||
    !db
      .prepare(`SELECT 1 FROM chat_ownership o WHERE o.id=? AND o.task_id=? AND o.tab_id=? AND o.mode=?
      AND o.epoch=? AND o.state=? AND o.computer_id IS ? AND o.source_computer_id IS NULL
      AND o.destination_computer_id IS ? AND o.migration_id IS ? AND o.manifest_hash IS ? AND o.cleanup_pending=?
      AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=o.task_id AND state='deleted')`)
      .get(
        owner.id,
        owner.taskId,
        owner.tabId,
        owner.mode,
        owner.epoch,
        owner.state,
        owner.computerId,
        owner.destinationComputerId,
        owner.migrationId,
        owner.manifestHash,
        Number(owner.cleanupPending)
      )
  )
    throw new Error('Legacy migration source ownership changed or was deleted')
}

/** Fixed-count indexed header probes only; never select JSON page/checkpoint bodies. */
function historyIssue(db: Database, tabId: string): LegacyHistoryIssue | null {
  if (!legacyChatTablesSync(db).size) return null
  const last = db
    .prepare('SELECT seq FROM chat_events WHERE tab_id=? ORDER BY seq DESC LIMIT 1')
    .get(tabId) as { seq: number } | undefined
  const checkpoint = db
    .prepare('SELECT seq FROM chat_timeline_checkpoints WHERE tab_id=?')
    .get(tabId) as { seq: number } | undefined
  if (!last) {
    // Unknown/expired residue stays in place too. A checkpoint with no pages may
    // hold the only tail; do not parse it or infer an intentional deletion.
    if (
      checkpoint ||
      db.prepare('SELECT 1 FROM chat_timeline_pages WHERE tab_id=? LIMIT 1').get(tabId)
    )
      return 'timeline-without-events'
  } else if (checkpoint && checkpoint.seq > last.seq) return 'checkpoint-ahead-of-events'
  // MAX(seq) does not prove complete event coverage. Other partial-history cases
  // require the separately scoped immutable-history/retention design.
  return null
}

export const chatMigrationHistoryTxns = {
  'chat-migration:check-source-history': (
    db: Database,
    { owner }: { owner: HubChatOwnership }
  ): LegacyHistoryIssue | null =>
    db.transaction(() => {
      assertOwner(db, owner)
      return historyIssue(db, owner.tabId)
    })(),
  /** Same static cleanup batch, fenced and checked inside its write transaction. */
  'chat-migration:cleanup-source': (
    db: Database,
    { owner, ops }: { owner: HubChatOwnership; ops: BatchOp[] }
  ): LegacyHistoryIssue | null =>
    db
      .transaction(() => {
        assertOwner(db, owner, true)
        const issue = historyIssue(db, owner.tabId)
        if (issue) return issue
        for (const op of ops) db.prepare(op.sql)[op.type](...op.params)
        return null
      })
      .immediate()
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof chatMigrationHistoryTxns> {}
}

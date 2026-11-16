import type { Database } from 'better-sqlite3'
import type { BatchOp, TxnSigOf } from '@slayzone/platform'
import { legacyChatTablesSync } from '@slayzone/platform/legacy-chat-tables'
import type { HubChatOwnership } from './hub-ownership'
import type { ChatTransferManifest } from '../shared'

export type LegacyHistoryIssue =
  | 'timeline-without-events'
  | 'checkpoint-ahead-of-events'
  | 'unsafe-migration-generation'
  | 'source-generation-changed'
  | 'destination-proof-events-mismatch'
  | 'destination-proof-changed'
  | 'destination-proof-unbound'

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
function historyFacts(
  db: Database,
  tabId: string
): { issue: LegacyHistoryIssue | null; seq: number | null } {
  if (!legacyChatTablesSync(db).size) return { issue: null, seq: null }
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
      return { issue: 'timeline-without-events', seq: null }
  } else if (checkpoint && checkpoint.seq > last.seq)
    return { issue: 'checkpoint-ahead-of-events', seq: last.seq }
  // MAX(seq) does not prove complete event coverage. Other partial-history cases
  // require the separately scoped immutable-history/retention design.
  return { issue: null, seq: last?.seq ?? null }
}

/** Metadata only: blocked generations never become valid merely by repairing events. */
function checkHistory(
  db: Database,
  owner: HubChatOwnership,
  proof?: ChatTransferManifest
): LegacyHistoryIssue | null {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_legacy_migration_safety (
    conversation_id TEXT NOT NULL REFERENCES chat_ownership(id) ON DELETE CASCADE,
    source_epoch INTEGER NOT NULL, migration_id TEXT NOT NULL,
    block_reason TEXT, proof_hash TEXT, source_seq INTEGER,
    PRIMARY KEY(conversation_id,source_epoch,migration_id)
  ) WITHOUT ROWID`)
  const epoch = owner.state === 'active' ? owner.epoch - 1 : owner.epoch
  const token = owner.migrationId ?? proof?.header.migrationId
  const scope = [owner.id, epoch, token] as const
  if (proof) {
    const i = proof.header.identity
    if (
      proof.header.migrationId !== token ||
      i.id !== owner.id ||
      i.taskId !== owner.taskId ||
      i.tabId !== owner.tabId ||
      i.mode !== owner.mode ||
      i.epoch !== epoch ||
      !/^[a-f0-9]{64}$/.test(proof.hash) ||
      !Number.isSafeInteger(proof.header.events) ||
      proof.header.events < 0 ||
      (owner.manifestHash !== null && owner.manifestHash !== proof.hash)
    )
      throw new Error('Legacy destination proof ownership mismatch')
  }
  const previous = token
    ? (db
        .prepare(`SELECT block_reason,proof_hash,source_seq FROM chat_legacy_migration_safety
    WHERE conversation_id=? AND source_epoch=? AND migration_id=?`)
        .get(...scope) as
        | { block_reason: string | null; proof_hash: string | null; source_seq: number | null }
        | undefined)
    : undefined
  if (previous?.block_reason) return 'unsafe-migration-generation'
  const block = (issue: LegacyHistoryIssue): LegacyHistoryIssue => {
    if (token)
      db.prepare(`INSERT INTO chat_legacy_migration_safety(conversation_id,source_epoch,migration_id,block_reason)
      VALUES(?,?,?,?) ON CONFLICT(conversation_id,source_epoch,migration_id) DO UPDATE SET block_reason=excluded.block_reason`).run(
        ...scope,
        issue
      )
    return issue
  }
  const facts = historyFacts(db, owner.tabId)
  if (facts.issue) return block(facts.issue)
  if (previous?.proof_hash && previous.source_seq !== facts.seq)
    return block('source-generation-changed')
  if (proof) {
    // This veto binds an empty/nonempty proof to the captured source generation;
    // it does not infer complete partial-event coverage from a count/MAX(seq).
    if (proof.header.events > 0 !== (facts.seq !== null))
      return block('destination-proof-events-mismatch')
    if (previous?.proof_hash && previous.proof_hash !== proof.hash)
      return block('destination-proof-changed')
    db.prepare(`INSERT INTO chat_legacy_migration_safety(conversation_id,source_epoch,migration_id,proof_hash,source_seq)
      VALUES(?,?,?,?,?) ON CONFLICT(conversation_id,source_epoch,migration_id) DO UPDATE SET proof_hash=excluded.proof_hash,source_seq=excluded.source_seq`).run(
      ...scope,
      proof.hash,
      facts.seq
    )
  } else if (
    owner.state === 'active' &&
    owner.cleanupPending &&
    (!previous?.proof_hash || previous.proof_hash !== owner.manifestHash)
  ) {
    // Old committed copies lacking a source-bound receipt are not silently
    // trusted. Canonical unavailable-owner reseed can establish a NEW generation.
    return block('destination-proof-unbound')
  }
  return null
}

export const chatMigrationHistoryTxns = {
  'chat-migration:check-source-history': (
    db: Database,
    { owner, proof }: { owner: HubChatOwnership; proof?: ChatTransferManifest }
  ): LegacyHistoryIssue | null =>
    db
      .transaction(() => {
        assertOwner(db, owner)
        return checkHistory(db, owner, proof)
      })
      .immediate(),
  /** Same static cleanup batch, fenced and checked inside its write transaction. */
  'chat-migration:cleanup-source': (
    db: Database,
    { owner, ops }: { owner: HubChatOwnership; ops: BatchOp[] }
  ): LegacyHistoryIssue | null =>
    db
      .transaction(() => {
        assertOwner(db, owner, true)
        const issue = checkHistory(db, owner)
        if (issue) return issue
        for (const op of ops) db.prepare(op.sql)[op.type](...op.params)
        return null
      })
      .immediate()
}

declare module '@slayzone/platform' {
  interface TxnRegistry extends TxnSigOf<typeof chatMigrationHistoryTxns> {}
}

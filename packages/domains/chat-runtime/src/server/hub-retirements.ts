import type { BatchOp, SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import { computerStanding } from '@slayzone/computers/server'
import type { ChatUnavailableReason } from '@slayzone/terminal-contracts'
import { isolateItem } from './hub-isolation'
import { retiredComputerSql } from './hub-ownership'

/** A chat whose computer was removed waits, visibly, for a computer that holds it. */
const REMOVED: ChatUnavailableReason = 'computer-removed'

interface Retirement {
  computer_id: string
  successor_id: string | null
  reason: string
}

/**
 * Applies `computer_retirements` (written by the computers domain in the same
 * transaction that re-enrolled or deleted the computer) to the chat
 * bookkeeping that still names a retired id. Idempotent: run at hub start, on
 * every computer recovery, and when a computer is removed.
 *
 * - Successor (re-enrolled): every chat record moves to it. Acknowledgements
 *   are dropped, so the successor receives that state again (idempotent there).
 * - No successor (deleted / missing): work addressed to it can never be
 *   delivered. It is retired with a recorded reason, so nothing pending blocks
 *   a task forever; its active chats show as unavailable until a computer
 *   that holds them reports them (recovery adopts them then).
 *
 * Revoked computers are not retired: their work waits for them.
 *
 * Returns the retirements that could not be applied this pass (each logged): a
 * caller waiting on one of them knows it is still owed (computer-chat recovery
 * does not keep such a pass, so the next one retries it).
 */
export async function applyComputerRetirements(db: SlayzoneDb): Promise<RetirementReport> {
  const rows = await db.all<Retirement>(
    'SELECT computer_id,successor_id,reason FROM computer_retirements ORDER BY retired_at,computer_id'
  )
  // v196's hub-era tab computers exist only while the legacy tables do (§9 Phase 8).
  const legacy = rows.length ? await legacyChatTables(db) : false
  const failed = new Map<string, Error>()
  for (const r of rows) {
    // One retirement that cannot be applied never stops the others.
    await isolateItem(
      `retirement of computer ${r.computer_id}`,
      async () => {
        // Where the chain of re-enrollments leads: a live successor, or removed.
        const standing = await computerStanding(db, r.computer_id)
        await db.batchTxn(
          standing.kind === 'successor'
            ? repointOps(r.computer_id, standing.id, legacy)
            : retireOps(r.computer_id, r.reason, legacy)
        )
      },
      (error) => failed.set(r.computer_id, error)
    )
  }
  return { failed }
}

/** What one {@link applyComputerRetirements} pass could not apply, by retired computer id. */
export interface RetirementReport {
  failed: ReadonlyMap<string, Error>
}

function repointOps(from: string, to: string, legacy: boolean): BatchOp[] {
  const run = (sql: string, params: unknown[]): BatchOp => ({ type: 'run', sql, params })
  return [
    ...['computer_id', 'source_computer_id', 'destination_computer_id'].map((column) =>
      run(`UPDATE chat_ownership SET ${column}=? WHERE ${column}=?`, [to, from])
    ),
    run(
      'INSERT OR IGNORE INTO chat_task_computers(task_id,computer_id) SELECT task_id,? FROM chat_task_computers WHERE computer_id=?',
      [to, from]
    ),
    run('DELETE FROM chat_task_computers WHERE computer_id=?', [from]),
    run(
      `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
      SELECT conversation_id,?,epoch FROM chat_deletion_targets WHERE computer_id=? AND acknowledged=0
      ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=0`,
      [to, from]
    ),
    run('DELETE FROM chat_deletion_targets WHERE computer_id=?', [from]),
    // Re-delivered to the successor (each is idempotent on the computer).
    run('DELETE FROM chat_lifecycle_acks WHERE computer_id=?', [from]),
    run('DELETE FROM chat_folder_deletion_acks WHERE computer_id=?', [from]),
    // Recovery re-decides availability from the successor's own inventory.
    run('DELETE FROM chat_unavailable_owners WHERE computer_id=?', [from]),
    run('UPDATE chat_bootstrap_reservations SET computer_id=? WHERE computer_id=?', [to, from]),
    run('UPDATE chat_provider_transitions SET computer_id=? WHERE computer_id=?', [to, from]),
    ...(legacy
      ? [run('UPDATE chat_legacy_tab_computers SET computer_id=? WHERE computer_id=?', [to, from])]
      : [])
  ]
}

function retireOps(id: string, reason: string, legacy: boolean): BatchOp[] {
  const run = (sql: string, params: unknown[]): BatchOp => ({ type: 'run', sql, params })
  const record = (kind: string, select: string, params: unknown[]): BatchOp =>
    run(
      `INSERT OR IGNORE INTO chat_retired_work(kind,item_id,computer_id,reason,retired_at)
      SELECT '${kind}',item,?,?,CAST(strftime('%s','now') AS INTEGER)*1000 FROM (${select})`,
      [id, reason, ...params]
    )
  return [
    // Deletions it never acknowledged: nothing left to deliver them to.
    record(
      'deletion',
      'SELECT conversation_id AS item FROM chat_deletion_targets WHERE computer_id=? AND acknowledged=0',
      [id]
    ),
    run('UPDATE chat_deletion_targets SET acknowledged=1 WHERE computer_id=? AND acknowledged=0', [
      id
    ]),
    run('DELETE FROM chat_lifecycle_acks WHERE computer_id=?', [id]),
    run('DELETE FROM chat_folder_deletion_acks WHERE computer_id=?', [id]),
    // Later deletions in its tasks no longer target it.
    run('DELETE FROM chat_task_computers WHERE computer_id=?', [id]),
    // A chat initialization reserved on it: re-reserved on a live computer when opened.
    record(
      'bootstrap',
      'SELECT conversation_id AS item FROM chat_bootstrap_reservations WHERE computer_id=?',
      [id]
    ),
    run('DELETE FROM chat_bootstrap_reservations WHERE computer_id=?', [id]),
    run(
      "UPDATE chat_ownership SET destination_computer_id=NULL WHERE destination_computer_id=? AND state='legacy' AND migration_id IS NULL",
      [id]
    ),
    // A migration to it never committed: the source still holds the history.
    record(
      'migration',
      "SELECT id AS item FROM chat_ownership WHERE destination_computer_id=? AND state IN ('copying','verified')",
      [id]
    ),
    run(
      `UPDATE chat_ownership SET state=CASE WHEN computer_id IS NULL THEN 'legacy' ELSE 'active' END,
      migration_id=NULL,destination_computer_id=NULL,source_computer_id=NULL,manifest_hash=NULL
      WHERE destination_computer_id=? AND state IN ('copying','verified')`,
      [id]
    ),
    record(
      'provider-transition',
      "SELECT id AS item FROM chat_provider_transitions WHERE computer_id=? AND state='reserved'",
      [id]
    ),
    run(
      "UPDATE chat_provider_transitions SET state='superseded' WHERE computer_id=? AND state='reserved'",
      [id]
    ),
    // Its chats wait, visibly, for a computer that holds them.
    run(
      `INSERT INTO chat_unavailable_owners(conversation_id,computer_id,epoch,reason)
      SELECT id,computer_id,epoch,? FROM chat_ownership WHERE computer_id=? AND state='active'
      ON CONFLICT(conversation_id) DO UPDATE SET computer_id=excluded.computer_id,epoch=excluded.epoch,reason=excluded.reason`,
      [REMOVED, id]
    ),
    ...(legacy ? [run('DELETE FROM chat_legacy_tab_computers WHERE computer_id=?', [id])] : []),
    // Placeholder folders only chats on it were waiting to fill: resolved to
    // normal folders (no live chat can supply their own record any more).
    run(
      `DELETE FROM chat_folder_placeholders WHERE EXISTS(
        SELECT 1 FROM chat_folder_placeholder_waits w WHERE w.folder_id=chat_folder_placeholders.folder_id)
      AND NOT EXISTS(SELECT 1 FROM chat_folder_placeholder_waits w JOIN chat_ownership o ON o.id=w.conversation_id
        WHERE w.folder_id=chat_folder_placeholders.folder_id AND o.state<>'deleted'
          AND NOT (o.computer_id IS NOT NULL AND ${retiredComputerSql('o.computer_id')}))`,
      []
    )
  ]
}

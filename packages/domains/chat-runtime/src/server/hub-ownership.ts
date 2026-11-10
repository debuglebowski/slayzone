import type { SlayzoneDb } from '@slayzone/platform'
import { legacyChatTables } from '@slayzone/platform/legacy-chat-tables'
import { legacyChatTabContentSql, legacyChatTaskContentSql } from './legacy-census'

export interface HubChatOwnership {
  id: string
  taskId: string
  tabId: string
  mode: string
  computerId: string | null
  epoch: number
  state: 'legacy' | 'active' | 'copying' | 'verified' | 'deleted'
  migrationId: string | null
  destinationComputerId: string | null
  sourceComputerId: string | null
  manifestHash: string | null
  cleanupPending: boolean
  settingsRevision: number
  settingsHash: string | null
}
interface Row {
  id: string
  task_id: string
  tab_id: string
  mode: string
  computer_id: string | null
  epoch: number
  state: HubChatOwnership['state']
  migration_id: string | null
  destination_computer_id: string | null
  source_computer_id: string | null
  manifest_hash: string | null
  cleanup_pending: number
  settings_revision: number
  settings_hash: string | null
}
const fromRow = (r: Row): HubChatOwnership => ({
  id: r.id,
  taskId: r.task_id,
  tabId: r.tab_id,
  mode: r.mode,
  computerId: r.computer_id,
  epoch: r.epoch,
  state: r.state,
  migrationId: r.migration_id,
  destinationComputerId: r.destination_computer_id,
  sourceComputerId: r.source_computer_id,
  manifestHash: r.manifest_hash,
  cleanupPending: Boolean(r.cleanup_pending),
  settingsRevision: r.settings_revision,
  settingsHash: r.settings_hash
})

/**
 * A stale locator: a hub row that only POINTS at a chat's history and holds no
 * computer authority — never activated on a computer (`computer_id` NULL), still
 * legacy or mid-migration. Only such a row may be replaced by what a computer
 * reports for its tab; any other row is a live chat. SQL form, for `alias`.
 */
export const staleLocatorSql = (alias: string) =>
  `(${alias}.computer_id IS NULL AND ${alias}.state IN ('legacy','copying','verified'))`
export const isStaleLocator = (owner: Pick<HubChatOwnership, 'computerId' | 'state'>) =>
  owner.computerId === null && ['legacy', 'copying', 'verified'].includes(owner.state)

/** SQL: `expr` is not a retired computer id (re-enrolled or removed): it can still receive work. */
const notRetired = (expr: string) =>
  `NOT EXISTS(SELECT 1 FROM computer_retirements r WHERE r.computer_id=${expr})`
/** SQL: computer id `expr` was removed for good (deleted or missing, no successor). */
export const retiredComputerSql = (expr: string) =>
  `EXISTS(SELECT 1 FROM computer_retirements r WHERE r.computer_id=${expr} AND r.successor_id IS NULL)`

type ChangeListener = (tabIds: readonly string[]) => void
/**
 * Listeners per database, not per store: several modules open their own store on
 * the hub's one database, and a change any of them makes must reach every listener.
 */
const changeListeners = new WeakMap<SlayzoneDb, Set<ChangeListener>>()

/**
 * Signal that these tabs' conversations left their owner (a move began or
 * committed, a provider transition, a deletion): whoever holds access granted
 * under the old ownership (the hub's direct-link grants) must drop it now.
 */
export function notifyChatOwnershipChange(db: SlayzoneDb, tabIds: readonly string[]): void {
  if (tabIds.length === 0) return
  for (const listener of [...(changeListeners.get(db) ?? [])]) {
    try {
      listener(tabIds)
    } catch {
      // A listener's failure never fails the ownership change that already committed.
    }
  }
}

export function createChatOwnershipStore(db: SlayzoneDb) {
  const get = async (id: string) => {
    const row = await db.get<Row>('SELECT * FROM chat_ownership WHERE id=?', [id])
    return row ? fromRow(row) : null
  }
  async function required(id: string) {
    const r = await get(id)
    if (!r) throw new Error('Unknown chat ownership')
    return r
  }
  const api = {
    get,
    async unavailable(id: string) {
      return db.get<{ reason: string }>(
        `SELECT u.reason FROM chat_unavailable_owners u JOIN chat_ownership o ON o.id=u.conversation_id
        WHERE u.conversation_id=? AND o.state='active' AND o.computer_id=u.computer_id AND o.epoch=u.epoch`,
        [id]
      )
    },
    async markUnavailable(id: string, computerId: string, epoch: number) {
      await db.run(
        `INSERT INTO chat_unavailable_owners(conversation_id,computer_id,epoch,reason)
        SELECT id,computer_id,epoch,'Chat history unavailable. Computer did not return this conversation. Restore its chat backup or reconnect the original computer; no empty history was created.'
        FROM chat_ownership WHERE id=? AND computer_id=? AND epoch=? AND state='active'
        AND NOT EXISTS(SELECT 1 FROM chat_bootstrap_reservations WHERE conversation_id=chat_ownership.id)
        ON CONFLICT(conversation_id) DO UPDATE SET computer_id=excluded.computer_id,epoch=excluded.epoch,reason=excluded.reason`,
        [id, computerId, epoch]
      )
    },
    async clearUnavailable(id: string, computerId: string, epoch: number) {
      await db.run(
        'DELETE FROM chat_unavailable_owners WHERE conversation_id=? AND computer_id=? AND epoch=?',
        [id, computerId, epoch]
      )
    },
    async forTab(tabId: string) {
      const row = await db.get<Row>(
        'SELECT c.* FROM chat_ownership c JOIN chat_tab_bindings b ON b.conversation_id=c.id WHERE b.tab_id=?',
        [tabId]
      )
      return row ? fromRow(row) : null
    },
    async forTask(taskId: string) {
      return (
        await db.all<Row>('SELECT * FROM chat_ownership WHERE task_id=? ORDER BY id', [taskId])
      ).map(fromRow)
    },
    async register(
      value: Pick<HubChatOwnership, 'id' | 'taskId' | 'tabId' | 'mode' | 'computerId' | 'epoch'>,
      requireTab = false
    ) {
      if (
        await db.get("SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'", [
          value.taskId
        ])
      )
        throw new Error('Task chat history was deleted')
      if (!Number.isSafeInteger(value.epoch) || value.epoch < 1)
        throw new Error('Invalid chat ownership epoch')
      const binding = await api.forTab(value.tabId)
      if (binding && binding.id !== value.id)
        throw new Error('Chat tab binding already belongs to another conversation')
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state)
      SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
      AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted')
      ${requireTab ? 'AND EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?)' : ''}
      ON CONFLICT(id) DO NOTHING`,
          params: [
            value.id,
            value.taskId,
            value.tabId,
            value.mode,
            value.computerId,
            value.epoch,
            value.computerId ? 'active' : 'legacy',
            value.tabId,
            value.id,
            value.taskId,
            ...(requireTab ? [value.tabId, value.taskId] : [])
          ]
        },
        {
          type: 'run',
          sql: "INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT ?,id FROM chat_ownership WHERE id=? AND task_id=? AND tab_id=? AND mode=? AND computer_id IS ? AND epoch=? AND state<>'deleted' ON CONFLICT(tab_id) DO NOTHING",
          params: [
            value.tabId,
            value.id,
            value.taskId,
            value.tabId,
            value.mode,
            value.computerId,
            value.epoch
          ]
        }
      ])
      const stored = await get(value.id)
      if (!stored) throw new Error('Chat tab binding changed concurrently')
      if (stored.state === 'deleted') throw new Error('Chat conversation deleted')
      if (
        stored.taskId !== value.taskId ||
        stored.tabId !== value.tabId ||
        stored.mode !== value.mode ||
        stored.computerId !== value.computerId ||
        stored.epoch !== value.epoch
      )
        throw new Error('Chat ownership conflict')
      return stored
    },
    async reserveBootstrap(
      value: Pick<HubChatOwnership, 'id' | 'taskId' | 'tabId' | 'mode' | 'epoch'> & {
        computerId: string
      }
    ) {
      if (!Number.isSafeInteger(value.epoch) || value.epoch < 1)
        throw new Error('Invalid chat ownership epoch')
      const virtual =
        value.tabId === `prompt-history:${value.taskId}` ||
        value.tabId.startsWith('artifact-store:')
      await db.batchTxn([
        {
          type: 'run',
          sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state,destination_computer_id)
            SELECT ?,?,?,?,?,'legacy',? WHERE EXISTS(SELECT 1 FROM tasks WHERE id=?)
            AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted')
            AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
            ${virtual ? '' : 'AND EXISTS(SELECT 1 FROM terminal_tabs WHERE id=? AND task_id=?)'}
            ON CONFLICT(id) DO NOTHING`,
          params: [
            value.id,
            value.taskId,
            value.tabId,
            value.mode,
            value.epoch,
            value.computerId,
            value.taskId,
            value.taskId,
            value.tabId,
            value.id,
            ...(virtual ? [] : [value.tabId, value.taskId])
          ]
        },
        {
          type: 'run',
          sql: `INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT tab_id,id FROM chat_ownership
            WHERE id=? AND task_id=? AND tab_id=? AND mode=? AND epoch=? AND state='legacy'
            AND computer_id IS NULL AND destination_computer_id=? AND migration_id IS NULL
            ON CONFLICT(tab_id) DO NOTHING`,
          params: [value.id, value.taskId, value.tabId, value.mode, value.epoch, value.computerId]
        },
        {
          type: 'run',
          sql: `INSERT INTO chat_bootstrap_reservations(conversation_id,computer_id,epoch)
            SELECT o.id,?,o.epoch FROM chat_ownership o JOIN chat_tab_bindings b ON b.conversation_id=o.id
            WHERE o.id=? AND o.task_id=? AND o.tab_id=? AND o.mode=? AND o.epoch=? AND o.state='legacy'
            AND o.computer_id IS NULL AND o.destination_computer_id=? AND o.migration_id IS NULL
            ON CONFLICT(conversation_id) DO NOTHING`,
          params: [
            value.computerId,
            value.id,
            value.taskId,
            value.tabId,
            value.mode,
            value.epoch,
            value.computerId
          ]
        }
      ])
      const owner = await api.forTab(value.tabId)
      const reservation = await api.bootstrapReservation(value.id)
      if (!owner || owner.id !== value.id || owner.state === 'deleted')
        throw new Error('Chat tab or task was deleted during initialization')
      if (
        owner.state === 'active' &&
        owner.computerId === value.computerId &&
        owner.epoch === value.epoch &&
        owner.taskId === value.taskId &&
        owner.tabId === value.tabId &&
        owner.mode === value.mode
      )
        return owner
      if (
        !reservation ||
        reservation.computerId !== value.computerId ||
        reservation.epoch !== value.epoch
      )
        throw new Error('Chat initialization ownership conflict')
      return owner
    },
    async bootstrapReservation(id: string) {
      return db.get<{ computerId: string; epoch: number }>(
        'SELECT computer_id AS computerId,epoch FROM chat_bootstrap_reservations WHERE conversation_id=?',
        [id]
      )
    },
    async pendingBootstraps(computerId: string) {
      return (
        await db.all<Row>(
          `SELECT o.* FROM chat_ownership o JOIN chat_bootstrap_reservations r ON r.conversation_id=o.id
          WHERE r.computer_id=? AND o.state<>'deleted' ORDER BY o.id`,
          [computerId]
        )
      ).map(fromRow)
    },
    async activateBootstrap(id: string, computerId: string, epoch: number) {
      await db.batchTxn([
        {
          type: 'run',
          sql: `UPDATE chat_ownership SET state='active',computer_id=?,destination_computer_id=NULL
            WHERE id=? AND epoch=? AND state IN ('legacy','active') AND migration_id IS NULL
            AND EXISTS(SELECT 1 FROM chat_bootstrap_reservations r WHERE r.conversation_id=chat_ownership.id AND r.computer_id=? AND r.epoch=?)
            AND NOT EXISTS(SELECT 1 FROM chat_task_lifecycle l WHERE l.task_id=chat_ownership.task_id AND l.state='deleted')`,
          params: [computerId, id, epoch, computerId, epoch]
        },
        {
          type: 'run',
          sql: `DELETE FROM chat_bootstrap_reservations WHERE conversation_id=? AND EXISTS(
            SELECT 1 FROM chat_ownership WHERE id=? AND state='active' AND computer_id=? AND epoch=?)`,
          params: [id, id, computerId, epoch]
        }
      ])
      const owner = await required(id)
      if (owner.state !== 'active' || owner.computerId !== computerId || owner.epoch !== epoch)
        throw new Error('Chat conversation was deleted or changed during initialization')
      return owner
    },
    async settingsRevision(id: string, hash: string) {
      await db.run(
        "UPDATE chat_ownership SET settings_revision=settings_revision+1,settings_hash=? WHERE id=? AND state<>'deleted' AND (settings_hash IS NULL OR settings_hash<>?)",
        [hash, id, hash]
      )
      return (await required(id)).settingsRevision
    },
    async beginMigration(
      id: string,
      input: {
        expectedComputerId: string | null
        expectedEpoch: number
        migrationId: string
        destinationComputerId: string
      }
    ) {
      const result = await db.run(
        `UPDATE chat_ownership SET state='copying',migration_id=?,destination_computer_id=?,source_computer_id=computer_id,manifest_hash=NULL
    WHERE id=? AND computer_id IS ? AND epoch=? AND state IN ('active','legacy')`,
        [
          input.migrationId,
          input.destinationComputerId,
          id,
          input.expectedComputerId,
          input.expectedEpoch
        ]
      )
      const current = await required(id)
      if (
        !result.changes &&
        !(
          current.migrationId === input.migrationId &&
          current.destinationComputerId === input.destinationComputerId &&
          current.epoch === input.expectedEpoch &&
          ['copying', 'verified'].includes(current.state)
        )
      )
        throw new Error('Chat ownership changed; migration cannot proceed')
      // The source stops serving the conversation now (its writes are fenced).
      if (result.changes) notifyChatOwnershipChange(db, [current.tabId])
      return current
    },
    async markVerified(id: string, migrationId: string, hash: string) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid migration manifest hash')
      await db.run(
        "UPDATE chat_ownership SET state='verified',manifest_hash=? WHERE id=? AND migration_id=? AND state='copying'",
        [hash, id, migrationId]
      )
      const r = await required(id)
      if (
        r.migrationId !== migrationId ||
        r.manifestHash !== hash ||
        !['verified', 'active'].includes(r.state)
      )
        throw new Error('Migration verification conflict')
      return r
    },
    async commitMigration(id: string, migrationId: string, hash: string) {
      const committed = await db.run(
        `UPDATE chat_ownership SET computer_id=destination_computer_id,epoch=epoch+1,state='active',cleanup_pending=1
    WHERE id=? AND migration_id=? AND manifest_hash=? AND state='verified' AND epoch<?`,
        [id, migrationId, hash, Number.MAX_SAFE_INTEGER]
      )
      const r = await required(id)
      if (r.state !== 'active' || r.migrationId !== migrationId || r.manifestHash !== hash)
        throw new Error('Migration must be verified before ownership commit')
      if (committed.changes) notifyChatOwnershipChange(db, [r.tabId])
      return r
    },
    /**
     * The computer a committed migration went to no longer holds the copy (its
     * recovery did not return it), while the hub source is still intact: its
     * cleanup waits for activation, which never ran. Reset to the hub source at
     * a new epoch, so the migration runs again from it. The lost copy's epoch
     * can never be activated afterwards.
     */
    async reseedFromSource(id: string, epoch: number) {
      const tables = await legacyChatTables(db)
      await db.batchTxn([
        {
          type: 'run',
          sql: `UPDATE chat_ownership SET state='legacy',computer_id=NULL,source_computer_id=NULL,destination_computer_id=NULL,
            migration_id=NULL,manifest_hash=NULL,cleanup_pending=0,epoch=epoch+1
            WHERE id=? AND epoch=? AND state='active' AND cleanup_pending=1 AND migration_id IS NOT NULL
            AND source_computer_id IS NULL
            -- The hub source still holds the content (its cleanup is one atomic batch).
            AND (EXISTS(SELECT 1 FROM terminal_tabs t WHERE t.id=chat_ownership.tab_id AND ${legacyChatTabContentSql(tables, 't')})
              OR (chat_ownership.tab_id='task-content:'||chat_ownership.task_id
                AND EXISTS(SELECT 1 FROM tasks task WHERE task.id=chat_ownership.task_id AND ${legacyChatTaskContentSql(tables, 'task.id')})))
            AND EXISTS(SELECT 1 FROM chat_unavailable_owners u WHERE u.conversation_id=chat_ownership.id
              AND u.computer_id=chat_ownership.computer_id AND u.epoch=chat_ownership.epoch)`,
          params: [id, epoch]
        },
        {
          type: 'run',
          sql: "DELETE FROM chat_unavailable_owners WHERE conversation_id=? AND EXISTS(SELECT 1 FROM chat_ownership WHERE id=? AND state='legacy')",
          params: [id, id]
        }
      ])
      return required(id)
    },
    async completeCleanup(id: string, migrationId: string, epoch: number) {
      await db.run(
        "UPDATE chat_ownership SET cleanup_pending=0 WHERE id=? AND migration_id=? AND epoch=? AND state='active'",
        [id, migrationId, epoch]
      )
      const r = await required(id)
      if (r.migrationId !== migrationId || r.epoch !== epoch || r.state !== 'active')
        throw new Error('Cleanup ownership changed')
      return r
    },
    async deleteConversation(id: string, minimumEpoch = 1) {
      const before = await get(id)
      await db.batchTxn([
        {
          type: 'run',
          sql: "UPDATE chat_ownership SET state='deleted',epoch=MAX(epoch+CASE WHEN state='deleted' THEN 0 ELSE 1 END,?) WHERE id=?",
          params: [minimumEpoch, id]
        },
        {
          type: 'run',
          // Every computer of the task, and the one holding the conversation.
          sql: `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
            SELECT o.id,c.computer_id,o.epoch FROM chat_ownership o JOIN chat_task_computers c ON c.task_id=o.task_id WHERE o.id=? AND o.state='deleted'
              AND ${notRetired('c.computer_id')}
            UNION SELECT o.id,o.computer_id,o.epoch FROM chat_ownership o WHERE o.id=? AND o.state='deleted' AND o.computer_id IS NOT NULL
              AND ${notRetired('o.computer_id')}
            ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END`,
          params: [id, id]
        },
        {
          type: 'run',
          // Pending exactly while a computer has not acknowledged the removal. A
          // repeated delete (recovery re-applies a computer-reported deletion on
          // every pass) of an already removed chat must not re-fence its task
          // forever: no unacknowledged target would ever clear the flag.
          sql: "UPDATE chat_ownership SET cleanup_pending=EXISTS(SELECT 1 FROM chat_deletion_targets WHERE conversation_id=? AND acknowledged=0) WHERE id=? AND state='deleted'",
          params: [id, id]
        }
      ])
      if (before) notifyChatOwnershipChange(db, [before.tabId])
    },
    async deleteForTask(taskId: string) {
      const before = await api.forTask(taskId)
      await db.batchTxn([
        {
          type: 'run',
          sql: "INSERT INTO chat_task_lifecycle(task_id,state) VALUES(?,'deleted') ON CONFLICT(task_id) DO UPDATE SET state='deleted',revision=revision+CASE WHEN state='deleted' THEN 0 ELSE 1 END",
          params: [taskId]
        },
        {
          type: 'run',
          sql: "UPDATE chat_ownership SET state='deleted',epoch=epoch+1,cleanup_pending=1 WHERE task_id=? AND state<>'deleted'",
          params: [taskId]
        },
        // Every computer of the task and each conversation's own computers. The
        // flag follows (schema trigger): pending exactly while a target is unacked.
        ...[
          `SELECT o.id,c.computer_id,o.epoch FROM chat_ownership o JOIN chat_task_computers c ON c.task_id=o.task_id WHERE o.task_id=? AND o.state=? AND ${notRetired('c.computer_id')}`,
          ...['computer_id', 'source_computer_id', 'destination_computer_id'].map(
            (column) =>
              `SELECT id,${column},epoch FROM chat_ownership WHERE task_id=? AND state=? AND ${column} IS NOT NULL AND ${notRetired(column)}`
          )
        ].map((select) => ({
          type: 'run' as const,
          sql: `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch) ${select}
      ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END`,
          params: [taskId, 'deleted']
        }))
      ])
      notifyChatOwnershipChange(
        db,
        before.filter((o) => o.state !== 'deleted').map((o) => o.tabId)
      )
    },
    /** Subscribe to {@link notifyChatOwnershipChange} on this database; returns unsubscribe. */
    onChange(listener: ChangeListener): () => void {
      let set = changeListeners.get(db)
      if (!set) changeListeners.set(db, (set = new Set()))
      set.add(listener)
      return () => set.delete(listener)
    },
    /**
     * A conversation a computer deleted that the hub does not know: kept as a
     * standalone tombstone bound to no tab. It deletes nothing else, and later
     * reports of it are recognised as already applied.
     */
    async recordTombstone(
      identity: Pick<HubChatOwnership, 'id' | 'taskId' | 'tabId' | 'mode' | 'epoch'>
    ) {
      await db.run(
        `INSERT INTO chat_ownership(id,task_id,tab_id,mode,epoch,state) VALUES(?,?,?,?,?,'deleted')
        ON CONFLICT(id) DO UPDATE SET epoch=MAX(chat_ownership.epoch,excluded.epoch) WHERE chat_ownership.state='deleted'`,
        [identity.id, identity.taskId, identity.tabId, identity.mode, identity.epoch]
      )
    },
    /**
     * A computer still holds a conversation the hub deleted: deliver the
     * deletion to it (again). The existing delivery removes it there.
     */
    async queueDeletion(id: string, computerId: string, epoch: number) {
      await db.run(
        `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
        SELECT id,?,MAX(epoch,?) FROM chat_ownership WHERE id=? AND state='deleted'
        ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=0`,
        [computerId, epoch, id]
      )
    },
    /** The computer reported it no longer holds this deleted conversation. */
    async acknowledgeRemoved(id: string, computerId: string) {
      await db.run(
        "UPDATE chat_deletion_targets SET acknowledged=1 WHERE conversation_id=? AND computer_id=? AND acknowledged=0 AND EXISTS(SELECT 1 FROM chat_ownership WHERE id=? AND state='deleted')",
        [id, computerId, id]
      )
    },
    async isRetired(computerId: string) {
      return !!(await db.get(`SELECT 1 WHERE ${retiredComputerSql('?')}`, [computerId]))
    },
    async pendingDeletions(computerId: string) {
      return db.all<{ conversationId: string; epoch: number }>(
        'SELECT conversation_id AS conversationId,epoch FROM chat_deletion_targets WHERE computer_id=? AND acknowledged=0 ORDER BY conversation_id',
        [computerId]
      )
    },
    async acknowledgeDeletion(id: string, computerId: string, epoch: number) {
      await db.batchTxn([
        {
          type: 'run',
          sql: 'UPDATE chat_deletion_targets SET acknowledged=1 WHERE conversation_id=? AND computer_id=? AND epoch=?',
          params: [id, computerId, epoch]
        },
        {
          type: 'run',
          sql: "UPDATE chat_ownership SET cleanup_pending=0 WHERE id=? AND state='deleted' AND NOT EXISTS(SELECT 1 FROM chat_deletion_targets WHERE conversation_id=? AND acknowledged=0)",
          params: [id, id]
        }
      ])
    }
  }
  return api
}
export type ChatOwnershipStore = ReturnType<typeof createChatOwnershipStore>

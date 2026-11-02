import { terminalModeForChat } from '@slayzone/terminal-contracts'
import type { SlayzoneDb } from '@slayzone/platform'

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
const providerMode = (mode: string) => terminalModeForChat(mode) ?? mode
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
    async forProviderSession(id: string, mode: string) {
      const row = await db.get<Row>(
        'SELECT c.* FROM chat_ownership c JOIN chat_provider_bindings b ON b.conversation_id=c.id WHERE b.provider_session_id=? AND b.mode=?',
        [id, providerMode(mode)]
      )
      return row ? fromRow(row) : null
    },
    async register(
      value: Pick<HubChatOwnership, 'id' | 'taskId' | 'tabId' | 'mode' | 'computerId' | 'epoch'>
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
            value.id
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
      await db.run(
        `UPDATE chat_ownership SET computer_id=destination_computer_id,epoch=epoch+1,state='active',cleanup_pending=1
    WHERE id=? AND migration_id=? AND manifest_hash=? AND state='verified' AND epoch<?`,
        [id, migrationId, hash, Number.MAX_SAFE_INTEGER]
      )
      const r = await required(id)
      if (r.state !== 'active' || r.migrationId !== migrationId || r.manifestHash !== hash)
        throw new Error('Migration must be verified before ownership commit')
      return r
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
    async deleteForTask(taskId: string) {
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
        ...['computer_id', 'source_computer_id', 'destination_computer_id'].map((column) => ({
          type: 'run' as const,
          sql: `INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch)
      SELECT id,${column},epoch FROM chat_ownership WHERE task_id=? AND state='deleted' AND ${column} IS NOT NULL
      ON CONFLICT(conversation_id,computer_id) DO UPDATE SET epoch=MAX(chat_deletion_targets.epoch,excluded.epoch),acknowledged=CASE WHEN excluded.epoch>chat_deletion_targets.epoch THEN 0 ELSE chat_deletion_targets.acknowledged END`,
          params: [taskId]
        }))
      ])
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
    },
    async bindProvider(id: string, providerSessionId: string, mode: string) {
      await db.run(
        'INSERT INTO chat_provider_bindings VALUES(?,?,?) ON CONFLICT(provider_session_id,mode) DO NOTHING',
        [providerSessionId, providerMode(mode), id]
      )
      const row = await api.forProviderSession(providerSessionId, mode)
      if (row?.id !== id) {
        const target = await required(id)
        if (
          !row ||
          row.taskId !== target.taskId ||
          row.computerId !== target.computerId ||
          row.state !== 'active' ||
          target.state !== 'active'
        )
          throw new Error('Provider conversation belongs to another storage owner')
      }
    },
    async setQueueRoute(id: string, conversationId: string, removed = false) {
      const r = await required(conversationId)
      if (removed) {
        await db.run('DELETE FROM chat_queue_routes WHERE id=? AND conversation_id=?', [
          id,
          conversationId
        ])
        return
      }
      await db.run('INSERT INTO chat_queue_routes VALUES(?,?,?) ON CONFLICT(id) DO NOTHING', [
        id,
        r.tabId,
        conversationId
      ])
      const previous = await db.get<{ conversation_id: string }>(
        'SELECT conversation_id FROM chat_queue_routes WHERE id=?',
        [id]
      )
      if (previous?.conversation_id !== conversationId)
        throw new Error('Queue item ownership conflict')
    },
    async forQueueItem(id: string) {
      const row = await db.get<Row>(
        'SELECT c.* FROM chat_ownership c JOIN chat_queue_routes q ON q.conversation_id=c.id WHERE q.id=?',
        [id]
      )
      return row ? fromRow(row) : null
    }
  }
  return api
}
export type ChatOwnershipStore = ReturnType<typeof createChatOwnershipStore>

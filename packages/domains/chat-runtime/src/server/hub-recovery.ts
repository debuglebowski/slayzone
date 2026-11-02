import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatOwnership } from '../shared'
import { createChatOwnershipStore } from './hub-ownership'
import type { ChatComputerRequest } from './migration'

export interface ComputerChatInventory extends ChatOwnership {
  inbox?: boolean
  lifecycle?: { state: 'active' | 'paused' | 'deleted'; revision: number }
  bootstrapRevision: number
}
/** Computer commits and tombstones survive restoring an older hub database. */
export function createChatRecovery(opts: {
  db: SlayzoneDb
  request: ChatComputerRequest
  gate?(computerId: string, taskId: string): Promise<void>
}) {
  const { db } = opts,
    owners = createChatOwnershipStore(db),
    pending = new Map<string, Promise<void>>()
  async function run(computerId: string) {
    const inventory = (await opts.request(computerId, {
      kind: 'inventory'
    })) as ComputerChatInventory[]
    if (!Array.isArray(inventory)) throw new Error('Invalid computer chat inventory')
    for (const entry of inventory) {
      const i = entry.identity
      if (
        !i ||
        !Number.isSafeInteger(i.epoch) ||
        i.epoch < 1 ||
        !Number.isSafeInteger(entry.bootstrapRevision) ||
        entry.bootstrapRevision < 0
      )
        throw new Error('Invalid computer ownership')
      if (i.id.startsWith('task-tombstone:')) {
        if (entry.state === 'deleted') await owners.deleteForTask(i.taskId)
        continue
      }
      // Retain history whose task postdates the restored hub. Never delete it by inference.
      if (!(await db.get('SELECT 1 FROM tasks WHERE id=?', [i.taskId]))) continue
      await db.run(
        'INSERT INTO chat_task_computers VALUES(?,?) ON CONFLICT(task_id,computer_id) DO NOTHING',
        [i.taskId, computerId]
      )
      if (entry.lifecycle) {
        const current = await db.get<{ state: string; revision: number }>(
          'SELECT state,revision FROM chat_task_lifecycle WHERE task_id=?',
          [i.taskId]
        )
        if (entry.lifecycle.state === 'deleted') {
          await owners.deleteForTask(i.taskId)
          continue
        }
        if (current && entry.lifecycle.revision >= current.revision) {
          await db.run('UPDATE chat_task_lifecycle SET revision=? WHERE task_id=?', [
            entry.lifecycle.revision + (current.state !== entry.lifecycle.state ? 1 : 0),
            i.taskId
          ])
          await db.run('DELETE FROM chat_lifecycle_acks WHERE task_id=? AND computer_id=?', [
            i.taskId,
            computerId
          ])
        }
      }
      if (entry.inbox) continue
      if (entry.state !== 'active') continue
      if (
        await db.get("SELECT 1 FROM chat_task_lifecycle WHERE task_id=? AND state='deleted'", [
          i.taskId
        ])
      )
        continue
      await opts.gate?.(computerId, i.taskId)
      const previous = await owners.forTab(i.tabId)
      if (previous?.state === 'deleted') continue
      if (previous && (previous.taskId !== i.taskId || previous.mode !== i.mode))
        throw new Error('Computer chat identity conflict')
      if (previous?.computerId && (previous.computerId !== computerId || previous.id !== i.id))
        throw new Error('Chat tab has another active owner')
      if (previous && previous.epoch > i.epoch)
        throw new Error('Computer chat ownership is behind the hub')
      if (
        previous &&
        (previous.id !== i.id || previous.epoch < i.epoch) &&
        (!entry.migrationId || !entry.migrationHash)
      )
        throw new Error('Newer computer ownership requires a committed migration proof')
      if (entry.migrationHash && !/^[a-f0-9]{64}$/.test(entry.migrationHash))
        throw new Error('Invalid migration proof')
      const tab = await db.get<{ task_id: string }>(
        'SELECT task_id FROM terminal_tabs WHERE id=?',
        [i.tabId]
      )
      if (tab && tab.task_id !== i.taskId) throw new Error('Chat tab task conflict')
      if (!tab)
        await db.run(
          "INSERT INTO terminal_tabs(id,task_id,label,mode,position) VALUES(?,?,'Chat',?,(SELECT COALESCE(MAX(position),-1)+1 FROM terminal_tabs WHERE task_id=?))",
          [i.tabId, i.taskId, i.mode, i.taskId]
        )
      const replace = previous && previous.id !== i.id
      await db.batchTxn([
        ...(replace
          ? [
              {
                type: 'run' as const,
                sql: "DELETE FROM chat_tab_bindings WHERE tab_id=? AND conversation_id=? AND EXISTS(SELECT 1 FROM chat_ownership WHERE id=? AND computer_id IS NULL AND state IN ('legacy','copying','verified'))",
                params: [i.tabId, previous.id, previous.id]
              }
            ]
          : []),
        {
          type: 'run',
          sql: `INSERT INTO chat_ownership(id,task_id,tab_id,mode,computer_id,epoch,state,migration_id,destination_computer_id,manifest_hash,cleanup_pending,settings_revision)
     SELECT ?,?,?,?,?,?,'active',?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE tab_id=? AND conversation_id<>?)
     ON CONFLICT(id) DO UPDATE SET computer_id=excluded.computer_id,epoch=excluded.epoch,state='active',migration_id=excluded.migration_id,destination_computer_id=excluded.destination_computer_id,manifest_hash=excluded.manifest_hash,cleanup_pending=CASE WHEN chat_ownership.epoch<excluded.epoch OR chat_ownership.state<>'active' THEN excluded.cleanup_pending ELSE chat_ownership.cleanup_pending END,settings_revision=MAX(chat_ownership.settings_revision,excluded.settings_revision),settings_hash=NULL
     WHERE chat_ownership.task_id=excluded.task_id AND chat_ownership.tab_id=excluded.tab_id AND chat_ownership.mode=excluded.mode AND chat_ownership.state<>'deleted' AND chat_ownership.epoch<=excluded.epoch AND (chat_ownership.computer_id IS NULL OR chat_ownership.computer_id=excluded.computer_id)`,
          params: [
            i.id,
            i.taskId,
            i.tabId,
            i.mode,
            computerId,
            i.epoch,
            entry.migrationId,
            computerId,
            entry.migrationHash,
            entry.migrationId ? 1 : 0,
            entry.bootstrapRevision,
            i.tabId,
            i.id
          ]
        },
        {
          type: 'run',
          sql: "INSERT INTO chat_tab_bindings(tab_id,conversation_id) SELECT ?,id FROM chat_ownership WHERE id=? AND computer_id=? AND epoch=? AND state='active' ON CONFLICT(tab_id) DO NOTHING",
          params: [i.tabId, i.id, computerId, i.epoch]
        }
      ])
      const adopted = await owners.forTab(i.tabId)
      if (adopted?.id !== i.id || adopted.computerId !== computerId || adopted.epoch !== i.epoch)
        throw new Error('Chat ownership changed during recovery')
      // The replaced unbound row is only a stale locator, never a second owner.
      if (replace)
        await db.run(
          "UPDATE chat_ownership SET state='deleted',epoch=epoch+1,cleanup_pending=0 WHERE id=? AND computer_id IS NULL AND NOT EXISTS(SELECT 1 FROM chat_tab_bindings WHERE conversation_id=?)",
          [previous.id, previous.id]
        )
    }
  }
  return {
    reconcile(computerId: string) {
      const current = pending.get(computerId)
      if (current) return current
      const work = run(computerId).finally(() => pending.delete(computerId))
      pending.set(computerId, work)
      return work
    }
  }
}

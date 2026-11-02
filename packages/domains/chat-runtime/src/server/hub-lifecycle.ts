import type { SlayzoneDb } from '@slayzone/platform'
import type { ChatComputerRequest } from './migration'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatFolderDeletions } from './hub-folders'

type State = 'active' | 'paused' | 'deleted'
interface Lifecycle {
  taskId: string
  state: State
  revision: number
}
/** Per-computer barrier. A failed delivery never becomes an acknowledgement. */
export function createChatLifecycle(opts: { db: SlayzoneDb; request: ChatComputerRequest }) {
  const { db } = opts,
    ownership = createChatOwnershipStore(db),
    pending = new Map<string, Promise<void>>()
  async function deliverDeletions(computerId: string) {
    for (const target of await ownership.pendingDeletions(computerId)) {
      const owner = await ownership.get(target.conversationId)
      if (!owner || owner.state !== 'deleted') throw new Error('Deletion owner is unavailable')
      await opts.request(computerId, {
        kind: 'conversation.delete',
        identity: {
          id: owner.id,
          taskId: owner.taskId,
          tabId: owner.tabId,
          mode: owner.mode,
          epoch: target.epoch
        }
      })
      await ownership.acknowledgeDeletion(owner.id, computerId, target.epoch)
    }
  }
  async function run(computerId: string) {
    for (;;) {
      const rows = await db.all<Lifecycle>(
        `SELECT l.task_id AS taskId,l.state,l.revision FROM chat_task_lifecycle l JOIN chat_task_computers c ON c.task_id=l.task_id LEFT JOIN chat_lifecycle_acks a ON a.task_id=l.task_id AND a.computer_id=c.computer_id WHERE c.computer_id=? AND COALESCE(a.revision,0)<l.revision ORDER BY l.task_id`,
        [computerId]
      )
      if (!rows.length) {
        await deliverDeletions(computerId)
        await createChatFolderDeletions(db).sync(computerId, opts.request)
        return
      }
      for (const row of rows) {
        const reply = (await opts.request(computerId, { kind: 'task.lifecycle', ...row })) as {
          state: State
          revision: number
        }
        if (!reply || !Number.isSafeInteger(reply.revision) || reply.revision < 1)
          throw new Error('Invalid computer lifecycle acknowledgement')
        if (reply.state === 'deleted' && row.state !== 'deleted') {
          // A restored hub must honor a deletion already committed on the computer.
          await ownership.deleteForTask(row.taskId)
          await db.run('UPDATE chat_task_lifecycle SET revision=MAX(revision,?) WHERE task_id=?', [
            reply.revision,
            row.taskId
          ])
          continue
        }
        if (reply.state !== row.state || reply.revision < row.revision)
          throw new Error('Computer has newer task state; reconcile ownership before commands')
        await db.batchTxn([
          {
            type: 'run',
            sql: 'INSERT INTO chat_lifecycle_acks VALUES(?,?,?) ON CONFLICT(task_id,computer_id) DO UPDATE SET revision=MAX(chat_lifecycle_acks.revision,excluded.revision)',
            params: [row.taskId, computerId, row.revision]
          },
          ...(row.state === 'deleted'
            ? [
                {
                  type: 'run' as const,
                  sql: "UPDATE chat_deletion_targets SET acknowledged=1 WHERE computer_id=? AND conversation_id IN(SELECT id FROM chat_ownership WHERE task_id=? AND state='deleted')",
                  params: [computerId, row.taskId]
                },
                {
                  type: 'run' as const,
                  sql: "UPDATE chat_ownership SET cleanup_pending=0 WHERE task_id=? AND state='deleted' AND NOT EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=chat_ownership.id AND d.acknowledged=0)",
                  params: [row.taskId]
                }
              ]
            : [])
        ])
      }
    }
  }
  function sync(computerId: string) {
    const existing = pending.get(computerId)
    if (existing) return existing
    const work = run(computerId).finally(() => {
      pending.delete(computerId)
    })
    pending.set(computerId, work)
    return work
  }
  return {
    sync,
    async track(taskId: string, computerId: string) {
      await db.run('INSERT OR IGNORE INTO chat_task_computers VALUES(?,?)', [taskId, computerId])
    },
    async syncTask(taskId: string) {
      const targets = await db.all<{ computer_id: string }>(
        'SELECT computer_id FROM chat_task_computers WHERE task_id=?',
        [taskId]
      )
      await Promise.all(targets.map((t) => sync(t.computer_id)))
    },
    async request(computerId: string, request: unknown) {
      await sync(computerId)
      return opts.request(computerId, request)
    }
  }
}

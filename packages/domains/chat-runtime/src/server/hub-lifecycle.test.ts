import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from '../../../../shared/db-migrations/src/migrations'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatLifecycle } from './hub-lifecycle'

test('reconnect barrier delivers lifecycle before commands and never acknowledges a failed deletion', async () => {
  const db = new Database(':memory:')
  migrations.find((m) => m.version === 184)!.up(db)
  try {
    const adapter = createSlayzoneDbAdapter(db),
      ownership = createChatOwnershipStore(adapter)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    db.prepare("INSERT INTO chat_task_lifecycle VALUES('task','paused',2)").run()
    const calls: string[] = []
    let offline = true
    const raw = async (_pc: string, input: unknown): Promise<unknown> => {
      const p = input as { kind: string; state: string; revision: number }
      calls.push(p.kind)
      if (offline) throw new Error('Offline')
      return p.kind === 'task.lifecycle' ? { state: p.state, revision: p.revision } : { ok: true }
    }
    const lifecycle = createChatLifecycle({ db: adapter, request: raw })
    await expect(lifecycle.request('pc', { kind: 'invoke' })).rejects.toThrow('Offline')
    expect(calls).toEqual(['task.lifecycle'])
    expect(db.prepare('SELECT * FROM chat_lifecycle_acks').all()).toEqual([])
    offline = false
    await lifecycle.request('pc', { kind: 'invoke' })
    expect(calls).toEqual(['task.lifecycle', 'task.lifecycle', 'invoke'])
    await ownership.deleteForTask('task')
    await lifecycle.request('pc', { kind: 'inspect' })
    expect(calls.slice(-2)).toEqual(['task.lifecycle', 'inspect'])
    expect(await ownership.pendingDeletions('pc')).toEqual([])
    expect(await ownership.forTab('tab')).toMatchObject({ state: 'deleted', cleanupPending: false })
  } finally {
    db.close()
  }
})

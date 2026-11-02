import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { migrations } from '../../../../shared/db-migrations/src/migrations'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatLifecycle } from './hub-lifecycle'

test('reconnect barrier delivers lifecycle before commands and never acknowledges a failed deletion', async () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,deleted_at TEXT,archived_at TEXT)')
  for (const migration of migrations.filter((m) => m.version >= 187)) migration.up(db)
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

test('tab deletion keeps durable targets while other task conversations stay active', async () => {
  const { createTestHarness } = await import('../../../../shared/test-utils/ipc-harness')
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    await owners.register({
      id: 'c',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    await owners.register({
      id: 'files',
      taskId: 't',
      tabId: 'artifact-store:t:pc',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    h.db.prepare("DELETE FROM terminal_tabs WHERE id='tab'").run()
    expect(await owners.get('c')).toMatchObject({ state: 'deleted', epoch: 2 })
    expect(await owners.get('files')).toMatchObject({ state: 'active', epoch: 1 })
    const calls: string[] = []
    const lifecycle = createChatLifecycle({
      db: h.slayDb,
      request: async (_pc, raw) => {
        const p = raw as { kind: string; state: string; revision: number }
        calls.push(p.kind)
        return p.kind === 'task.lifecycle' ? { state: p.state, revision: p.revision } : { ok: true }
      }
    })
    await lifecycle.request('pc', { kind: 'inspect' })
    expect(calls).toContain('conversation.delete')
    expect(await owners.pendingDeletions('pc')).toEqual([])
  } finally {
    h.cleanup()
  }
})

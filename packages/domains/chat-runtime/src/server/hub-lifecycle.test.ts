import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatLifecycle } from './hub-lifecycle'

test('reconnect barrier delivers lifecycle before commands and never acknowledges a failed deletion', async () => {
  // The real, fully migrated hub schema: a hand-picked slice of migrations on a
  // skeleton DB broke on every later migration that touches a table it lacks.
  const h = await createTestHarness()
  const db = h.db
  try {
    const adapter = h.slayDb,
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
      // Offline = the transport's not-connected error: no task can be delivered.
      if (offline) throw Object.assign(new Error('Offline'), { name: 'RpcError', code: -32004 })
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
    h.cleanup()
  }
})

test('tab deletion keeps durable targets while other task conversations stay active', async () => {
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

test('re-deleting an acknowledged deleted chat (recovery does, every pass) does not leave its task blocked', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
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
    const lifecycle = createChatLifecycle({
      db: h.slayDb,
      request: async (_pc, raw) => {
        const p = raw as { kind: string; state?: string; revision?: number }
        return p.kind === 'task.lifecycle' ? { state: p.state, revision: p.revision } : { ok: true }
      }
    })
    await lifecycle.track('t', 'pc')
    await owners.deleteConversation('c')
    await lifecycle.sync('pc')
    expect(await owners.get('c')).toMatchObject({ state: 'deleted', cleanupPending: false })
    // The computer still lists the deleted conversation; recovery deletes it again.
    const epoch = (await owners.get('c'))!.epoch
    await owners.deleteConversation('c', epoch)
    await lifecycle.sync('pc')
    expect(await owners.get('c')).toMatchObject({ state: 'deleted', cleanupPending: false })
  } finally {
    h.cleanup()
  }
})

test('a deleted chat left marked pending with every removal acknowledged is cleared', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
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
    // The state older hubs left behind.
    h.db
      .prepare("UPDATE chat_ownership SET state='deleted',epoch=3,cleanup_pending=1 WHERE id='c'")
      .run()
    h.db
      .prepare(
        "INSERT INTO chat_deletion_targets(conversation_id,computer_id,epoch,acknowledged) VALUES('c','pc',3,1)"
      )
      .run()
    const lifecycle = createChatLifecycle({ db: h.slayDb, request: async () => ({ ok: true }) })
    await lifecycle.sync('pc')
    expect(await owners.get('c')).toMatchObject({ cleanupPending: false })
  } finally {
    h.cleanup()
  }
})

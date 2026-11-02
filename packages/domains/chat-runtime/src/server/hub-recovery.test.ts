import { expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatRecovery } from './hub-recovery'

test('restored hub adopts committed computer ownership; conflicting active owner is fenced', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
    )
    const owners = createChatOwnershipStore(h.slayDb)
    await owners.register({
      id: 'stale',
      taskId: 't',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: null,
      epoch: 1
    })
    const inventory = [
      {
        identity: { id: 'actual', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 2 },
        state: 'active',
        migrationId: 'move',
        migrationHash: 'a'.repeat(64),
        bootstrapRevision: 8
      }
    ]
    const recovery = createChatRecovery({ db: h.slayDb, request: async () => inventory })
    await recovery.reconcile('pc')
    expect(await owners.forTab('tab')).toMatchObject({
      id: 'actual',
      computerId: 'pc',
      epoch: 2,
      cleanupPending: true,
      settingsRevision: 8
    })
    await recovery.reconcile('pc')
    await expect(recovery.reconcile('other')).rejects.toThrow(/conflict|another/i)
    expect(await owners.forTab('tab')).toMatchObject({ computerId: 'pc' })
  } finally {
    h.cleanup()
  }
})

test('computer deletion survives restoring a hub snapshot with active task metadata', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
    )
    const recovery = createChatRecovery({
      db: h.slayDb,
      request: async () => [
        {
          identity: {
            id: 'task-tombstone:t',
            taskId: 't',
            tabId: 'task-tombstone:t',
            mode: 'claude-chat',
            epoch: 2
          },
          state: 'deleted',
          migrationId: null,
          migrationHash: null,
          bootstrapRevision: 0
        }
      ]
    })
    await recovery.reconcile('pc')
    expect(h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='t'").get()).toEqual({
      state: 'deleted'
    })
  } finally {
    h.cleanup()
  }
})

test('computer inventory cannot apply lifecycle or deletion before task authorization', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','Project','#000'); INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task')"
    )
    for (const entry of [
      { id: 'task-tombstone:t', tabId: 'task-tombstone:t', state: 'deleted' },
      {
        id: 'conversation',
        tabId: 'tab',
        state: 'active',
        lifecycle: { state: 'deleted', revision: 99 }
      }
    ]) {
      const recovery = createChatRecovery({
        db: h.slayDb,
        gate: async () => {
          throw new Error('Not your task')
        },
        request: async () => [
          {
            ...entry,
            identity: {
              id: entry.id,
              taskId: 't',
              tabId: entry.tabId,
              mode: 'claude-chat',
              epoch: 2
            },
            migrationId: null,
            migrationHash: null,
            bootstrapRevision: 0
          }
        ]
      })
      await expect(recovery.reconcile('unrelated-pc')).rejects.toThrow('Not your task')
      expect(h.db.prepare("SELECT state FROM chat_task_lifecycle WHERE task_id='t'").get()).toEqual(
        { state: 'active' }
      )
      expect(h.db.prepare('SELECT count(*) AS n FROM chat_task_computers').get()).toEqual({ n: 0 })
    }
  } finally {
    h.cleanup()
  }
})

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

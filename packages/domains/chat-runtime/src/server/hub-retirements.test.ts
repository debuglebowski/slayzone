import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import { createChatRecovery } from './hub-recovery'
import { applyComputerRetirements } from './hub-retirements'

async function fixture() {
  const h = await createTestHarness()
  h.db.exec(`INSERT INTO projects(id,name,color) VALUES('p','Project','#000');
    INSERT INTO tasks(id,project_id,title) VALUES('t','p','Task');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0),('tab2','t','claude-chat',1)`)
  const owners = createChatOwnershipStore(h.slayDb)
  await owners.register({
    id: 'live',
    taskId: 't',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'old',
    epoch: 1
  })
  // A deleted chat whose removal 'old' never acknowledged.
  await owners.register({
    id: 'gone',
    taskId: 't',
    tabId: 'tab2',
    mode: 'claude-chat',
    computerId: 'old',
    epoch: 1
  })
  h.db.exec("DELETE FROM terminal_tabs WHERE id='tab2'")
  h.db.exec(`INSERT INTO chat_lifecycle_acks VALUES('t','old',1);
    INSERT INTO chat_provider_transitions VALUES('x','live','t','tab','arch','next','codex-chat','old',1,'reserved')`)
  const retire = (successor: string | null) =>
    h.db
      .prepare(
        "INSERT INTO computer_retirements VALUES('old',?,CASE WHEN ? IS NULL THEN 'deleted' ELSE 're-enrolled' END,0)"
      )
      .run(successor, successor)
  const names = (id: string) =>
    h.db
      .prepare(
        `SELECT 'ownership' AS t FROM chat_ownership WHERE ? IN (computer_id,source_computer_id,destination_computer_id)
        UNION ALL SELECT 'task' FROM chat_task_computers WHERE computer_id=?
        UNION ALL SELECT 'target' FROM chat_deletion_targets WHERE computer_id=? AND acknowledged=0
        UNION ALL SELECT 'ack' FROM chat_lifecycle_acks WHERE computer_id=?
        UNION ALL SELECT 'transition' FROM chat_provider_transitions WHERE computer_id=? AND state='reserved'`
      )
      .all(id, id, id, id, id)
      .map((r) => (r as { t: string }).t)
      .filter((t, i, all) => all.indexOf(t) === i)
      .sort()
  return { h, owners, retire, names }
}

test('a re-enrolled computer: every chat record moves to its successor', async () => {
  const { h, owners, retire, names } = await fixture()
  try {
    retire('new')
    await applyComputerRetirements(h.slayDb)
    await applyComputerRetirements(h.slayDb)
    expect(names('old')).toEqual([])
    expect(names('new')).toEqual(['ownership', 'target', 'task', 'transition'])
    expect(await owners.get('live')).toMatchObject({ computerId: 'new', state: 'active' })
    // Delivery restarts at the successor: the old acks are gone, the pending
    // removal now waits on the successor.
    expect(await owners.pendingDeletions('new')).toEqual([{ conversationId: 'gone', epoch: 2 }])
  } finally {
    h.cleanup()
  }
})

test('chained re-enrollments resolve to the newest id', async () => {
  const { h, owners, retire } = await fixture()
  try {
    retire('mid')
    h.db.exec("INSERT INTO computer_retirements VALUES('mid','newest','re-enrolled',0)")
    await applyComputerRetirements(h.slayDb)
    expect(await owners.get('live')).toMatchObject({ computerId: 'newest' })
  } finally {
    h.cleanup()
  }
})

test('a deleted computer: its pending work is retired with a reason, its chats wait as unavailable', async () => {
  const { h, owners, retire, names } = await fixture()
  try {
    retire(null)
    await applyComputerRetirements(h.slayDb)
    await applyComputerRetirements(h.slayDb)
    expect(names('old')).toEqual(['ownership'])
    // Nothing pending blocks the task any more.
    expect(await owners.get('gone')).toMatchObject({ state: 'deleted', cleanupPending: false })
    expect(
      h.db.prepare('SELECT kind,item_id,reason FROM chat_retired_work ORDER BY kind').all()
    ).toEqual([
      { kind: 'deletion', item_id: 'gone', reason: 'deleted' },
      { kind: 'provider-transition', item_id: 'x', reason: 'deleted' }
    ])
    expect(await owners.unavailable('live')).toMatchObject({
      reason: expect.stringMatching(/computer was removed/i)
    })
  } finally {
    h.cleanup()
  }
})

test('a chat on a removed computer is adopted by the computer that reports it', async () => {
  const { h, owners, retire } = await fixture()
  try {
    retire(null)
    await applyComputerRetirements(h.slayDb)
    const failures: string[] = []
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recovery = createChatRecovery({
      db: h.slayDb,
      onConversationFailure: (_pc, id, error) => failures.push(`${id}:${error.message}`),
      request: async () => [
        {
          identity: { id: 'live', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
          state: 'active',
          migrationId: null,
          migrationHash: null,
          bootstrapRevision: 0
        }
      ]
    })
    await recovery.reconcile('restored')
    errors.mockRestore()
    expect(failures).toEqual([])
    expect(await owners.forTab('tab')).toMatchObject({ id: 'live', computerId: 'restored' })
    expect(await owners.unavailable('live')).toBeUndefined()
  } finally {
    h.cleanup()
  }
})

test('a revoked computer is not retired: its work waits for it', async () => {
  const { h, owners, names } = await fixture()
  try {
    await applyComputerRetirements(h.slayDb)
    expect(names('old')).toEqual(['ack', 'ownership', 'target', 'task', 'transition'])
    expect(await owners.get('live')).toMatchObject({ computerId: 'old' })
  } finally {
    h.cleanup()
  }
})

import { afterEach, expect, test } from 'vitest'
import { createTestHarness, type TestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
const harnesses: TestHarness[] = []
afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup()
})
// The real, fully migrated hub schema: a hand-picked slice of migrations on a
// skeleton DB broke on every later migration that touches a table it lacks.
async function fixture() {
  const h = await createTestHarness()
  harnesses.push(h)
  return { db: h.db, store: createChatOwnershipStore(h.slayDb) }
}
const route = {
  id: 'storage',
  taskId: 'task',
  tabId: 'tab',
  mode: 'claude-chat',
  computerId: 'pc-a',
  epoch: 1
}
test('ownership changes only after verification and rejects stale writers', async () => {
  const { store } = await fixture()
  await store.register(route)
  await store.beginMigration('storage', {
    expectedComputerId: 'pc-a',
    expectedEpoch: 1,
    migrationId: 'move',
    destinationComputerId: 'pc-b'
  })
  await expect(store.commitMigration('storage', 'move', 'a'.repeat(64))).rejects.toThrow(
    /verified/i
  )
  await store.markVerified('storage', 'move', 'a'.repeat(64))
  expect(await store.commitMigration('storage', 'move', 'a'.repeat(64))).toMatchObject({
    computerId: 'pc-b',
    epoch: 2,
    cleanupPending: true
  })
  expect(await store.commitMigration('storage', 'move', 'a'.repeat(64))).toMatchObject({ epoch: 2 })
  await expect(
    store.beginMigration('storage', {
      expectedComputerId: 'pc-a',
      expectedEpoch: 1,
      migrationId: 'stale',
      destinationComputerId: 'pc-c'
    })
  ).rejects.toThrow(/ownership/i)
})
test('registering another owner cannot overwrite an existing conversation or tab binding', async () => {
  const { store } = await fixture()
  await store.register(route)
  await expect(store.register({ ...route, computerId: 'pc-b' })).rejects.toThrow(/ownership/i)
  await expect(store.register({ ...route, id: 'another' })).rejects.toThrow(/binding/i)
  expect(await store.forTab('tab')).toMatchObject({ id: 'storage', computerId: 'pc-a' })
})
test('deletion metadata survives independently of task/tab rows', async () => {
  const { store, db } = await fixture()
  await store.register(route)
  await store.deleteForTask('task')
  expect(await store.forTab('tab')).toMatchObject({ state: 'deleted', epoch: 2 })
  await expect(store.register(route)).rejects.toThrow(/deleted/i)
  expect(db.prepare('SELECT count(*) AS n FROM chat_ownership').get()).toEqual({ n: 1 })
})

test('a rejected registration cannot leave an alias to another task conversation', async () => {
  const { store } = await fixture()
  await store.register(route)
  await expect(
    store.register({ ...route, taskId: 'foreign-task', tabId: 'foreign-tab' })
  ).rejects.toThrow(/ownership/i)
  expect(await store.forTab('foreign-tab')).toBeNull()
})
test('stale deletion acknowledgements cannot clear the reconnect barrier', async () => {
  const { store } = await fixture()
  await store.register(route)
  await store.deleteForTask('task')
  await store.deleteForTask('task')
  expect(await store.pendingDeletions('pc-a')).toEqual([{ conversationId: 'storage', epoch: 2 }])
  await store.acknowledgeDeletion('storage', 'pc-a', 1)
  expect(await store.pendingDeletions('pc-a')).toHaveLength(1)
  await store.acknowledgeDeletion('storage', 'pc-a', 2)
  expect(await store.pendingDeletions('pc-a')).toEqual([])
  expect(await store.get('storage')).toMatchObject({ state: 'deleted', cleanupPending: false })
})

test('every ownership move, provider transition or deletion signals the tabs it took away, across store instances', async () => {
  const { store } = await fixture()
  const watcher = createChatOwnershipStore(harnesses[0]!.slayDb)
  const moved: string[][] = []
  const off = watcher.onChange((tabIds) => moved.push([...tabIds]))
  await store.register(route)
  expect(moved).toEqual([])
  await store.beginMigration('storage', {
    expectedComputerId: 'pc-a',
    expectedEpoch: 1,
    migrationId: 'move',
    destinationComputerId: 'pc-b'
  })
  await store.markVerified('storage', 'move', 'a'.repeat(64))
  await store.commitMigration('storage', 'move', 'a'.repeat(64))
  await store.deleteConversation('storage')
  expect(moved).toEqual([['tab'], ['tab'], ['tab']])
  off()
  await store.deleteForTask('task')
  expect(moved).toHaveLength(3)
})

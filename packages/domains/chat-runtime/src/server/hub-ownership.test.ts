import Database from 'better-sqlite3'
import { afterEach, expect, test } from 'vitest'
import { migrations } from '../../../../shared/db-migrations/src/migrations'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
const dbs: Database.Database[] = []
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
})
function fixture() {
  const db = new Database(':memory:')
  dbs.push(db)
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY,deleted_at TEXT,archived_at TEXT)')
  for (const migration of migrations.filter((m) => m.version >= 187)) migration.up(db)
  return { db, store: createChatOwnershipStore(createSlayzoneDbAdapter(db)) }
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
  const { store } = fixture()
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
  const { store } = fixture()
  await store.register(route)
  await expect(store.register({ ...route, computerId: 'pc-b' })).rejects.toThrow(/ownership/i)
  await expect(store.register({ ...route, id: 'another' })).rejects.toThrow(/binding/i)
  expect(await store.forTab('tab')).toMatchObject({ id: 'storage', computerId: 'pc-a' })
})
test('deletion metadata survives independently of task/tab rows', async () => {
  const { store, db } = fixture()
  await store.register(route)
  await store.deleteForTask('task')
  expect(await store.forTab('tab')).toMatchObject({ state: 'deleted', epoch: 2 })
  await expect(store.register(route)).rejects.toThrow(/deleted/i)
  expect(db.prepare('SELECT count(*) AS n FROM chat_ownership').get()).toEqual({ n: 1 })
})

test('terminal and chat modes resolve to the same provider-session owner', async () => {
  const { store } = fixture()
  await store.register(route)
  await store.bindProvider('storage', 'provider-session', 'claude-chat')
  expect(await store.forProviderSession('provider-session', 'claude-code')).toMatchObject({
    id: 'storage',
    computerId: 'pc-a'
  })
})

test('a rejected registration cannot leave an alias to another task conversation', async () => {
  const { store } = fixture()
  await store.register(route)
  await expect(
    store.register({ ...route, taskId: 'foreign-task', tabId: 'foreign-tab' })
  ).rejects.toThrow(/ownership/i)
  expect(await store.forTab('foreign-tab')).toBeNull()
})
test('stale deletion acknowledgements cannot clear the reconnect barrier', async () => {
  const { store } = fixture()
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

test('same-computer tabs can select a provider session; another computer cannot claim it', async () => {
  const { store } = fixture()
  await store.register(route)
  await store.bindProvider(route.id, 'native', 'claude-chat')
  await store.register({ ...route, id: 'second', tabId: 'tab2' })
  await expect(store.bindProvider('second', 'native', 'claude-chat')).resolves.toBeUndefined()
  await store.register({ ...route, id: 'foreign', tabId: 'tab3', computerId: 'pc-b' })
  await expect(store.bindProvider('foreign', 'native', 'claude-chat')).rejects.toThrow(/owner/i)
  expect(await store.forProviderSession('native', 'claude-code')).toMatchObject({
    computerId: 'pc-a'
  })
})

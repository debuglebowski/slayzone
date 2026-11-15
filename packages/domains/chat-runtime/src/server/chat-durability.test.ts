/**
 * S5: the store's own connection never fsyncs (NORMAL, no checkpoint); an off-thread
 * checkpointer syncs the WAL and checkpoints; `flush` is the durability barrier; a clean
 * `shutdown` loses nothing; a start after an unclean stop on another boot rotates the
 * store id (the hub re-reads, clients reload); a dead checkpointer falls back to FULL.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { killCheckpointerThreadForTests } from './checkpointer'
import { openChatStorage, type ChatStorage } from './storage'

const roots: string[] = []
const stores: ChatStorage[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const DAY = 24 * 60 * 60 * 1000
function open(root = mkdtempSync(join(tmpdir(), 'slz-chat-durable-')), bootedAt = 1_000_000) {
  if (!roots.includes(root)) roots.push(root)
  const store = openChatStorage({
    stateDir: root,
    hubScope: 'hub',
    machineBootedAt: bootedAt,
    checkpointIntervalMs: 50
  })
  stores.push(store)
  return { store, root }
}
const identity = { id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const text = (t: string) => ({ kind: 'assistant-text', messageId: t, text: t }) as const

test('commits reach the database file through the off-thread checkpointer', async () => {
  const { store } = open()
  store.createConversation(identity)
  const mark = `OFF-THREAD-${Date.now()}`
  store.append(identity.id, 1, text(mark))
  await store.flush()
  // Nothing on this thread checkpoints; the file gets the page within a few ticks.
  await vi.waitFor(() => expect(readFileSync(store.path).includes(Buffer.from(mark))).toBe(true), {
    timeout: 5000,
    interval: 50
  })
})

test('a clean shutdown checkpoints everything and is remembered: no rotation on another boot', async () => {
  const { store, root } = open()
  store.createConversation(identity)
  store.append(identity.id, 1, text('kept'))
  const id = store.storeId()
  await store.shutdown()
  stores.splice(stores.indexOf(store), 1)
  expect(existsSync(`${store.path}-wal`) ? statSync(`${store.path}-wal`).size : 0).toBe(0)
  const next = open(root, 1_000_000 + DAY).store
  expect(next.storeId()).toBe(id)
  expect(next.read(identity.id, -1)).toHaveLength(1)
})

test('an unclean stop: same boot keeps the store id; another boot rotates it', async () => {
  const { store, root } = open()
  store.createConversation(identity)
  const id = store.storeId()
  store.close() // no shutdown: a process crash
  stores.splice(stores.indexOf(store), 1)
  const sameBoot = open(root, 1_000_000 + 30_000).store // uptime drift, same boot
  expect(sameBoot.storeId()).toBe(id)
  sameBoot.close()
  stores.splice(stores.indexOf(sameBoot), 1)
  const rebooted = open(root, 1_000_000 + DAY).store // an OS crash: another boot
  expect(rebooted.storeId()).not.toBe(id)
  expect(rebooted.conversation(identity.id)?.state).toBe('active')
})

test('a dead checkpointer: the store commits with FULL again and flush still resolves', async () => {
  const { store } = open()
  store.createConversation(identity)
  await store.flush()
  await killCheckpointerThreadForTests()
  await vi.waitFor(() =>
    expect(store.compose((db) => db.pragma('synchronous', { simple: true }))).toBe(2)
  )
  expect(store.compose((db) => db.pragma('wal_autocheckpoint', { simple: true }))).toBe(1000)
  store.append(identity.id, 1, text('after'))
  await store.flush()
  // A store opened afterwards starts a new thread and runs normally.
  const other = open().store
  other.createConversation(identity)
  await other.flush()
  expect(other.compose((db) => db.pragma('synchronous', { simple: true }))).toBe(1)
})

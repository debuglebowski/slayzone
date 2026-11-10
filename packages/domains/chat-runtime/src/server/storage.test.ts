import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { openChatStorage } from './storage'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
function open(root = mkdtempSync(join(tmpdir(), 'slz-chat-store-')), scope = 'hub-a') {
  if (!roots.includes(root)) roots.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: scope })
  stores.push(store)
  return { store, root }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const identity = {
  id: 'conversation-a',
  taskId: 'task-a',
  tabId: 'tab-a',
  mode: 'claude-chat',
  epoch: 1
}
const event = { kind: 'assistant-text', messageId: 'reply-a', text: 'private reply' } as const

describe('computer-owned chat storage', () => {
  test('events survive restart, preserve timestamps and cannot overwrite history', () => {
    const { store, root } = open()
    store.createConversation(identity)
    expect(store.append(identity.id, 1, event, 123)).toMatchObject({ seq: 0, at: 123, event })
    store.close()
    const next = open(root).store
    expect(next.read(identity.id, -1)).toEqual([{ seq: 0, at: 123, event }])
    expect(next.append(identity.id, 1, event, 124).seq).toBe(1)
  })
  test('hub namespaces are isolated even with identical conversation ids', () => {
    const a = open()
    a.store.createConversation(identity)
    a.store.append(identity.id, 1, event, 1)
    const b = open(a.root, 'hub-b').store
    expect(b.conversation(identity.id)).toBeNull()
    expect(b.read(identity.id, -1)).toEqual([])
  })
  test('stale ownership epochs and migrating conversations refuse writes', () => {
    const { store } = open()
    store.createConversation(identity)
    expect(() => store.append(identity.id, 0, event, 1)).toThrow(/ownership/i)
    store.freeze(identity.id, 1, 'migration-a')
    expect(() => store.append(identity.id, 1, event, 1)).toThrow(/frozen/i)
    expect(() => store.freeze(identity.id, 1, 'another-migration')).toThrow(/migration/i)
    store.unfreeze(identity.id, 1, 'migration-a')
    expect(store.append(identity.id, 1, event, 1).seq).toBe(0)
  })
  test('retry receipts are durable; reusing an operation id with other input is refused', () => {
    const { store, root } = open()
    store.createConversation(identity)
    expect(store.acceptCommand(identity.id, 1, 'send-a', { text: 'hello' })).toBe('accepted')
    store.close()
    const next = open(root).store
    expect(next.acceptCommand(identity.id, 1, 'send-a', { text: 'hello' })).toBe('duplicate')
    expect(() => next.acceptCommand(identity.id, 1, 'send-a', { text: 'other' })).toThrow(
      /operation/i
    )
  })
  test('deletion tombstones block late commands and do not resurrect on retry', () => {
    const { store } = open()
    store.createConversation(identity)
    store.deleteConversation(identity.id, 2)
    expect(() => store.append(identity.id, 1, event, 1)).toThrow(/deleted/i)
    expect(() => store.createConversation(identity)).toThrow(/deleted/i)
    expect(() => store.deleteConversation(identity.id, 2)).not.toThrow()
    expect(store.read(identity.id, -1)).toEqual([])
  })
  test('a verified manifest is required before staged history can activate', () => {
    const source = open().store
    source.createConversation(identity)
    source.append(identity.id, 1, event, 123)
    source.freeze(identity.id, 1, 'migration-a')
    const snapshot = source.exportConversation(identity.id, 1, 'migration-a')
    const target = open().store
    expect(() => target.stage({ ...snapshot, events: [] })).toThrow(/integrity/i)
    target.stage(snapshot)
    expect(() => target.append(identity.id, 2, event, 124)).toThrow(/prepared/i)
    expect(() => target.activate(identity.id, 'migration-a', 2, 'wrong-hash')).toThrow(/integrity/i)
    target.activate(identity.id, 'migration-a', 2, snapshot.hash)
    expect(target.append(identity.id, 2, event, 124).seq).toBe(1)
    expect(() => target.append(identity.id, 1, event, 125)).toThrow(/ownership/i)
    target.activate(identity.id, 'migration-a', 2, snapshot.hash)
  })
})

test('an activated import can later migrate again, without accepting its old activation', () => {
  const source = open().store
  source.createConversation(identity)
  source.freeze(identity.id, 1, 'first')
  const snapshot = source.exportConversation(identity.id, 1, 'first'),
    target = open().store
  target.stage(snapshot)
  target.activate(identity.id, 'first', 2, snapshot.hash)
  target.freeze(identity.id, 2, 'second')
  expect(() => target.activate(identity.id, 'first', 2, snapshot.hash)).toThrow()
  expect(target.exportConversation(identity.id, 2, 'second').migrationId).toBe('second')
})

test('idempotency does not depend on object key insertion order', () => {
  const { store } = open()
  store.createConversation(identity)
  expect(() =>
    store.createConversation({
      epoch: 1,
      mode: identity.mode,
      tabId: identity.tabId,
      taskId: identity.taskId,
      id: identity.id
    })
  ).not.toThrow()
  store.acceptCommand(identity.id, 1, 'op', { a: 1, b: 2 })
  expect(store.acceptCommand(identity.id, 1, 'op', { b: 2, a: 1 })).toBe('duplicate')
})

test('migration metadata checkpoints survive restart and never overwrite their first snapshot', () => {
  const { store, root } = open()
  const records = [
    { kind: 'settings' as const, id: 'provider', at: 0, value: { chatModel: 'old' } }
  ]
  expect(store.migrationCheckpoint(identity, 'move')).toBeNull()
  expect(store.migrationCheckpoint(identity, 'move', records)).toEqual(records)
  store.close()
  const next = open(root).store
  expect(
    next.migrationCheckpoint(identity, 'move', [{ ...records[0], value: { chatModel: 'new' } }])
  ).toEqual(records)
  expect(() => next.migrationCheckpoint({ ...identity, id: 'another' }, 'move', records)).toThrow(
    /ownership|identity/i
  )
})

test('an offline deletion creates a tombstone before history arrives and fences the whole task', () => {
  const { store, root } = open()
  store.applyTombstone({ ...identity, epoch: 4 }, true)
  expect(store.conversation(identity.id)).toMatchObject({
    state: 'deleted',
    identity: { epoch: 4 }
  })
  store.close()
  const next = open(root).store
  expect(() => next.createConversation({ ...identity, epoch: 5 })).toThrow(/deleted/i)
  expect(() =>
    next.createConversation({ ...identity, id: 'new-child', tabId: 'new-child', epoch: 1 })
  ).toThrow(/deleted/i)
  expect(() => next.applyTombstone({ ...identity, epoch: 3 }, true)).not.toThrow()
  next.createConversation({ ...identity, id: 'other', taskId: 'another-task', tabId: 'other' })
  expect(next.conversation('other')).toMatchObject({ state: 'active' })
})

test('task state version moves on every hub-facing write, never on local content', () => {
  const { store } = open()
  store.createConversation(identity)
  const version = () => store.stateVersion(identity.taskId)
  expect(version()).toBe(0)
  const put = (kind: Parameters<typeof store.putRecord>[2]['kind'], id: string) =>
    store.putRecord(identity.id, 1, { kind, id, value: { v: Math.random() }, at: 1 })
  // Conversation content and the metadata pipeline's own bookkeeping stay local.
  for (const kind of ['draft', 'prompt', 'workspace', 'attachment', 'timeline'] as const)
    put(kind, 'local')
  put('settings', 'metadata-counter')
  put('settings', 'metadata:operation')
  store.append(identity.id, 1, event)
  expect(version()).toBe(0)
  // Anything else counts, including writes that send no metadata update
  // (bootstrap provider and session records) and kinds added later.
  let previous = version()
  for (const [kind, id] of [
    ['settings', 'provider'],
    ['settings', 'session:abc'],
    ['settings', 'some-future-setting'],
    ['queue', 'item'],
    ['thread', 'tab-a']
  ] as const) {
    put(kind, id)
    expect(version()).toBeGreaterThan(previous)
    previous = version()
  }
  store.removeRecord(identity.id, 1, 'queue', 'item')
  expect(version()).toBeGreaterThan(previous)
  previous = version()
  store.compose((db) =>
    db.prepare("INSERT INTO provider_configs VALUES(?,'claude-chat',1,'{}')").run(identity.taskId)
  )
  expect(version()).toBeGreaterThan(previous)
  // Per task: another task's writes do not move it.
  previous = version()
  store.createConversation({ ...identity, id: 'conversation-b', taskId: 'task-b', tabId: 'b' })
  store.putRecord('conversation-b', 1, { kind: 'settings', id: 'provider', value: {}, at: 1 })
  expect(version()).toBe(previous)
  expect(store.stateVersion('task-b')).toBeGreaterThan(0)
})

test('v9 (hub v208): pending settings, session and queue updates for the hub are dropped; others stay', () => {
  const { store, root } = open()
  store.createConversation(identity)
  const pending = (kind: string) => ({
    kind: 'settings' as const,
    id: `metadata:${kind}`,
    value: { operationId: kind, kind, sequence: 1, value: {} },
    at: 1
  })
  for (const kind of ['provider-config', 'conversation', 'queue-item', 'agent-state'])
    store.putRecord(identity.id, 1, pending(kind))
  // As a v8 store left it.
  store.compose((db) => db.pragma('user_version = 8'))
  store.close()
  const next = open(root).store
  expect(
    next
      .findRecords('settings', undefined, { idPrefix: 'metadata:' })
      .map((r) => r.id)
      .sort()
  ).toEqual(['metadata:agent-state'])
})

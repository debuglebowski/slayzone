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

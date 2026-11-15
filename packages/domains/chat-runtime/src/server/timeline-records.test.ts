import { createLocalChatData } from './local-data'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { openChatStorage } from './storage'

const stores: ReturnType<typeof openChatStorage>[] = []
const roots: string[] = []
const identity = { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-records-'))
  roots.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'test' })
  stores.push(store)
  store.createConversation(identity)
  return store
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const page = (page: number) => ({
  page,
  value: JSON.stringify({ page, rows: '[]', summary: '{}', searchText: 'hello' })
})

test('timeline commits touch only requested records, without decoding saved page bodies', () => {
  const store = fixture()
  // An unreadable derived page must be removable, without parsing it first.
  store.compose((db) =>
    db
      .prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      .run('chat', 'timeline', 'page:9', 'corrupt derived cache', 1)
  )
  store.putRecord('chat', 1, { kind: 'draft', id: 'state', value: { text: 'keep me' }, at: 1 })
  store.writeTimeline('chat', 1, {
    dropPagesFrom: 2,
    pages: [page(0), page(1)],
    checkpoint: '{"seq":3}'
  })
  expect(store.timelinePageIds('chat')).toEqual([0, 1])
  expect(store.timelineRecord('chat', 'checkpoint')).toBe('{"seq":3}')
  expect(store.getRecord('chat', 'draft', 'state')).toEqual({ text: 'keep me' })
  store.writeTimeline('chat', 1, { dropPagesFrom: 1, pages: [page(2)], checkpoint: null })
  expect(store.timelinePageIds('chat')).toEqual([0, 2])
  expect(store.timelineRecord('chat', 'checkpoint')).toBeNull()
  expect(store.resetTimeline('chat', 1)).toBe(2)
})

test('timeline writes atomically reject stale owners, frozen and deleted conversations', () => {
  const store = fixture()
  const write = { dropPagesFrom: null, pages: [page(0)], checkpoint: '{"seq":0}' }
  store.writeTimeline('chat', 1, write)
  expect(() =>
    store.writeTimeline('chat', 2, { ...write, dropPagesFrom: 0, checkpoint: null })
  ).toThrow(/ownership/i)
  store.freeze('chat', 1, 'move')
  expect(() =>
    store.writeTimeline('chat', 1, { ...write, dropPagesFrom: 0, checkpoint: null })
  ).toThrow(/frozen/i)
  expect(store.timelineRecord('chat', 'checkpoint')).toBe('{"seq":0}')
  expect(store.timelinePageIds('chat')).toEqual([0])
  store.unfreeze('chat', 1, 'move')
  store.deleteConversation('chat', 2)
  expect(() => store.writeTimeline('chat', 1, write)).toThrow(/deleted/i)
  expect(store.timelinePageIds('chat')).toEqual([])
})

test('a queued worker commit remains fenced to the owner captured when opened', async () => {
  const store = fixture()
  const records = createLocalChatData(store).data.timelineRecords!('tab')
  store.compose((db) => db.prepare('UPDATE conversations SET epoch=2 WHERE id=?').run('chat'))
  await expect(
    records.save({ dropPagesFrom: null, pages: [page(0)], checkpoint: null })
  ).rejects.toThrow(/ownership/i)
  await expect(records.load('checkpoint')).rejects.toThrow(/ownership/i)
  expect(store.timelinePageIds('chat')).toEqual([])
})

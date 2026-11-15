import { createLocalChatData } from './local-data'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { openChatStorage, TIMELINE_DROP_STEP_BYTES } from './storage'

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
const encodedPage = (page: number) => ({
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
    pages: [encodedPage(0), encodedPage(1)],
    checkpoint: '{"seq":3}'
  })
  expect(store.timelinePageIds('chat')).toEqual([0, 1])
  expect(store.timelineRecord('chat', 'checkpoint')).toBe('{"seq":3}')
  expect(store.getRecord('chat', 'draft', 'state')).toEqual({ text: 'keep me' })
  store.writeTimeline('chat', 1, { dropPagesFrom: 1, pages: [encodedPage(2)], checkpoint: null })
  expect(store.timelinePageIds('chat')).toEqual([0, 2])
  expect(store.timelineRecord('chat', 'checkpoint')).toBeNull()
  expect(store.dropTimelineStep('chat', 1, TIMELINE_DROP_STEP_BYTES)).toBe(true)
  expect(store.timelinePageIds('chat')).toEqual([])
})

test('timeline writes atomically reject stale owners, frozen and deleted conversations', () => {
  const store = fixture()
  const write = { dropPagesFrom: null, pages: [encodedPage(0)], checkpoint: '{"seq":0}' }
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
    records.save({ dropPagesFrom: null, pages: [encodedPage(0)], checkpoint: null })
  ).rejects.toThrow(/ownership/i)
  await expect(records.load('checkpoint')).rejects.toThrow(/ownership/i)
  expect(store.timelinePageIds('chat')).toEqual([])
})

/**
 * The computer's timeline projection records (`kind='timeline'`): pages of up to 256
 * rows (MBs each when rows carry long tool output) and one checkpoint.
 *
 * Regression (2026-11-14 restore of ~60 chats, 1–11 s computer stalls): dropping
 * pages, listing page summaries (every projection restore) and searching loaded and
 * parsed EVERY stored page of the chat; discarding a projection deleted all its pages
 * in one synchronous step. Each is now a query on ids / JSON paths, and a drop goes in
 * byte-bounded steps that let the event loop run between them.
 */
const dirs: string[] = []
const runtimes: Array<ReturnType<typeof createComputerChatRuntime>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function runtime() {
  const stateDir = mkdtempSync(join(tmpdir(), 'slz-timeline-records-'))
  dirs.push(stateDir)
  const r = createComputerChatRuntime({ stateDir, hubScope: 'hub-a', computerId: 'computer-a' })
  runtimes.push(r)
  r.bootstrap({
    identity: { id: 'storage-a', taskId: 'task-a', tabId: 'tab-a', mode: 'claude-chat', epoch: 1 },
    projectId: 'project-a',
    cwd: '/tmp',
    revision: 1,
    providerConfig: {},
    defaultFlags: null,
    env: {}
  })
  return r
}
const page = (n: number, rows: string, searchText = `page ${n}`) => ({
  page: n,
  startRow: n * 256,
  endRow: n * 256 + 256,
  rows,
  summary: JSON.stringify({ page: n }),
  searchText
})
/** Calls that read the chat's timeline records whole (values parsed). */
function timelineReads(r: ReturnType<typeof runtime>) {
  const records = vi.spyOn(r.storage, 'records')
  return () => records.mock.calls.filter(([, kind]) => kind === 'timeline' || kind === undefined)
}

test('drop, summaries and search never load the pages themselves', async () => {
  const r = runtime()
  const data = r.local.data
  await data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [0, 1, 2, 3].map((n) => page(n, `["${'r'.repeat(1000)}${n}"]`, n === 2 ? 'needle' : '')),
    checkpoint: { version: 'v', seq: 9, data: 'cp' }
  })
  const reads = timelineReads(r)

  expect(await data.loadTimelineSummaries('tab-a')).toEqual(
    [0, 1, 2, 3].map((n) => ({ page: n, summary: JSON.stringify({ page: n }) }))
  )
  expect(await data.searchTimelinePages('tab-a', 'needle')).toEqual([2])
  await data.saveTimeline('tab-a', {
    dropPagesFrom: 2,
    pages: [page(1, '["new"]')],
    checkpoint: { version: 'v', seq: 10, data: 'cp2' }
  })
  expect(reads()).toEqual([])

  expect((await data.loadTimelineSummaries('tab-a')).map((s) => s.page)).toEqual([0, 1])
  expect(await data.loadTimelinePages('tab-a', [1, 2])).toEqual([{ page: 1, rows: '["new"]' }])
  expect((await data.loadTimelineCheckpoint('tab-a'))?.seq).toBe(10)
  // Page ids compare as numbers, not text ("page:10" is after "page:9").
  await data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [9, 10, 11].map((n) => page(n, '[]')),
    checkpoint: null
  })
  await data.saveTimeline('tab-a', { dropPagesFrom: 10, pages: [], checkpoint: null })
  expect((await data.loadTimelineSummaries('tab-a')).map((s) => s.page)).toEqual([0, 1, 9])
})

test('a discarded projection is deleted in byte-bounded steps, the event loop running between them', async () => {
  const r = runtime()
  const data = r.local.data
  const big = `["${'x'.repeat(TIMELINE_DROP_STEP_BYTES)}"]`
  await data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [0, 1, 2].map((n) => page(n, big)),
    checkpoint: { version: 'v', seq: 3, data: 'cp' }
  })
  let ticks = 0,
    spinning = true
  const spin = () => {
    ticks++
    if (spinning) setImmediate(spin)
  }
  setImmediate(spin)
  const steps: number[] = []
  const step = r.storage.dropTimelineStep.bind(r.storage)
  vi.spyOn(r.storage, 'dropTimelineStep').mockImplementation((id, epoch, budget) => {
    steps.push(ticks)
    return step(id, epoch, budget)
  })
  await data.clearTimeline('tab-a')
  spinning = false
  expect(steps.length).toBeGreaterThanOrEqual(3)
  expect(new Set(steps).size).toBe(steps.length)
  expect(r.storage.hasTimeline('storage-a')).toBe(false)
})

test('a drop step takes the checkpoint first: stopped half way, the next open rebuilds', async () => {
  const r = runtime()
  const data = r.local.data
  const big = `["${'x'.repeat(TIMELINE_DROP_STEP_BYTES)}"]`
  await data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [0, 1].map((n) => page(n, big)),
    checkpoint: { version: 'v', seq: 2, data: 'cp' }
  })
  expect(r.storage.dropTimelineStep('storage-a', 1, TIMELINE_DROP_STEP_BYTES)).toBe(false)
  expect(await data.loadTimelineCheckpoint('tab-a')).toBeNull()
  while (!r.storage.dropTimelineStep('storage-a', 1, TIMELINE_DROP_STEP_BYTES));
  expect(r.storage.hasTimeline('storage-a')).toBe(false)
  // Another owner epoch is refused.
  await data.saveTimeline('tab-a', {
    dropPagesFrom: null,
    pages: [page(0, '[]')],
    checkpoint: null
  })
  expect(() => r.storage.dropTimelineStep('storage-a', 2, TIMELINE_DROP_STEP_BYTES)).toThrow()
})

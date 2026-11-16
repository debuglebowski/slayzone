import Database from 'better-sqlite3'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import {
  TimelineProjection,
  type TimelineProjectionStore
} from '@slayzone/terminal/timeline-projection'
import {
  timelineStoreFromRecords,
  type TimelineRecordStore
} from '@slayzone/terminal/timeline-records'
import { createTimelineWorkerPool } from '@slayzone/terminal/timeline-worker'
import type { TimelineWrite } from '@slayzone/terminal/runtime'
import { createLocalChatData } from './local-data'
import { openChatStorage, TIMELINE_DROP_STEP_BYTES, type ChatStorage } from './storage'

const identity = { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const roots: string[] = []
const stores: ChatStorage[] = []
const pools: ReturnType<typeof createTimelineWorkerPool>[] = []
const evaluators: Database.Database[] = []
let source: string
const history = buildLongSession({ events: 12000, seed: 21, askEveryTool: true }).map(
  (event, seq) => ({ event, seq, at: 1000 + seq })
)
const values = new Map<string, string>()
let expected: Awaited<ReturnType<TimelineProjection['openSnapshot']>>
beforeAll(async () => {
  source = (
    await build({
      entryPoints: [
        join(
          import.meta.dirname,
          '../../../terminal/src/server/runtime/chat-timeline-worker-entry.ts'
        )
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false
    })
  ).outputFiles[0].text
  const records: TimelineRecordStore = {
    load: async (key) => values.get(key) ?? null,
    pageIds: async () =>
      [...values.keys()]
        .filter((key) => key.startsWith('page:'))
        .map((key) => Number(key.slice(5))),
    save: async (write) => {
      if (write.dropPagesFrom !== null)
        for (const key of values.keys())
          if (key.startsWith('page:') && Number(key.slice(5)) >= write.dropPagesFrom)
            values.delete(key)
      for (const page of write.pages) values.set(`page:${page.page}`, page.value)
      if (write.checkpoint === null) values.delete('checkpoint')
      else values.set('checkpoint', write.checkpoint)
    },
    discard: async () => {
      values.clear()
    }
  }
  const projection = await TimelineProjection.open({
    store: timelineStoreFromRecords(records),
    history,
    agentStartedTurns: true
  })
  expected = await projection.openSnapshot()
  await projection.close()
  expect(expected.summaries.length).toBeGreaterThan(8)
})
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close()
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const evaluator of evaluators.splice(0)) evaluator.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'timeline-bounded-'))
  roots.push(root)
  const store = openChatStorage({ stateDir: root, hubScope: 'test' })
  stores.push(store)
  store.createConversation(identity)
  return { root, store, data: createLocalChatData(store).data }
}
function turns() {
  let tick = 0,
    active = true
  const spin = () => {
    tick++
    if (active) setImmediate(spin)
  }
  setImmediate(spin)
  return {
    get tick() {
      return tick
    },
    stop: () => {
      active = false
    }
  }
}
function seedLarge(store: ChatStorage) {
  const body = JSON.stringify({
    rows: 'OLD-PROJECTION:' + 'x'.repeat(2 * 1024 * 1024),
    summary: '{}',
    searchText: ''
  })
  store.compose((db) =>
    db.transaction(() => {
      const put = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      for (let n = 0; n < 16; n++) put.run('chat', 'timeline', `page:${n}`, body, 1)
      put.run('chat', 'timeline', 'checkpoint', '{"old":true}', 1)
    })()
  )
  store.append(
    'chat',
    1,
    { kind: 'assistant-text', messageId: 'authority', text: 'events stay' },
    1
  )
  store.putRecord('chat', 1, { kind: 'draft', id: 'state', value: { text: 'keep' }, at: 1 })
}
function deletionProbe(
  store: ChatStorage,
  clock: ReturnType<typeof turns>,
  onDelete?: (n: number) => void
) {
  const bytes = new Map<number, number>(),
    checkpoints: number[] = [],
    publishes: number[] = []
  let deleted = 0
  store.compose((db) => {
    db.function('observe_timeline_delete', (size, checkpoint) => {
      bytes.set(clock.tick, (bytes.get(clock.tick) ?? 0) + Number(size))
      checkpoints.push(Number(checkpoint))
      deleted++
      onDelete?.(deleted)
      return 0
    })
    db.function('observe_timeline_publish', () => {
      publishes.push(deleted)
      return 0
    })
    db.exec(`CREATE TRIGGER timeline_test_delete AFTER DELETE ON records
      WHEN OLD.kind='timeline' AND OLD.id GLOB 'page:*' BEGIN
      SELECT observe_timeline_delete(octet_length(OLD.value),
        EXISTS(SELECT 1 FROM records WHERE conversation_id=OLD.conversation_id AND kind='timeline' AND id='checkpoint'));
      END;
      CREATE TRIGGER timeline_test_publish BEFORE INSERT ON records
      WHEN NEW.kind='timeline' AND NEW.id GLOB 'page:*' BEGIN SELECT observe_timeline_publish(); END;`)
  })
  return { bytes, checkpoints, publishes }
}
const replacement: TimelineWrite = {
  dropPagesFrom: 2,
  pages: [
    { page: 2, startRow: 512, endRow: 512, rows: '[]', summary: '{}', searchText: 'replacement' }
  ],
  checkpoint: { version: 'new', seq: 0, data: '{}' }
}
function save(
  data: ReturnType<typeof createLocalChatData>['data'],
  mode: 'encoded' | 'compat',
  write = replacement
) {
  return mode === 'compat'
    ? data.saveTimeline('tab', write)
    : data.timelineRecords!('tab').save({
        dropPagesFrom: write.dropPagesFrom,
        pages: write.pages.map((page) => ({
          page: page.page,
          value: JSON.stringify(page),
          summary: page.summary,
          searchText: page.searchText
        })),
        checkpoint: write.checkpoint === null ? null : JSON.stringify(write.checkpoint)
      })
}
test.each(['encoded', 'compat'] as const)(
  '%s replacement drops checkpoint first and deletes old bodies in separate bounded turns',
  async (mode) => {
    const { store, data } = fixture()
    seedLarge(store)
    const clock = turns(),
      probe = deletionProbe(store, clock)
    try {
      await save(data, mode)
      expect(Math.max(...probe.bytes.values())).toBeLessThanOrEqual(TIMELINE_DROP_STEP_BYTES)
      expect(probe.checkpoints.every((present) => present === 0)).toBe(true)
      expect(probe.publishes[0]).toBe(14)
      expect(store.timelinePageIds('chat')).toEqual([0, 1, 2])
      expect(store.timelineRecord('chat', 'checkpoint')).toBe(
        JSON.stringify(replacement.checkpoint)
      )
      expect(store.getRecord('chat', 'draft', 'state')).toEqual({ text: 'keep' })
      expect(store.read('chat', -1)[0].event).toMatchObject({ text: 'events stay' })
    } finally {
      clock.stop()
    }
  }
)
test.each(['encoded', 'compat'] as const)(
  '%s interruption leaves no checkpoint and preserves authoritative events',
  async (mode) => {
    const { root, store, data } = fixture()
    seedLarge(store)
    const clock = turns(),
      probe = deletionProbe(store, clock, (n) => {
        if (n === 3) throw new Error('interrupted deletion')
      })
    try {
      await expect(save(data, mode)).rejects.toThrow('interrupted deletion')
      expect(store.timelineRecord('chat', 'checkpoint')).toBeNull()
      expect(store.timelinePageIds('chat').length).toBeGreaterThan(2)
      expect(store.timelinePageIds('chat').length).toBeLessThan(16)
      expect(probe.publishes).toEqual([])
      expect(store.read('chat', -1)[0].event).toMatchObject({ text: 'events stay' })
      store.compose((db) =>
        db.exec('DROP TRIGGER timeline_test_delete; DROP TRIGGER timeline_test_publish;')
      )
      store.close()
      const reopened = openChatStorage({ stateDir: root, hubScope: 'test' })
      stores.push(reopened)
      const recovered = await begin(
        createLocalChatData(reopened).data,
        mode === 'encoded' ? 'worker' : 'compat',
        0
      )
      expect(recovered.from).toBe(-1)
      await recovered.projection.feed(reopened.read('chat', -1))
      await recovered.projection.finish()
      expect(JSON.stringify(await recovered.projection.openSnapshot())).toContain('events stay')
      expect(reopened.timelinePageIds('chat')).toEqual([])
      await recovered.projection.close()
    } finally {
      clock.stop()
    }
  }
)
test.each(['encoded', 'compat'] as const)(
  '%s late writes cannot cross an owner epoch change between deletion steps',
  async (mode) => {
    const { store, data } = fixture()
    seedLarge(store)
    let active = true
    const clock = turns(),
      probe = deletionProbe(store, clock, (n) => {
        if (n === 1)
          setImmediate(() => {
            if (active)
              store.compose((db) =>
                db.prepare("UPDATE conversations SET epoch=2 WHERE id='chat'").run()
              )
          })
      })
    try {
      await expect(save(data, mode)).rejects.toThrow(/ownership/i)
      expect(probe.publishes).toEqual([])
      expect(store.timelineRecord('chat', 'checkpoint')).toBeNull()
    } finally {
      active = false
      clock.stop()
    }
  }
)

function projectionStore(
  data: ReturnType<typeof createLocalChatData>['data']
): TimelineProjectionStore {
  return {
    loadCheckpoint: () => data.loadTimelineCheckpoint('tab'),
    loadPages: (pages) => data.loadTimelinePages('tab', [...pages]),
    loadSummaries: () => data.loadTimelineSummaries('tab'),
    save: (write) => data.saveTimeline('tab', write),
    searchPages: (needle) => data.searchTimelinePages('tab', needle),
    discard: () => data.clearTimeline('tab')
  }
}
async function begin(
  data: ReturnType<typeof createLocalChatData>['data'],
  mode: 'worker' | 'compat',
  lastSeq = history.length - 1
) {
  const store =
    mode === 'compat'
      ? projectionStore(data)
      : timelineStoreFromRecords(data.timelineRecords!('tab'))
  if (mode === 'compat')
    return TimelineProjection.begin({
      store,
      lastSeq,
      agentStartedTurns: true,
      onError: () => {}
    })
  const pool = createTimelineWorkerPool(() => new Worker(source, { eval: true }))
  pools.push(pool)
  return pool.begin({
    store,
    lastSeq,
    agentStartedTurns: true,
    onError: () => {}
  })
}
function legacyProjection(store: ChatStorage, checkpoint = values.get('checkpoint')!) {
  store.transaction(() => {
    for (const entry of history) store.appendAt('chat', 1, entry.seq, entry.event, entry.at)
  })
  store.compose((db) =>
    db.transaction(() => {
      const put = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      for (const [key, value] of values) {
        if (key === 'checkpoint') continue
        // Preserve real rows/metadata and a valid checkpoint while making the
        // existing derived bodies large. Old formats allow unknown object keys.
        const page = { ...JSON.parse(value), padding: 'LEGACY-BODY:' + 'x'.repeat(2 * 1024 * 1024) }
        put.run('chat', 'timeline', key, JSON.stringify(page), 1)
      }
      put.run('chat', 'timeline', 'checkpoint', checkpoint, 1)
    })()
  )
}
test.each([
  ['worker', 'invalid'],
  ['worker', 'version'],
  ['compat', 'invalid'],
  ['compat', 'version']
] as const)(
  '%s rebuild over large existing %s checkpoint is bounded and recovers the full projection',
  async (mode, kind) => {
    const { store, data } = fixture()
    const cp = { ...JSON.parse(values.get('checkpoint')!), version: 'previous-version' }
    legacyProjection(store, kind === 'invalid' ? 'invalid checkpoint' : JSON.stringify(cp))
    const clock = turns(),
      probe = deletionProbe(store, clock)
    try {
      const { projection, from } = await begin(data, mode)
      expect(from).toBe(-1)
      await projection.feed(store.read('chat', -1))
      await projection.finish()
      expect(await projection.openSnapshot()).toEqual(expected)
      expect(Math.max(...probe.bytes.values())).toBeLessThanOrEqual(TIMELINE_DROP_STEP_BYTES)
      expect(probe.checkpoints.every((present) => present === 0)).toBe(true)
      expect(probe.publishes[0]).toBe(expected.summaries.length)
      await projection.close()
    } finally {
      clock.stop()
    }
  }
)

test.each(['worker', 'compat'] as const)(
  '%s searches large indexed text in bounded native turns',
  async (mode) => {
    const { store, data } = fixture()
    const matching: number[] = []
    const pages = [...values]
      .filter(([key]) => key.startsWith('page:'))
      .map(([key, value]) => {
        const page = JSON.parse(value)
        const matches = Number(key.slice(5)) % 3 === 0
        if (matches) matching.push(page.page)
        page.searchText =
          `large-metadata:${matches ? 'needle' : 'other'}:` + 'µ'.repeat(1024 * 1024)
        return {
          page: page.page,
          value: JSON.stringify(page),
          summary: page.summary,
          searchText: page.searchText
        }
      })
    await store.writeTimeline('chat', 1, {
      dropPagesFrom: 0,
      pages,
      checkpoint: values.get('checkpoint')!
    })
    const clock = turns(),
      searched = new Map<number, number>()
    const evaluator = new Database(':memory:')
    evaluators.push(evaluator)
    store.compose((db) =>
      db.function('instr', (haystack, needle) => {
        if (typeof haystack === 'string' && haystack.startsWith('large-metadata:'))
          searched.set(clock.tick, (searched.get(clock.tick) ?? 0) + Buffer.byteLength(haystack))
        return (
          evaluator.prepare('SELECT instr(?,?) AS value').get(haystack, needle) as { value: number }
        ).value
      })
    )
    try {
      const { projection, from } = await begin(data, mode)
      expect(from).toBe(history.length - 1)
      expect(await projection.searchPages('needle')).toEqual(matching.sort((a, b) => a - b))
      expect(Math.max(...searched.values())).toBeLessThanOrEqual(TIMELINE_DROP_STEP_BYTES)
      expect(searched.size).toBeGreaterThan(4)
      await projection.close()
    } finally {
      clock.stop()
    }
  }
)

test('frozen metadata reads remain bounded and never write a derived index', async () => {
  const { store, data } = fixture()
  legacyProjection(store)
  store.freeze('chat', 1, 'migration')
  expect(await data.loadTimelineSummaries('tab')).toHaveLength(expected.summaries.length)
  expect(
    (
      store.compose((db) =>
        db.prepare('SELECT COUNT(*) AS n FROM timeline_page_metadata').get()
      ) as { n: number }
    ).n
  ).toBe(0)
  store.unfreeze('chat', 1, 'migration')
  expect(await data.loadTimelineSummaries('tab')).toHaveLength(expected.summaries.length)
  expect(
    (
      store.compose((db) =>
        db.prepare('SELECT COUNT(*) AS n FROM timeline_page_metadata').get()
      ) as { n: number }
    ).n
  ).toBe(expected.summaries.length)
})
test.each(['worker', 'compat'] as const)(
  '%s restores and searches an existing checkpoint with paced metadata migration and no hot body scans',
  async (mode) => {
    let { root, store, data } = fixture()
    legacyProjection(store)
    const clock = turns(),
      parsed = new Map<number, number>()
    const evaluator = new Database(':memory:')
    evaluators.push(evaluator)
    const observe = () =>
      store.compose((db) =>
        db.function('json_extract', { varargs: true }, (...args) => {
          if (typeof args[0] === 'string' && args[0].includes('LEGACY-BODY:'))
            parsed.set(clock.tick, (parsed.get(clock.tick) ?? 0) + Buffer.byteLength(args[0]))
          return (
            evaluator
              .prepare(`SELECT json_extract(${args.map(() => '?').join(',')}) AS value`)
              .get(...args) as { value: string | number | null }
          ).value
        })
      )
    observe()
    let load = vi.spyOn(store, 'timelineRecord')
    const pageReads = () => load.mock.calls.filter(([, key]) => key.startsWith('page:'))
    try {
      const first = await begin(data, mode)
      expect(first.from, 'a valid existing checkpoint must restore, not silently rebuild').toBe(
        history.length - 1
      )
      expect(await first.projection.openSnapshot()).toEqual(expected)
      expect(Math.max(0, ...parsed.values())).toBeLessThanOrEqual(2 * TIMELINE_DROP_STEP_BYTES)
      expect(pageReads()).toEqual([])
      await first.projection.close()
      store.close()
      store = openChatStorage({ stateDir: root, hubScope: 'test' })
      stores.push(store)
      data = createLocalChatData(store).data
      observe()
      load = vi.spyOn(store, 'timelineRecord')
      parsed.clear()
      const hot = await begin(data, mode)
      expect(hot.from).toBe(history.length - 1)
      expect(await hot.projection.openSnapshot()).toEqual(expected)
      const matches = [...values]
        .filter(
          ([key, value]) => key.startsWith('page:') && JSON.parse(value).searchText.includes('read')
        )
        .map(([key]) => Number(key.slice(5)))
        .sort((a, b) => a - b)
      expect(await hot.projection.searchPages('read')).toEqual(matches)
      expect(parsed.size).toBe(0)
      expect(pageReads()).toEqual([])
      const changed = { ...JSON.parse(values.get('page:0')!), searchText: 'older writer needle' }
      store.putRecord('chat', 1, { kind: 'timeline', id: 'page:0', value: changed, at: 2 })
      expect(await hot.projection.searchPages('older writer needle')).toEqual([0])
      await hot.projection.close()
    } finally {
      clock.stop()
    }
  }
)

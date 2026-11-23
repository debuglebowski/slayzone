import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterEach, beforeAll, expect, test } from 'vitest'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import { TimelineProjection } from './chat-timeline-projection'
import { timelineStoreFromRecords, type TimelineRecordStore } from './chat-timeline-records'
import { createTimelineWorkerPool } from './chat-timeline-worker'

let source: string
const pools: ReturnType<typeof createTimelineWorkerPool>[] = []
beforeAll(async () => {
  source = (
    await build({
      entryPoints: ['packages/domains/terminal/src/server/runtime/chat-timeline-worker-entry.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false
    })
  ).outputFiles[0].text
})
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close()
})
function fixture(worker?: Worker) {
  const values = new Map<string, string>()
  const records: TimelineRecordStore = {
    load: async (key) => values.get(key) ?? null,
    pageIds: async () =>
      [...values.keys()]
        .filter((k) => k.startsWith('page:'))
        .map((k) => Number(k.slice(5)))
        .sort((a, b) => a - b),
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
  const pool = createTimelineWorkerPool(() => worker ?? new Worker(source, { eval: true }))
  pools.push(pool)
  return { pool, store: timelineStoreFromRecords(records), records, values }
}
const history = buildLongSession({
  events: 4000,
  seed: 21,
  provider: 'claude',
  askEveryTool: true
}).map((event, seq) => ({ event, seq, at: 1000 + seq }))
async function open(f: ReturnType<typeof fixture>, events = history) {
  const { projection, from } = await f.pool.begin({
    store: f.store,
    lastSeq: events.length - 1,
    agentStartedTurns: true
  })
  await projection.feed(events.filter((e) => e.seq > from))
  await projection.finish()
  return projection
}

test('worker preserves snapshots, pages, live ordering and checkpoint restoration', async () => {
  const f = fixture(),
    expected = fixture()
  const plain = await TimelineProjection.open({
    store: expected.store,
    history,
    agentStartedTurns: true
  })
  const remote = await open(f)
  expect(await remote.openSnapshot()).toEqual(await plain.openSnapshot())
  const snapshot = await remote.openSnapshot()
  expect(await remote.pagesAsOf([0, 1], snapshot.seq, snapshot.epoch)).toEqual(
    await plain.pagesAsOf([0, 1], snapshot.seq, snapshot.epoch)
  )
  const next = {
    seq: history.length,
    at: 9000,
    event: { kind: 'assistant-text', messageId: 'new', text: 'NEW LIVE TEXT' } as const
  }
  remote.apply(next)
  plain.apply(next)
  expect(await remote.openSnapshot()).toEqual(await plain.openSnapshot())
  expect(await remote.searchPages('NEW LIVE TEXT')).toEqual(
    await plain.searchPages('NEW LIVE TEXT')
  )
  await remote.close()
  await plain.close()
  const reopened = await open(f, [...history, next])
  expect(await reopened.openSnapshot()).toEqual(await plain.openSnapshot())
  await reopened.close()
})

test('worker forwards startRow and resumes bounded slices without losing or repeating rows', async () => {
  const f = fixture(),
    expected = fixture()
  const plain = await TimelineProjection.open({
    store: expected.store,
    history,
    agentStartedTurns: true
  })
  const budget = 8 * 1024
  const { projection } = await f.pool.begin({
    store: f.store,
    lastSeq: history.length - 1,
    agentStartedTurns: true,
    pageBudgetBytes: budget
  })
  try {
    await projection.feed(history)
    await projection.finish()
    const snapshot = await projection.openSnapshot()
    const whole = await plain.pagesAsOf([0, 1], snapshot.seq, snapshot.epoch)
    if (whole.expired) throw new Error('expected snapshot expired')
    const expectedRows = whole.pages.flatMap((page) => page.rows).slice(17)
    const rows = []
    let wanted = [0, 1],
      start = 17,
      replies = 0
    while (wanted.length) {
      expect(replies++).toBeLessThan(200)
      const got = await projection.pagesAsOf(wanted, snapshot.seq, snapshot.epoch, start)
      if (got.expired) throw new Error('worker snapshot expired')
      expect(got.pages[0].from).toBe(17 + rows.length)
      const batch = got.pages.flatMap((page) => page.rows)
      expect(batch.length).toBeGreaterThan(0)
      if (batch.length > 1)
        expect(
          batch.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)
        ).toBeLessThanOrEqual(budget)
      rows.push(...batch)
      wanted = got.omitted ?? []
      if (got.next !== undefined) expect(got.next).toBe(17 + rows.length)
      start = got.next ?? (wanted[0] ?? 0) * snapshot.pageRows
    }
    expect(replies).toBeGreaterThan(2)
    expect(rows).toEqual(expectedRows)
    const legacy = await projection.pagesAsOf([0, 1], snapshot.seq, snapshot.epoch)
    if (legacy.expired) throw new Error('legacy snapshot expired')
    expect(legacy.pages[0].rows).toHaveLength(snapshot.pageRows)
    expect(legacy).not.toHaveProperty('next')
  } finally {
    await projection.close()
    await plain.close()
  }
})

test('main event loop stays responsive while worker folds and serializes a long history', async () => {
  const f = fixture()
  let beats = 0
  const timer = setInterval(() => beats++, 1)
  try {
    await (await open(f)).close()
  } finally {
    clearInterval(timer)
  }
  expect(beats).toBeGreaterThan(2)
})

test('worker exit rejects pending operations; later reads fail and close completes', async () => {
  const worker = new Worker(source, { eval: true })
  const f = fixture(worker)
  const p = await open(f)
  await worker.terminate()
  expect(p.usable).toBe(false)
  await expect(p.openSnapshot()).rejects.toThrow(/worker/i)
  await p.close()
})

test('storage failures preserve chat state and dispose cleanly', async () => {
  const f = fixture()
  f.records.save = async () => {
    throw new Error('disk full')
  }
  const p = await open(f)
  expect((await p.openSnapshot()).seq).toBe(history.length - 1)
  await p.close()
})

test('one worker isolates tabs and a new worker recovers after a crash', async () => {
  const workers: Worker[] = []
  const pool = createTimelineWorkerPool(() => {
    const worker = new Worker(source, { eval: true })
    workers.push(worker)
    return worker
  })
  pools.push(pool)
  const a = fixture(),
    b = fixture()
  const first = await pool.begin({ store: a.store, lastSeq: -1, agentStartedTurns: true })
  const second = await pool.begin({ store: b.store, lastSeq: -1, agentStartedTurns: false })
  expect(first.checkpointMiss).toBe('checkpoint-none')
  expect(second.checkpointMiss).toBe('checkpoint-none')
  await first.projection.finish()
  await second.projection.finish()
  expect(workers).toHaveLength(1)
  expect(a.values.get('checkpoint')).not.toEqual(b.values.get('checkpoint'))
  await workers[0].terminate()
  const recovered = await pool.begin({ store: a.store, lastSeq: -1, agentStartedTurns: true })
  expect(workers).toHaveLength(2)
  expect(first.projection.usable).toBe(false)
  expect((await recovered.projection.openSnapshot()).seq).toBe(-1)
  await pool.close()
})

test('closing pool drains live events and final commit before releasing storage', async () => {
  const f = fixture()
  const { projection } = await f.pool.begin({
    store: f.store,
    lastSeq: -1,
    agentStartedTurns: true
  })
  await projection.finish()
  projection.apply({
    seq: 0,
    at: 1,
    event: { kind: 'assistant-text', messageId: 'reply', text: 'durable' }
  })
  await f.pool.close()
  expect(JSON.parse(f.values.get('checkpoint')!).seq).toBe(0)
  await expect(
    f.pool.begin({ store: f.store, lastSeq: 0, agentStartedTurns: true })
  ).rejects.toThrow(/closed/i)
})

test('unexpected exit rejects an operation waiting on storage', async () => {
  const worker = new Worker(source, { eval: true })
  const f = fixture(worker)
  const entered = Promise.withResolvers<void>()
  f.records.load = async () => {
    entered.resolve()
    return new Promise(() => {})
  }
  const pending = f.pool.begin({ store: f.store, lastSeq: 0, agentStartedTurns: true })
  const failed = expect(pending).rejects.toThrow(/worker/i)
  await entered.promise
  await worker.terminate()
  await failed
  await f.pool.close()
})

test('corrupt derived pages disable the projection so clients can replay events', async () => {
  const f = fixture()
  const p = await open(f)
  await p.close()
  const { projection: restored } = await f.pool.begin({
    store: f.store,
    lastSeq: history.length - 1,
    agentStartedTurns: true
  })
  await restored.finish()
  f.values.set('page:0', 'broken cache')
  const snapshot = await restored.openSnapshot()
  // Pick an evicted page: the worker must decode this stored body.
  expect(await restored.pagesAsOf([0], snapshot.seq, snapshot.epoch)).toEqual({ expired: true })
  expect(restored.usable).toBe(false)
  await restored.close()
})

test('worker death during close cannot prevent authoritative event storage from draining', async () => {
  const worker = new Worker(source, { eval: true })
  const f = fixture(worker)
  const p = await open(f)
  const entered = Promise.withResolvers<void>()
  f.records.save = async () => {
    entered.resolve()
    return new Promise(() => {})
  }
  await p.apply({
    seq: history.length,
    at: 9999,
    event: { kind: 'assistant-text', messageId: 'last', text: 'last' }
  })
  const closing = p.close()
  const done = expect(closing).resolves.toBeUndefined()
  await entered.promise
  await worker.terminate()
  await done
})

test('worker reports projection errors through the caller error hook', async () => {
  const f = fixture()
  const errors: string[] = []
  f.records.save = async () => {
    throw new Error('report this disk failure')
  }
  const { projection } = await f.pool.begin({
    store: f.store,
    lastSeq: -1,
    agentStartedTurns: true,
    onError: (what, err) => errors.push(`${what}: ${String(err)}`)
  })
  await projection.finish()
  expect(errors.join('\n')).toContain('report this disk failure')
  await projection.close()
})

test('a corrupt page needed during restore folding is discarded before close completes', async () => {
  const f = fixture()
  await (await open(f)).close()
  const { projection: restored } = await f.pool.begin({
    store: f.store,
    lastSeq: history.length - 1,
    agentStartedTurns: true
  })
  const first = JSON.parse(JSON.parse(f.values.get('page:0')!).rows).find(
    (row: { kind: string }) => row.kind === 'tool'
  )
  f.values.set('page:0', 'corrupt page')
  await expect(
    restored.feed([
      {
        seq: history.length,
        at: 9999,
        event: {
          kind: 'tool-result',
          toolUseId: first.invocation.id,
          isError: false,
          rawContent: 'late',
          structured: null
        }
      }
    ])
  ).rejects.toThrow()
  await restored.close()
  expect(f.values.size).toBe(0)
})

test('timed flush never overlaps a rebuild awaiting storage', async () => {
  const f = fixture()
  const entries = buildLongSession({ events: 12000, seed: 21 }).map((event, seq) => ({
    event,
    seq,
    at: 1000 + seq
  }))
  const { projection } = await f.pool.begin({
    store: f.store,
    lastSeq: entries.length - 1,
    agentStartedTurns: true
  })
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const save = f.records.save
  let saving = 0,
    peak = 0
  f.records.save = async (write) => {
    saving++
    peak = Math.max(peak, saving)
    entered.resolve()
    try {
      await release.promise
      await save(write)
    } finally {
      saving--
    }
  }
  const feeding = projection.feed(entries)
  try {
    await entered.promise
    // The projection's 1.5 s flush timer fires while this save awaits its owner.
    await new Promise((resolve) => setTimeout(resolve, 1750))
    expect(peak).toBe(1)
  } finally {
    release.resolve()
    await feeding
    await projection.finish()
    await projection.close()
  }
})

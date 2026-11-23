/**
 * `ChatEventLog`: the one owner of a chat tab's sequence numbers. Rows are
 * inserted in order, never replaced; a clash is reported, never an overwrite.
 */
import { expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { CHAT_HISTORY_PAGE_MAX_BYTES, jsonByteLength } from '@slayzone/terminal-contracts'
import {
  ChatEventLog,
  pageOfRows,
  tailStartOfRows,
  type BufferedEvent,
  type ChatEventPersistence
} from './chat-events-store'
import { historyReadTurns } from './history-turns'

const noReads = {
  readPage: async () => ({ events: [], bytes: [], more: false }),
  tailStart: async () => null
} satisfies Pick<ChatEventPersistence, 'readPage' | 'tailStart'>

function memoryStore(opts: { delayMs?: number; readDelayMs?: number } = {}) {
  const rows = new Map<string, { seq: number; event: AgentEvent; at?: number }>()
  const order: number[] = []
  const reads: Array<[number, number]> = []
  const sorted = (tabId: string): BufferedEvent[] =>
    [...rows.entries()]
      .filter(([k]) => k.startsWith(`${tabId}:`))
      .map(([, r]) => r)
      .sort((a, b) => a.seq - b.seq)
  const persistence: ChatEventPersistence = {
    insert: async (tabId, seq, event, at) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, Math.random() * opts.delayMs!))
      const key = `${tabId}:${seq}`
      if (rows.has(key)) return 'clash'
      rows.set(key, { seq, event, at })
      order.push(seq)
      return 'inserted'
    },
    readPage: async (tabId, afterSeq, beforeSeq, budget) => {
      reads.push([afterSeq, beforeSeq])
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      return pageOfRows(sorted(tabId), afterSeq, beforeSeq, budget)
    },
    tailStart: async (tabId, count) => tailStartOfRows(sorted(tabId), count)
  }
  return { rows, order, reads, persistence }
}

const seqs = (events: ReadonlyArray<{ seq: number }>) => events.map((e) => e.seq)
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i)

const text = (t: string): AgentEvent => ({ kind: 'stderr', text: t })

test('a history turn never waits for a newer writer that needs that same scheduler', async () => {
  let entered!: () => void, release!: () => void, escape!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const fallback = new Promise<void>((resolve) => {
    escape = resolve
  })
  const blocker = historyReadTurns.take(async () => {
    entered()
    await gate
  })
  await started
  const log = new ChatEventLog(
    'tab',
    {
      ...noReads,
      insert: async () => {
        await Promise.race([historyReadTurns.take(async () => undefined), fallback])
        return 'inserted'
      }
    },
    { events: [{ seq: 1, event: text('committed') }], nextSeq: 2 },
    { cap: 1 }
  )
  const reading = log.readPage(-1)
  await new Promise((resolve) => setImmediate(resolve))
  const writing = log.append(text('later'))
  await new Promise((resolve) => setImmediate(resolve))
  release()
  try {
    expect(
      await Promise.race([
        reading.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))
      ])
    ).toBe(true)
  } finally {
    escape()
  }
  await Promise.all([blocker, reading, writing])
})

test('an async append exposes no sequence or cached row before the insert commits', async () => {
  let commit!: () => void
  const gate = new Promise<void>((resolve) => {
    commit = resolve
  })
  const log = new ChatEventLog(
    'tab',
    {
      ...noReads,
      insert: async () => {
        await gate
        return 'inserted'
      }
    },
    { events: [], nextSeq: 0 }
  )
  let done = false
  const append = Promise.resolve(log.append(text('pending'))).then((entry) => {
    done = true
    return entry
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    expect(log.lastSeq).toBe(-1)
    expect(log.events).toEqual([])
    expect(log.since(-1)).toEqual([])
  } finally {
    commit()
  }
  expect(await append).toMatchObject({ seq: 0, event: text('pending') })
  expect(log.lastSeq).toBe(0)
})

test('a failed async insert poisons its prefix and later appends instead of fabricating saved history', async () => {
  const error = new Error('disk full')
  const onWriteError = vi.fn()
  const insert = vi.fn(async () => {
    throw error
  })
  const log = new ChatEventLog(
    'tab',
    { ...noReads, insert },
    { events: [], nextSeq: 0 },
    { onWriteError }
  )
  const first = Promise.resolve(log.append(text('lost')))
  const later = Promise.resolve(log.append(text('must not skip a sequence')))
  await expect(first).rejects.toBe(error)
  await expect(later).rejects.toBe(error)
  await expect(log.flush()).rejects.toBe(error)
  await expect(Promise.resolve(log.append(text('still unavailable')))).rejects.toBe(error)
  expect(insert).toHaveBeenCalledTimes(1)
  expect(onWriteError).toHaveBeenCalledTimes(1)
  expect(log.lastSeq).toBe(-1)
  expect(log.events).toEqual([])
})

test('assigns consecutive seqs from the seed, not from the caller', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, {
    events: [{ seq: 4, event: text('old') }],
    nextSeq: 5
  })
  expect((await log.append(text('a'))).seq).toBe(5)
  expect((await log.append(text('b'))).seq).toBe(6)
  expect(log.lastSeq).toBe(6)
  await log.flush()
  expect([...store.rows.values()].map((r) => r.seq)).toEqual([5, 6])
})

test('writes land in append order even when the store answers out of order', async () => {
  const store = memoryStore({ delayMs: 5 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 })
  await Promise.all(Array.from({ length: 30 }, (_, i) => log.append(text(String(i)))))
  await log.flush()
  expect(store.order).toEqual(Array.from({ length: 30 }, (_, i) => i))
})

test('a clash is reported and never overwrites the existing row', async () => {
  const store = memoryStore()
  store.rows.set('tab:0', { seq: 0, event: text('first writer') })
  const clashes: number[] = []
  const log = new ChatEventLog(
    'tab',
    store.persistence,
    { events: [], nextSeq: 0 },
    { onClash: (seq) => clashes.push(seq) }
  )
  await expect(log.append(text('second writer'))).rejects.toThrow(/already exists/)
  await expect(log.flush()).rejects.toThrow(/already exists/)
  expect(clashes).toEqual([0])
  expect(store.rows.get('tab:0')?.event).toEqual(text('first writer'))
})

test('a failed write is reported once and fences later writes', async () => {
  let fail = true
  const written: number[] = []
  const errors: number[] = []
  const log = new ChatEventLog(
    'tab',
    {
      insert: async (_tab, seq) => {
        if (fail) {
          fail = false
          throw new Error('disk full')
        }
        written.push(seq)
        return 'inserted'
      },
      ...noReads
    },
    { events: [], nextSeq: 0 },
    { onWriteError: (seq) => errors.push(seq) }
  )
  await expect(log.append(text('a'))).rejects.toThrow('disk full')
  await expect(log.append(text('b'))).rejects.toThrow('disk full')
  await expect(log.flush()).rejects.toThrow('disk full')
  expect(errors).toEqual([0])
  expect(written).toEqual([])
})

test('keeps at most `cap` events in memory (a cache), newest last', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 5; i++) await log.append(text(String(i)))
  expect(log.since(-1).map((e) => e.seq)).toEqual([2, 3, 4])
  expect(log.since(3).map((e) => e.seq)).toEqual([4])
})

test('a seed longer than the cap keeps its newest events in memory', async () => {
  const store = memoryStore()
  const events = Array.from({ length: 5 }, (_, seq) => ({ seq, event: text(String(seq)) }))
  const log = new ChatEventLog('tab', store.persistence, { events, nextSeq: 5 }, { cap: 2 })
  expect(log.since(-1).map((e) => e.seq)).toEqual([3, 4])
  expect((await log.append(text('x'))).seq).toBe(5)
})

test('flush waits for every write appended before it', async () => {
  const store = memoryStore({ delayMs: 10 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 })
  const writes = [log.append(text('a')), log.append(text('b'))]
  await log.flush()
  await Promise.all(writes)
  expect(store.rows.size).toBe(2)
})

// --- History beyond the in-memory cache (plan 4.1: history is never lost) ----

test('readSince returns the WHOLE history: what left the cache is read back from the store', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 10; i++) await log.append(text(String(i)))
  expect(seqs(log.since(-1))).toEqual([7, 8, 9])
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 9))
  expect(seqs(await log.readSince(4))).toEqual(range(5, 9))
  const readsBefore = store.reads.length
  // Inside the cache: no store read at all.
  expect(seqs(await log.readSince(7))).toEqual([8, 9])
  expect(store.reads.length).toBe(readsBefore)
})

test('a seed longer than the cache: its older events are still read back', async () => {
  const store = memoryStore()
  const events = Array.from({ length: 6 }, (_, seq) => ({ seq, event: text(String(seq)) }))
  for (const e of events) store.rows.set(`tab:${e.seq}`, e)
  const log = new ChatEventLog('tab', store.persistence, { events, nextSeq: 6 }, { cap: 2 })
  expect(seqs(log.since(-1))).toEqual([4, 5])
  await log.append(text('new'))
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 6))
})

test('a whole history in memory is served from memory', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 50 })
  for (let i = 0; i < 10; i++) await log.append(text(String(i)))
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 9))
  expect(store.reads).toEqual([])
})

test('events appended while the store is read are neither lost nor doubled', async () => {
  const store = memoryStore({ readDelayMs: 20, delayMs: 3 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 4 })
  for (let i = 0; i < 20; i++) await log.append(text(String(i)))
  const reading = log.readSince(-1)
  // More arrive during the read: the cache moves on past what was read.
  for (let i = 20; i < 40; i++) await log.append(text(String(i)))
  const got = seqs(await reading)
  expect(got[0]).toBe(0)
  expect(got).toEqual(range(0, got.at(-1)!))
  expect(got.at(-1)).toBeGreaterThanOrEqual(19)
})

test('every appended event is stamped with the time it was saved: kept, written, read back', async () => {
  vi.useFakeTimers({ now: 1_793_376_000_000, toFake: ['Date'] })
  try {
    const store = memoryStore()
    const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 2 })
    expect((await log.append(text('a'))).at).toBe(1_793_376_000_000)
    vi.setSystemTime(1_793_376_000_500)
    await log.append(text('b'))
    await log.append(text('c'))
    await log.flush()
    expect([...store.rows.values()].map((r) => r.at)).toEqual([
      1_793_376_000_000, 1_793_376_000_500, 1_793_376_000_500
    ])
    // 'a' left the cache: read back from the store, time and all.
    expect((await log.readSince(-1)).map((e) => e.at)).toEqual([
      1_793_376_000_000, 1_793_376_000_500, 1_793_376_000_500
    ])
  } finally {
    vi.useRealTimers()
  }
})

test('a synchronous storage error rejects the append without publishing or consuming its seq', async () => {
  const log = new ChatEventLog(
    'local-tab',
    {
      ...noReads,
      insert: () => {
        throw new Error('disk full')
      }
    },
    { events: [], nextSeq: 0 }
  )
  await expect(log.append(text('not saved'))).rejects.toThrow('disk full')
  expect(log.events).toEqual([])
  expect(log.lastSeq).toBe(-1)
  await expect(log.flush()).rejects.toThrow('disk full')
})

// --- Bounded pages (crash 2026-11-14: one whole-history read = a 202 MB frame) ----

const blob = (seq: number, kb: number): BufferedEvent => ({
  seq,
  event: { kind: 'stderr', text: `${seq}:${'x'.repeat(kb * 1024)}` }
})

test('readPage stops at the byte budget, never splits or drops an event, and pages add up to the history', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 5 })
  for (let i = 0; i < 40; i++) await log.append(blob(i, 100).event)
  await log.flush()
  const budget = { maxBytes: 350 * 1024 }
  const all: BufferedEvent[] = []
  let from = -1
  for (;;) {
    const page = await log.readPage(from, budget)
    const bytes = page.events.reduce((n, e) => n + jsonByteLength(e.event), 0)
    expect(page.events.length).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(budget.maxBytes)
    all.push(...page.events)
    from = page.events.at(-1)!.seq
    if (!page.hasMore) break
  }
  expect(seqs(all)).toEqual(range(0, 39))
  expect(all).toEqual(await log.readSince(-1))
})

test('one event larger than the budget is a page of its own', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 1 })
  await log.append(blob(0, 64).event)
  await log.append(blob(1, 64).event)
  await log.flush()
  const first = await log.readPage(-1, { maxBytes: 1024 })
  expect(seqs(first.events)).toEqual([0])
  expect(first.hasMore).toBe(true)
  const second = await log.readPage(0, { maxBytes: 1024 })
  expect(seqs(second.events)).toEqual([1])
  expect(second.hasMore).toBe(false)
})

test('a page never asks for more than the caller budget allows, nor above the maximum', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 2 })
  for (let i = 0; i < 10; i++) await log.append(text(String(i)))
  await log.flush()
  expect(seqs((await log.readPage(-1, { maxEvents: 3 })).events)).toEqual([0, 1, 2])
  const huge = await log.readPage(-1, { maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES * 100 })
  expect(huge.events.length).toBeGreaterThan(0)
})

test('open() seeds the cache from the store tail only: older rows are never read', async () => {
  const store = memoryStore()
  for (let seq = 0; seq < 50; seq++) store.rows.set(`tab:${seq}`, { seq, event: text(String(seq)) })
  const log = await ChatEventLog.open('tab', store.persistence, 50, { cap: 10 })
  expect(seqs(log.events)).toEqual(range(40, 49))
  expect(store.reads.every(([after]) => after >= 39)).toBe(true)
  expect((await log.append(text('next'))).seq).toBe(50)
  // The rest is still reachable, page by page.
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 50))
})

test('open() of a short or empty history keeps all of it, and honours the sequence floor', async () => {
  const store = memoryStore()
  expect((await ChatEventLog.open('tab', store.persistence, 7)).lastSeq).toBe(6)
  for (let seq = 0; seq < 3; seq++) store.rows.set(`tab:${seq}`, { seq, event: text(String(seq)) })
  const log = await ChatEventLog.open('tab', store.persistence, 0, { cap: 10 })
  expect(seqs(log.events)).toEqual([0, 1, 2])
  expect(log.lastSeq).toBe(2)
})

test('a deferred seed loads its recent window once and preserves the durable sequence floor', async () => {
  const store = memoryStore()
  for (let seq = 0; seq < 10; seq++) store.rows.set(`tab:${seq}`, { seq, event: text(String(seq)) })
  const log = await ChatEventLog.open('tab', store.persistence, 20, { cap: 3, deferSeed: true })
  expect(log.newestSeq).toBe(9)
  expect(log.lastSeq).toBe(19)
  expect(store.reads).toEqual([])
  expect((await log.append(text('next'))).seq).toBe(20)
  const [recent, concurrent] = await Promise.all([log.readRecent(), log.readRecent()])
  expect(seqs(recent)).toEqual([8, 9, 20])
  expect(concurrent).toBe(recent)
  expect(store.reads).toEqual([[7, 10]])
  expect(seqs(await log.readSince(8))).toEqual([9, 20])
})

test('pages() lets the event loop run between pages', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 2 })
  for (let i = 0; i < 6; i++) await log.append(text(String(i)))
  await log.flush()
  // Another task on the loop: it runs whenever the read gives the loop back.
  let ticks = 0
  let stop = false
  const spin = () => {
    ticks++
    if (!stop) setImmediate(spin)
  }
  setImmediate(spin)
  const seen: number[] = []
  try {
    for await (const page of log.pages(-1, { budget: { maxEvents: 1 } })) {
      seen.push(ticks)
      expect(page).toHaveLength(1)
    }
  } finally {
    stop = true
  }
  for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1])
  expect(seen).toHaveLength(6)
})

test('pages() stops before `beforeSeq`', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 10; i++) await log.append(text(String(i)))
  await log.flush()
  const got: number[] = []
  for await (const page of log.pages(-1, { beforeSeq: 6, budget: { maxEvents: 2 } }))
    got.push(...seqs(page))
  expect(got).toEqual(range(0, 5))
})

test('prepare: the log keeps, returns and writes the event as the store will save it', async () => {
  const store = memoryStore()
  const stored = text('stored form')
  const prepare = vi.fn((_tabId: string, _event: AgentEvent) => stored)
  const log = new ChatEventLog('tab', { ...store.persistence, prepare }, { events: [], nextSeq: 0 })
  const entry = await log.append(text('raw form'))
  expect(prepare).toHaveBeenCalledWith('tab', text('raw form'))
  expect(entry.event).toBe(stored)
  expect(log.since(-1).map((b) => b.event)).toEqual([stored])
  await log.flush()
  expect(store.rows.get('tab:0')?.event).toBe(stored)
})

test('prepare: a failure is a write error, and the seq is not used', async () => {
  const store = memoryStore()
  const onWriteError = vi.fn()
  const log = new ChatEventLog(
    'tab',
    {
      ...store.persistence,
      prepare: () => {
        throw new Error('blob store full')
      }
    },
    { events: [], nextSeq: 0 },
    { onWriteError }
  )
  await expect(log.append(text('a'))).rejects.toThrow(/blob store full/)
  expect(onWriteError).toHaveBeenCalledWith(0, expect.any(Error))
  expect(log.lastSeq).toBe(-1)
  expect(log.events).toEqual([])
})

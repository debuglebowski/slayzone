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

test('assigns consecutive seqs from the seed, not from the caller', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, {
    events: [{ seq: 4, event: text('old') }],
    nextSeq: 5
  })
  expect(log.append(text('a')).seq).toBe(5)
  expect(log.append(text('b')).seq).toBe(6)
  expect(log.lastSeq).toBe(6)
  await log.flush()
  expect([...store.rows.values()].map((r) => r.seq)).toEqual([5, 6])
})

test('writes land in append order even when the store answers out of order', async () => {
  const store = memoryStore({ delayMs: 5 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 })
  for (let i = 0; i < 30; i++) log.append(text(String(i)))
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
  log.append(text('second writer'))
  await log.flush()
  expect(clashes).toEqual([0])
  expect(store.rows.get('tab:0')?.event).toEqual(text('first writer'))
})

test('a failed write is reported and does not stop later writes', async () => {
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
  log.append(text('a'))
  log.append(text('b'))
  await log.flush()
  expect(errors).toEqual([0])
  expect(written).toEqual([1])
})

test('keeps at most `cap` events in memory (a cache), newest last', () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 5; i++) log.append(text(String(i)))
  expect(log.since(-1).map((e) => e.seq)).toEqual([2, 3, 4])
  expect(log.since(3).map((e) => e.seq)).toEqual([4])
})

test('a seed longer than the cap keeps its newest events in memory', () => {
  const store = memoryStore()
  const events = Array.from({ length: 5 }, (_, seq) => ({ seq, event: text(String(seq)) }))
  const log = new ChatEventLog('tab', store.persistence, { events, nextSeq: 5 }, { cap: 2 })
  expect(log.since(-1).map((e) => e.seq)).toEqual([3, 4])
  expect(log.append(text('x')).seq).toBe(5)
})

test('flush waits for every write appended before it', async () => {
  const store = memoryStore({ delayMs: 10 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 })
  log.append(text('a'))
  log.append(text('b'))
  await log.flush()
  expect(store.rows.size).toBe(2)
})

// --- History beyond the in-memory cache (plan 4.1: history is never lost) ----

test('readSince returns the WHOLE history: what left the cache is read back from the store', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 10; i++) log.append(text(String(i)))
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
  log.append(text('new'))
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 6))
})

test('a whole history in memory is served from memory', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 50 })
  for (let i = 0; i < 10; i++) log.append(text(String(i)))
  expect(seqs(await log.readSince(-1))).toEqual(range(0, 9))
  expect(store.reads).toEqual([])
})

test('events appended while the store is read are neither lost nor doubled', async () => {
  const store = memoryStore({ readDelayMs: 20, delayMs: 3 })
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 4 })
  for (let i = 0; i < 20; i++) log.append(text(String(i)))
  const reading = log.readSince(-1)
  // More arrive during the read: the cache moves on past what was read.
  for (let i = 20; i < 40; i++) log.append(text(String(i)))
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
    expect(log.append(text('a')).at).toBe(1_793_376_000_000)
    vi.setSystemTime(1_793_376_000_500)
    log.append(text('b'))
    log.append(text('c'))
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

test('synchronous persistence finishes before an event enters the visible log', () => {
  const writes: number[] = []
  const log = new ChatEventLog(
    'local-tab',
    {
      insert: async () => {
        throw new Error('async path must not run')
      },
      insertSync: (_tab, seq) => {
        writes.push(seq)
        return 'inserted'
      },
      ...noReads
    },
    { events: [], nextSeq: 0 }
  )
  log.append({ kind: 'assistant-text', messageId: 'm', text: 'saved' })
  expect(writes).toEqual([0])
  expect(log.events).toHaveLength(1)
})

test('a failed synchronous save does not publish or consume an event sequence', () => {
  let full = true
  const log = new ChatEventLog(
    'local-tab',
    {
      insert: async () => 'inserted',
      insertSync: () => {
        if (full) throw new Error('disk full')
        return 'inserted'
      },
      ...noReads
    },
    { events: [], nextSeq: 0 }
  )
  expect(() => log.append({ kind: 'assistant-text', messageId: 'm', text: 'not saved' })).toThrow(
    'disk full'
  )
  expect(log.events).toEqual([])
  expect(log.lastSeq).toBe(-1)
  full = false
  expect(log.append({ kind: 'assistant-text', messageId: 'm', text: 'saved' }).seq).toBe(0)
})

// --- Bounded pages (crash 2026-11-14: one whole-history read = a 202 MB frame) ----

const blob = (seq: number, kb: number): BufferedEvent => ({
  seq,
  event: { kind: 'stderr', text: `${seq}:${'x'.repeat(kb * 1024)}` }
})

test('readPage stops at the byte budget, never splits or drops an event, and pages add up to the history', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 5 })
  for (let i = 0; i < 40; i++) log.append(blob(i, 100).event)
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
  log.append(blob(0, 64).event)
  log.append(blob(1, 64).event)
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
  for (let i = 0; i < 10; i++) log.append(text(String(i)))
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
  expect(log.append(text('next')).seq).toBe(50)
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

test('pages() lets the event loop run between pages', async () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 2 })
  for (let i = 0; i < 6; i++) log.append(text(String(i)))
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
  for (let i = 0; i < 10; i++) log.append(text(String(i)))
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
  const entry = log.append(text('raw form'))
  expect(prepare).toHaveBeenCalledWith('tab', text('raw form'))
  expect(entry.event).toBe(stored)
  expect(log.since(-1).map((b) => b.event)).toEqual([stored])
  await log.flush()
  expect(store.rows.get('tab:0')?.event).toBe(stored)
})

test('prepare: a failure is a write error, and the seq is not used', () => {
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
  expect(() => log.append(text('a'))).toThrow(/blob store full/)
  expect(onWriteError).toHaveBeenCalledWith(0, expect.any(Error))
  expect(log.lastSeq).toBe(-1)
  expect(log.events).toEqual([])
})

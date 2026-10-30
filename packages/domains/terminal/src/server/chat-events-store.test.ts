/**
 * `ChatEventLog`: the one owner of a chat tab's sequence numbers. Rows are
 * inserted in order, never replaced; a clash is reported, never an overwrite.
 */
import { expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { ChatEventLog, type ChatEventPersistence } from './chat-events-store'

function memoryStore(opts: { delayMs?: number; readDelayMs?: number } = {}) {
  const rows = new Map<string, { seq: number; event: AgentEvent; at?: number }>()
  const order: number[] = []
  const reads: Array<[number, number]> = []
  const persistence: ChatEventPersistence = {
    insert: async (tabId, seq, event, at) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, Math.random() * opts.delayMs!))
      const key = `${tabId}:${seq}`
      if (rows.has(key)) return 'clash'
      rows.set(key, { seq, event, at })
      order.push(seq)
      return 'inserted'
    },
    readRange: async (tabId, afterSeq, beforeSeq) => {
      reads.push([afterSeq, beforeSeq])
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      return [...rows.entries()]
        .filter(([k, r]) => k.startsWith(`${tabId}:`) && r.seq > afterSeq && r.seq < beforeSeq)
        .map(([, r]) => r)
        .sort((a, b) => a.seq - b.seq)
    }
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
      readRange: async () => []
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

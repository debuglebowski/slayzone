/**
 * `ChatEventLog`: the one owner of a chat tab's sequence numbers. Rows are
 * inserted in order, never replaced; a clash is reported, never an overwrite.
 */
import { expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { ChatEventLog, type ChatEventPersistence } from './chat-events-store'

function memoryStore(opts: { delayMs?: number } = {}) {
  const rows = new Map<string, { seq: number; event: AgentEvent }>()
  const order: number[] = []
  const persistence: ChatEventPersistence = {
    insert: async (tabId, seq, event) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, Math.random() * opts.delayMs!))
      const key = `${tabId}:${seq}`
      if (rows.has(key)) return 'clash'
      rows.set(key, { seq, event })
      order.push(seq)
      return 'inserted'
    }
  }
  return { rows, order, persistence }
}

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
      }
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

test('keeps at most `cap` events in memory, newest last', () => {
  const store = memoryStore()
  const log = new ChatEventLog('tab', store.persistence, { events: [], nextSeq: 0 }, { cap: 3 })
  for (let i = 0; i < 5; i++) log.append(text(String(i)))
  expect(log.since(-1).map((e) => e.seq)).toEqual([2, 3, 4])
  expect(log.since(3).map((e) => e.seq)).toEqual([4])
})

test('a seed longer than the cap keeps its newest events', () => {
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

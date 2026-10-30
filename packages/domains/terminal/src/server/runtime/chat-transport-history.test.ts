/**
 * A tab's history is never cut (plan 4.1): the transport keeps only the newest
 * events in memory, but a replay — what a chat panel opens with — and the saved
 * buffer read return EVERY saved event, the older ones read back from the store.
 */
import { afterEach, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { CACHED_EVENTS_PER_TAB } from '../chat-events-store'
import * as mgr from './chat-transport-manager'
import { emitLine, sj, startTab, TAB_OPTS, transportHarness, until } from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const history = (n: number) =>
  Array.from({ length: n }, (_, seq) => ({
    seq,
    event: { kind: 'stderr', text: `old ${seq}` } as AgentEvent
  }))

test('a replay of a history longer than the in-memory cache returns all of it, in order', async () => {
  const total = CACHED_EVENTS_PER_TAB + 500
  transportHarness({ history: history(total) })
  await mgr.hydrateSession({ ...TAB_OPTS })
  const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
  expect(replay.events).toHaveLength(total)
  expect(replay.events.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i))
  expect(replay.live.afterSeq).toBe(total - 1)
  // From a seq inside the old part: the rest of it, then the cache.
  const tail = await mgr.getReplay(TAB_OPTS.tabId, 99)
  expect(tail.events[0].seq).toBe(100)
  expect(tail.events).toHaveLength(total - 100)
})

test('events saved after the cache filled are in the replay too', async () => {
  const total = CACHED_EVENTS_PER_TAB + 10
  const h = transportHarness({ history: history(total) })
  await startTab()
  const f = h.fakes[0]
  emitLine(f, sj.init('sid-h'))
  await until(() => h.rows.length > 0)
  const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
  expect(replay.events.length).toBe(total + h.rows.length)
  const seqs = replay.events.map((e) => e.seq)
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i))
  expect(await mgr.readEventsSince(TAB_OPTS.tabId, -1)).toHaveLength(seqs.length)
})

test('a saved event carries the time it was saved: its broadcast, its row and a replay agree', async () => {
  const h = transportHarness({
    history: [{ seq: 0, event: { kind: 'stderr', text: 'old' } as AgentEvent, at: 1_000 }]
  })
  await startTab()
  emitLine(h.fakes[0], sj.init('sid-t'))
  await until(() => h.rows.length > 0)
  const saved = h.broadcasts.filter((b) => b.live === undefined)
  expect(saved.length).toBeGreaterThan(0)
  for (const b of saved) {
    expect(typeof b.at).toBe('number')
    expect(h.rows.find((r) => r.seq === b.seq)?.at).toBe(b.at)
  }
  // Live-only events (fragments, `sending`) have no saved time.
  for (const b of h.broadcasts.filter((b) => b.live !== undefined)) expect(b.at).toBeUndefined()
  const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
  expect(replay.events[0].at).toBe(1_000)
  for (const b of saved) expect(replay.events.find((e) => e.seq === b.seq)?.at).toBe(b.at)
})

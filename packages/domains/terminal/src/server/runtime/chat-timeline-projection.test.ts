/**
 * The hub's timeline projection: what a client opens from (the state as of now,
 * plus the sealed pages it can load) must equal a full replay of the saved
 * events — after a rebuild, after a restart from its checkpoint, with old pages
 * changed by late events, for both providers. Its memory holds the tail and a
 * few pages, never the whole history.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'
import {
  initialState,
  reducer,
  type ChatTimelineState,
  type TimelineItem
} from '../../shared/chat-timeline'
import { decodeTimelineState } from '../../shared/chat-timeline-checkpoint'
import type { BufferedEvent } from '../chat-events-store'
import type { TimelineWrite } from '../chat-timeline-store'
import {
  TIMELINE_PAGE_ROWS,
  TIMELINE_PROJECTION_VERSION,
  TimelineProjection,
  type TimelineProjectionStore
} from './chat-timeline-projection'

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z'), toFake: ['Date'] })
})
afterAll(() => {
  vi.useRealTimers()
})

function memoryStore() {
  const pages = new Map<number, { rows: string; summary: string; searchText: string }>()
  let checkpoint: { version: string; seq: number; data: string } | null = null
  const writes: TimelineWrite[] = []
  let fail = false
  let discarded = 0
  const store: TimelineProjectionStore = {
    loadCheckpoint: async () => checkpoint,
    loadPages: async (wanted) =>
      wanted.flatMap((page) => {
        const p = pages.get(page)
        return p ? [{ page, rows: p.rows }] : []
      }),
    loadSummaries: async () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, p]) => ({ page, summary: p.summary })),
    save: async (write) => {
      if (fail) throw new Error('disk full')
      writes.push(write)
      if (write.dropPagesFrom !== null) {
        for (const page of [...pages.keys()]) if (page >= write.dropPagesFrom) pages.delete(page)
      }
      for (const p of write.pages)
        pages.set(p.page, { rows: p.rows, summary: p.summary, searchText: p.searchText })
      checkpoint = write.checkpoint
    },
    searchPages: async (needle) =>
      [...pages.entries()]
        .filter(([, p]) => p.searchText.includes(needle))
        .map(([page]) => page)
        .sort((a, b) => a - b),
    discard: async () => {
      discarded++
      pages.clear()
      checkpoint = null
    }
  }
  return {
    store,
    pages,
    writes,
    get checkpoint() {
      return checkpoint
    },
    set checkpoint(c) {
      checkpoint = c
    },
    get discarded() {
      return discarded
    },
    failWrites: (on: boolean) => {
      fail = on
    }
  }
}

const buffered = (events: AgentEvent[], from = 0): BufferedEvent[] =>
  events.map((event, i) => ({ seq: from + i, event, at: 1_000 + from + i }))

/** A full replay of the same saved events (times included). */
function fullReplay(history: BufferedEvent[], agentStartedTurns: boolean): ChatTimelineState {
  return reducer(initialState({ agentStartedTurns }), {
    type: 'events',
    events: history.map((b) => b.event),
    at: history.map((b) => b.at),
    seq: history.map((b) => b.seq)
  })
}

/** What a client sees: the snapshot, every sealed page loaded into it. */
async function clientView(p: TimelineProjection): Promise<ChatTimelineState> {
  const open = await p.openSnapshot()
  let state = decodeTimelineState(open.state)
  const sealed = open.summaries.length
  const got = await p.pagesAsOf(
    Array.from({ length: sealed }, (_, i) => i),
    open.seq,
    open.epoch
  )
  if (got.expired) throw new Error('expired')
  for (const page of got.pages) {
    state = reducer(state, {
      type: 'rows-loaded',
      from: page.from,
      rows: page.rows,
      epoch: open.epoch
    })
  }
  return state
}

/** Meaning, not the indexes' internal layout. */
function meaning(state: ChatTimelineState): unknown {
  return JSON.parse(
    JSON.stringify(state, (_k, v: unknown) => {
      if (v instanceof Map) return { $map: [...v.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
      if (v && typeof v === 'object' && !Array.isArray(v) && 'entries' in v) {
        const idx = v as { entries(): Iterable<[string, unknown]> }
        return { $index: [...idx.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) }
      }
      return v
    })
  )
}

/** Pages a projection may hold besides its tail, at most (budget + one in flight). */
const MAX_RESIDENT = 2 * 8 + 4

const resident = (state: ChatTimelineState): number =>
  state.timeline.filter((r) => r !== undefined).length

describe.each([
  ['claude', true],
  ['codex', false]
] as const)('%s', (provider, agentStartedTurns) => {
  const events = buildLongSession({ events: 12_000, seed: 21, provider, askEveryTool: true })

  test('rebuilt from the events: the client view is a full replay; pages written, memory bounded', async () => {
    const mem = memoryStore()
    const history = buffered(events)
    const p = await TimelineProjection.open({ store: mem.store, history, agentStartedTurns })
    const full = fullReplay(history, agentStartedTurns)
    expect(meaning(await clientView(p))).toEqual(meaning(full))
    const sealed = Math.floor((full.timeline.length - TIMELINE_PAGE_ROWS) / TIMELINE_PAGE_ROWS)
    expect(mem.pages.size).toBe(sealed)
    expect(mem.writes[0].dropPagesFrom).toBe(0)
    expect(mem.checkpoint?.version).toBe(TIMELINE_PROJECTION_VERSION)
    // The open snapshot holds only the tail's rows.
    const open = await p.openSnapshot()
    expect(resident(decodeTimelineState(open.state))).toBeLessThan(2 * TIMELINE_PAGE_ROWS)
    expect(p.residentRows).toBeLessThan(12 * TIMELINE_PAGE_ROWS)
  })

  test('reopened from its checkpoint (no rebuild) and fed newer events: still a full replay', async () => {
    const mem = memoryStore()
    const first = buffered(events.slice(0, 8_000))
    const p1 = await TimelineProjection.open({
      store: mem.store,
      history: first,
      agentStartedTurns
    })
    await p1.close()
    const writes = mem.writes.length
    const all = buffered(events)
    const p2 = await TimelineProjection.open({ store: mem.store, history: all, agentStartedTurns })
    expect(meaning(await clientView(p2))).toEqual(meaning(fullReplay(all, agentStartedTurns)))
    await p2.flush()
    // Only what the newer events changed or sealed was written: no rebuild.
    expect(mem.writes.slice(writes).every((w) => w.dropPagesFrom === null)).toBe(true)
  })

  test('live: events applied one by one, a late change to an evicted page goes out again; older rows are served as they were', async () => {
    const mem = memoryStore()
    const head = buffered(events.slice(0, 6_000))
    const p = await TimelineProjection.open({ store: mem.store, history: head, agentStartedTurns })
    // A tool call in page 0, its result arriving now (a long-running call).
    const fullHead = fullReplay(head, agentStartedTurns)
    const old = (fullHead.timeline as TimelineItem[]).findIndex(
      (r, i) => i < TIMELINE_PAGE_ROWS && r.kind === 'tool'
    )
    const oldRow = fullHead.timeline[old] as Extract<TimelineItem, { kind: 'tool' }>
    const late: AgentEvent = {
      kind: 'tool-result',
      toolUseId: oldRow.invocation.id,
      isError: false,
      rawContent: 'LATE RESULT',
      structured: null
    }
    const rest = buffered(
      [...events.slice(6_000, 7_000), late, ...events.slice(7_000, 7_500)],
      6_000
    )
    for (const b of rest) p.apply(b)
    const all = [...head, ...rest]
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(all, agentStartedTurns)))
    // As of the event before the late result: the old row as it was.
    const lateSeq = rest.find((b) => b.event === late)!.seq
    const open = await p.openSnapshot()
    const before = await p.pagesAsOf([0], lateSeq - 1, open.epoch)
    expect(before.expired).toBe(false)
    if (!before.expired)
      expect(before.pages[0].rows[old]).toEqual(
        fullReplay(all.slice(0, lateSeq), agentStartedTurns).timeline[old]
      )
    // Stored: the page went out again with the change.
    await p.flush()
    const stored = JSON.parse(mem.pages.get(0)!.rows) as TimelineItem[]
    expect(JSON.stringify(stored[old])).toContain('LATE RESULT')
    // Pages from another epoch: expired (the client opens again).
    expect((await p.pagesAsOf([0], open.seq, open.epoch + 1)).expired).toBe(true)
  })
})

describe('thrown away and rebuilt', () => {
  const events = buildLongSession({ events: 3_000, seed: 5 })
  const history = buffered(events)

  test('a checkpoint of another version', async () => {
    const mem = memoryStore()
    await (
      await TimelineProjection.open({ store: mem.store, history, agentStartedTurns: true })
    ).close()
    mem.checkpoint = { ...mem.checkpoint!, version: '0.0' }
    const before = mem.writes.length
    const p = await TimelineProjection.open({ store: mem.store, history, agentStartedTurns: true })
    expect(mem.writes[before].dropPagesFrom).toBe(0)
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(history, true)))
  })

  test('an unreadable checkpoint, and one ahead of the events', async () => {
    for (const bad of [
      (c: { version: string; seq: number; data: string }) => ({ ...c, data: '{oops' }),
      (c: { version: string; seq: number; data: string }) => ({ ...c, seq: 99_999 })
    ]) {
      const mem = memoryStore()
      await (
        await TimelineProjection.open({ store: mem.store, history, agentStartedTurns: true })
      ).close()
      mem.checkpoint = bad(mem.checkpoint!)
      const p = await TimelineProjection.open({
        store: mem.store,
        history,
        agentStartedTurns: true
      })
      expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(history, true)))
    }
  })

  test('memory stays bounded: a rebuild, and a burst of changes to every old page', async () => {
    const big = buffered(buildLongSession({ events: 20_000, seed: 11 }))
    const mem = memoryStore()
    const p = await TimelineProjection.open({
      store: mem.store,
      history: big,
      agentStartedTurns: true
    })
    expect(mem.pages.size).toBeGreaterThan(40)
    expect(p.peakResidentPages).toBeLessThanOrEqual(MAX_RESIDENT)
    // Pages written along the way; the (whole-history) checkpoint once, at the
    // end — before it, none is stored (pages never ahead of a stored checkpoint).
    expect(mem.writes.length).toBeGreaterThan(1)
    expect(mem.writes.filter((w) => w.checkpoint !== null)).toHaveLength(1)
    expect(mem.writes.at(-1)!.checkpoint).not.toBeNull()
    // Every message marked failed (the outbox, loading a tab saved before
    // delivery states): a change on every page, one event at a time.
    const ids = big.flatMap((b) =>
      b.event.kind === 'user-message' && b.event.id ? [b.event.id] : []
    )
    const burst = buffered(
      ids.map((id) => ({ kind: 'user-message-delivery', id, state: 'failed', error: 'x' })),
      big.length
    )
    for (const b of burst) p.apply(b)
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay([...big, ...burst], true)))
    expect(p.peakResidentPages).toBeLessThanOrEqual(MAX_RESIDENT)

    // The same burst saved after the checkpoint (the hub restarted): folded in at open.
    const cold = memoryStore()
    await (
      await TimelineProjection.open({ store: cold.store, history: big, agentStartedTurns: true })
    ).close()
    const reopened = await TimelineProjection.open({
      store: cold.store,
      history: [...big, ...burst],
      agentStartedTurns: true
    })
    expect(reopened.peakResidentPages).toBeLessThanOrEqual(MAX_RESIDENT)
    // Folded at open with pages written along the way: stored again, complete.
    expect(cold.checkpoint?.seq).toBe(big.length + burst.length - 1)
    expect(meaning(await clientView(reopened))).toEqual(
      meaning(fullReplay([...big, ...burst], true))
    )
  })

  test('a stored page that cannot be read: thrown away (clients open from the events), the next open rebuilds', async () => {
    for (const read of ['client', 'late event'] as const) {
      const mem = memoryStore()
      await (
        await TimelineProjection.open({ store: mem.store, history, agentStartedTurns: true })
      ).close()
      mem.pages.set(0, { ...mem.pages.get(0)!, rows: '{oops' })
      const p = await TimelineProjection.open({
        store: mem.store,
        history,
        agentStartedTurns: true,
        onError: () => undefined
      })
      const open = await p.openSnapshot()
      if (read === 'client') {
        // A client loading it: expired (it opens again, from the events).
        expect((await p.pagesAsOf([0], open.seq, open.epoch)).expired).toBe(true)
      } else {
        // A late result for a row of that page.
        const first = (fullReplay(history, true).timeline as TimelineItem[]).find(
          (r) => r.kind === 'tool'
        ) as Extract<TimelineItem, { kind: 'tool' }>
        p.apply({
          seq: history.length,
          at: 5_000,
          event: {
            kind: 'tool-result',
            toolUseId: first.invocation.id,
            isError: false,
            rawContent: 'late',
            structured: null
          }
        })
        await p.flush()
      }
      expect(p.usable).toBe(false)
      await expect(p.openSnapshot()).rejects.toThrow()
      expect(mem.discarded).toBe(1)
      expect(mem.checkpoint).toBeNull()
      // Not written again by this one.
      await p.close()
      expect(mem.checkpoint).toBeNull()
      // The next open: rebuilt, a full replay.
      const again = await TimelineProjection.open({
        store: mem.store,
        history,
        agentStartedTurns: true
      })
      expect(meaning(await clientView(again))).toEqual(meaning(fullReplay(history, true)))
    }
  })

  test('the store failing: the projection keeps serving from memory', async () => {
    const mem = memoryStore()
    mem.failWrites(true)
    const p = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      onError: () => undefined
    })
    expect(p.usable).toBe(true)
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(history, true)))
  })
})

test('search: pages that may hold the text, a changed page always among them', async () => {
  const events = buildLongSession({ events: 4_000, seed: 8 })
  const marked = events.map((e, i) =>
    i === 40 && e.kind === 'user-message' ? { ...e, text: 'needle-XYZ here' } : e
  )
  const at40 =
    marked[40].kind === 'user-message' ? 40 : marked.findIndex((e) => e.kind === 'user-message')
  if (at40 !== 40)
    marked[at40] = {
      ...(marked[at40] as Extract<AgentEvent, { kind: 'user-message' }>),
      text: 'needle-XYZ here'
    }
  const mem = memoryStore()
  const p = await TimelineProjection.open({
    store: mem.store,
    history: buffered(marked),
    agentStartedTurns: true
  })
  const pages = await p.searchPages('NEEDLE-xyz')
  expect(pages).toContain(0)
  expect(await p.searchPages('no such text anywhere 123')).toEqual([])
})

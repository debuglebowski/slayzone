/**
 * The hub's timeline projection: what a client opens from (the state as of now,
 * plus the sealed pages it can load) must equal a full replay of the saved
 * events — after a rebuild, after a restart from its checkpoint, with old pages
 * changed by late events, for both providers. Its memory holds the tail and a
 * few pages, never the whole history.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  CHAT_HISTORY_DISPLAY_VERSION,
  jsonByteLength,
  type AgentEvent
} from '@slayzone/terminal-contracts'
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
  /** Fail the write with this index (0-based count of writes), once. */
  let failAt = -1
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
      if (writes.length === failAt) {
        failAt = -1
        throw new Error('disk full')
      }
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
    },
    failWriteAt: (index: number) => {
      failAt = index
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
  // An answer carries a page budget of rows; what did not fit is asked again.
  for (let wanted = Array.from({ length: sealed }, (_, i) => i); wanted.length > 0; ) {
    const got = await p.pagesAsOf(wanted, open.seq, open.epoch)
    if (got.expired) throw new Error('expired')
    for (const page of got.pages) {
      state = reducer(state, {
        type: 'rows-loaded',
        from: page.from,
        rows: page.rows,
        epoch: open.epoch
      })
    }
    wanted = got.omitted ?? []
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

  test('a small open window keeps older rows and summaries reachable across stored and in-memory pages', async () => {
    const mem = memoryStore()
    const history = buffered(events.slice(0, 6_000))
    const p = await TimelineProjection.open({ store: mem.store, history, agentStartedTurns })
    try {
      const legacy = await p.openSnapshot('client')
      const display = { windowed: true } as const
      const open = await p.openSnapshot('client', display)
      const state = decodeTimelineState(open.state)
      const oldState = decodeTimelineState(legacy.state)
      expect(open.pageRows).toBe(16)
      expect(resident(state)).toBeLessThan(32)
      expect(jsonByteLength(open)).toBeLessThan(jsonByteLength(legacy))
      const last = open.summaries.length - 1
      const from = last * open.pageRows
      expect(from).toBeGreaterThan(legacy.summaries.length * legacy.pageRows)
      expect(open.summaries.flatMap((summary) => summary.users)).toEqual(
        expect.arrayContaining(legacy.summaries.flatMap((summary) => summary.users))
      )
      for (const page of [0, last]) {
        const start = page * open.pageRows
        const got = await p.pagesAsOf([page], open.seq, open.epoch, start, 'client', display)
        expect(got.expired).toBe(false)
        if (got.expired) continue
        expect(got.pages[0]).toMatchObject({ page, from: start })
        expect(got.pages[0].rows).toHaveLength(open.pageRows)
        if (page !== last) continue
        const original = oldState.timeline.slice(from, from + open.pageRows)
        for (const [i, row] of got.pages[0].rows.entries()) {
          const before = original[i]
          if (row.kind === 'result' && row.copyDetail && before?.kind === 'result') {
            const detail = await p.toolDetail(row.copyDetail, 0)
            expect(JSON.parse(detail!.data)).toBe(before.copyText)
            continue
          }
          expect(JSON.stringify(row)).toBe(JSON.stringify(before))
        }
      }
    } finally {
      await p.close()
    }
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

  test('reuses a compatible v25 checkpoint and its sealed pages after the codec upgrade', async () => {
    const mem = memoryStore()
    const old = buffered(events.slice(0, 2_500))
    await (
      await TimelineProjection.open({ store: mem.store, history: old, agentStartedTurns: true })
    ).close()
    const cp = mem.checkpoint!
    const data = JSON.parse(cp.data)
    const state = JSON.parse(data.state)
    state.v = '25'
    for (const [key, value] of Object.entries(state.state)) {
      const packed = value as {
        $entries?: Record<string, unknown>
        $toolu?: Record<string, unknown>
      }
      if (packed?.$entries)
        state.state[key] = {
          $index: [
            ...Object.entries(packed.$entries),
            ...Object.entries(packed.$toolu ?? {}).map(([key, value]) => [`toolu_${key}`, value])
          ]
        }
    }
    data.state = JSON.stringify(state)
    mem.checkpoint = { ...cp, version: '25.1', data: JSON.stringify(data) }
    const fedFrom: number[] = []
    const p = await TimelineProjection.open({
      store: mem.store,
      history: {
        lastSeq: history.at(-1)!.seq,
        async *pages(afterSeq) {
          fedFrom.push(afterSeq)
          yield history.filter((b) => b.seq > afterSeq)
        }
      },
      agentStartedTurns: true
    })
    expect(fedFrom).toEqual([cp.seq])
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(history, true)))
    await p.close()
    expect(mem.checkpoint?.version).toBe(TIMELINE_PROJECTION_VERSION)
  })

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

describe('pages answered within a byte budget (rows carry screenshots: 32 pages could pass 100 MiB)', () => {
  const events = buildLongSession({
    events: 6_000,
    seed: 5,
    provider: 'claude',
    askEveryTool: true
  })

  test('an answer stops at the budget (the first page always fits) and names what it left out; asking again completes the view', async () => {
    const mem = memoryStore()
    const history = buffered(events)
    const budget = 64 * 1024
    const p = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      pageBudgetBytes: budget
    })
    const open = await p.openSnapshot()
    let state = decodeTimelineState(open.state)
    let wanted = Array.from({ length: open.summaries.length }, (_, i) => i)
    expect(wanted.length).toBeGreaterThan(4)
    let answers = 0
    while (wanted.length > 0) {
      const got = await p.pagesAsOf(wanted, open.seq, open.epoch)
      if (got.expired) throw new Error('expired')
      answers++
      const size = got.pages.reduce((n, page) => n + JSON.stringify(page.rows).length, 0)
      if (got.pages.length > 1) expect(size).toBeLessThanOrEqual(budget)
      expect(got.pages.length).toBeGreaterThan(0)
      expect([...got.pages.map((x) => x.page), ...(got.omitted ?? [])]).toEqual(wanted)
      for (const page of got.pages)
        state = reducer(state, {
          type: 'rows-loaded',
          from: page.from,
          rows: page.rows,
          epoch: open.epoch
        })
      wanted = got.omitted ?? []
    }
    expect(answers).toBeGreaterThan(1)
    expect(meaning(state)).toEqual(meaning(fullReplay(history, true)))
  })

  test('opened from a paged history source: the same projection as from the array', async () => {
    const history = buffered(events)
    const fromArray = await TimelineProjection.open({
      store: memoryStore().store,
      history,
      agentStartedTurns: true
    })
    const pagesRead: number[] = []
    const fromPages = await TimelineProjection.open({
      store: memoryStore().store,
      history: {
        lastSeq: history.at(-1)!.seq,
        async *pages(after) {
          const rest = history.filter((b) => b.seq > after)
          for (let i = 0; i < rest.length; i += 500) {
            pagesRead.push(i)
            yield rest.slice(i, i + 500)
          }
        }
      },
      agentStartedTurns: true
    })
    expect(pagesRead.length).toBeGreaterThan(1)
    expect(meaning(await clientView(fromPages))).toEqual(meaning(await clientView(fromArray)))
  })
})

describe('written in slices, one heavy step per loop turn (a boot restore opens dozens of chats)', () => {
  // 2026-11-14: restoring ~60 chats froze the computer 1–11 s at a time in
  // `flushNow → saveTimeline`: every dirty page plus the checkpoint went out in one
  // synchronous write, and every chat did its fold and write in the same loop turn.
  const events = buildLongSession({
    events: 6_000,
    seed: 9,
    provider: 'claude',
    askEveryTool: true
  })
  const slice = 64 * 1024
  const rowsBytes = (w: TimelineWrite) => w.pages.reduce((n, p) => n + p.rows.length, 0)

  test('a rebuild writes pages a slice at a time; the checkpoint only with the last', async () => {
    const mem = memoryStore()
    const history = buffered(events)
    const p = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      flushSliceBytes: slice
    })
    expect(mem.pages.size).toBeGreaterThan(4)
    expect(mem.writes.length).toBeGreaterThan(mem.pages.size / 2)
    // A slice holds one page, or pages within the slice budget.
    for (const w of mem.writes)
      if (w.pages.length > 1) expect(rowsBytes(w)).toBeLessThanOrEqual(slice)
    // Only the first write of a run drops pages; only the last stores the checkpoint.
    expect(mem.writes.filter((w) => w.dropPagesFrom !== null)).toHaveLength(1)
    expect(mem.writes[0].dropPagesFrom).toBe(0)
    expect(mem.writes.filter((w) => w.checkpoint !== null)).toHaveLength(1)
    expect(mem.writes.at(-1)!.checkpoint).not.toBeNull()
    expect(meaning(await clientView(p))).toEqual(meaning(fullReplay(history, true)))
  })

  test('a failure between two slices leaves no checkpoint: the next open rebuilds it whole', async () => {
    const mem = memoryStore()
    const history = buffered(events)
    mem.failWriteAt(1)
    const broken = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      flushSliceBytes: slice,
      onError: () => undefined
    })
    await broken.close()
    // The first slice dropped the stored checkpoint; nothing stored one after the failure.
    expect(mem.checkpoint).toBeNull()
    const reopened = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      flushSliceBytes: slice
    })
    expect(mem.checkpoint?.seq).toBe(history.at(-1)!.seq)
    expect(meaning(await clientView(reopened))).toEqual(meaning(fullReplay(history, true)))
  })

  test('many chats rebuilding at once: at most two heavy steps between two loop turns', async () => {
    let tick = 0
    let spinning = true
    const spin = () => {
      tick++
      if (spinning) setImmediate(spin)
    }
    setImmediate(spin)
    const perTick = new Map<number, number>()
    const stores = Array.from({ length: 6 }, () => {
      const mem = memoryStore()
      const save = mem.store.save
      mem.store.save = async (w) => {
        perTick.set(tick, (perTick.get(tick) ?? 0) + 1)
        return save(w)
      }
      return mem
    })
    const history = buffered(events)
    const opened = await Promise.all(
      stores.map((mem) =>
        TimelineProjection.open({
          store: mem.store,
          history,
          agentStartedTurns: true,
          flushSliceBytes: slice
        })
      )
    )
    spinning = false
    expect(opened.every((p) => p.usable)).toBe(true)
    expect(Math.max(...perTick.values())).toBeLessThanOrEqual(2)
    expect(perTick.size).toBeGreaterThan(stores.length)
  })
})

describe('a page larger than the answer budget, asked from a row on (`startRow`)', () => {
  // A 256-row page of long tool output measured 4–6.6 MB on the dev store (rows up
  // to 2.2 MB), nothing bounds it: the page was the smallest unit an answer had.
  const events = buildLongSession({
    events: 6_000,
    seed: 5,
    provider: 'claude',
    askEveryTool: true
  })
  const rowBytes = (rows: unknown[]) =>
    rows.reduce<number>((n, r) => n + JSON.stringify(r).length, 0)

  test('row slices within the budget (one row always), resumed from `next`, complete the view', async () => {
    const mem = memoryStore()
    const history = buffered(events)
    const budget = 8 * 1024
    const p = await TimelineProjection.open({
      store: mem.store,
      history,
      agentStartedTurns: true,
      pageBudgetBytes: budget
    })
    const open = await p.openSnapshot()
    let state = decodeTimelineState(open.state)
    let wanted = Array.from({ length: open.summaries.length }, (_, i) => i)
    expect(wanted.length).toBeGreaterThan(2)
    let startRow = 0
    let partial = 0
    for (let guard = 0; wanted.length > 0; guard++) {
      expect(guard).toBeLessThan(10_000)
      const got = await p.pagesAsOf(wanted, open.seq, open.epoch, startRow)
      if (got.expired) throw new Error('expired')
      expect(got.pages.length).toBeGreaterThan(0)
      const rows = got.pages.flatMap((x) => x.rows)
      if (rows.length > 1) expect(rowBytes(rows)).toBeLessThanOrEqual(budget)
      for (const page of got.pages)
        state = reducer(state, {
          type: 'rows-loaded',
          from: page.from,
          rows: page.rows,
          epoch: open.epoch
        })
      if (got.next !== undefined) partial++
      wanted = got.omitted ?? []
      startRow = got.next ?? (wanted[0] ?? 0) * TIMELINE_PAGE_ROWS
    }
    expect(partial).toBeGreaterThan(0)
    expect(meaning(state)).toEqual(meaning(fullReplay(history, true)))
  })

  test('without `startRow` a page is answered whole, as before (older clients)', async () => {
    const mem = memoryStore()
    const p = await TimelineProjection.open({
      store: mem.store,
      history: buffered(events),
      agentStartedTurns: true,
      pageBudgetBytes: 8 * 1024
    })
    const open = await p.openSnapshot()
    const got = await p.pagesAsOf([0, 1], open.seq, open.epoch)
    if (got.expired) throw new Error('expired')
    expect(got.pages.map((x) => x.page)).toEqual([0])
    expect(got.pages[0].rows).toHaveLength(TIMELINE_PAGE_ROWS)
    expect(got.omitted).toEqual([1])
    expect(got).not.toHaveProperty('next')
  })
})

describe('historical rows that became smaller after the snapshot', () => {
  test.each([
    ['resident', 'rows'],
    ['stored', 'rows'],
    ['resident', 'pages'],
    ['stored', 'pages']
  ] as const)('%s %s are sized after undo and remain fully reachable', async (cache, mode) => {
    const mem = memoryStore()
    const history = buffered(buildLongSession({ events: 12_000, seed: 21, askEveryTool: true }))
    const original = fullReplay(history, true)
    const tools = (page: number) =>
      original.timeline
        .slice(page * TIMELINE_PAGE_ROWS, (page + 1) * TIMELINE_PAGE_ROWS)
        .filter((row): row is Extract<TimelineItem, { kind: 'tool' }> => row?.kind === 'tool')
    const targets = [0, 1].flatMap((page) => tools(page).slice(0, 2))
    expect(targets).toHaveLength(4)
    const expanded = buffered(
      targets.map((row, i) => ({
        kind: 'tool-result',
        toolUseId: row.invocation.id,
        isError: false,
        rawContent: `historical-${i}:` + 'µ'.repeat(96 * 1024),
        structured: null
      })),
      history.length
    )
    const budget = 768 * 1024
    const p = await TimelineProjection.open({
      store: mem.store,
      history: [...history, ...expanded],
      agentStartedTurns: true,
      pageBudgetBytes: budget
    })
    try {
      const snapshot = await p.openSnapshot()
      const expected = fullReplay([...history, ...expanded], true).timeline.slice(
        0,
        2 * TIMELINE_PAGE_ROWS
      )
      // Each historical page fits alone, both together do not. Each historical
      // row fits too; the one-oversized-row/page allowance cannot mask the bug.
      for (let page = 0; page < 2; page++)
        expect(
          Buffer.byteLength(
            JSON.stringify(
              expected.slice(page * TIMELINE_PAGE_ROWS, (page + 1) * TIMELINE_PAGE_ROWS)
            )
          )
        ).toBeLessThan(budget)
      expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(budget)
      let seq = snapshot.seq + 1
      // Two changes per row exercise newest-to-oldest undo, not just one value.
      for (const text of ['intermediate', 'tiny'])
        for (const row of targets)
          await p.apply({
            seq: seq++,
            at: 99_000,
            event: {
              kind: 'tool-result',
              toolUseId: row.invocation.id,
              isError: false,
              rawContent: text,
              structured: null
            }
          })
      if (cache === 'stored') {
        // Touch other pages through real late results, then flush: pages 0/1
        // leave the resident cache while their historical undo remains valid.
        expect(snapshot.summaries.length).toBeGreaterThan(12)
        for (let page = 2; page < snapshot.summaries.length; page++) {
          const [row] = tools(page)
          if (row)
            await p.apply({
              seq: seq++,
              at: 99_000,
              event: {
                kind: 'tool-result',
                toolUseId: row.invocation.id,
                isError: false,
                rawContent: 'evict earlier pages',
                structured: null
              }
            })
        }
      }
      await p.flush()
      const reads = vi.spyOn(mem.store, 'loadPages')
      const collected: TimelineItem[] = []
      let wanted = [0, 1],
        start = 0,
        replies = 0
      while (wanted.length) {
        expect(replies++).toBeLessThan(20)
        const got = await p.pagesAsOf(
          wanted,
          snapshot.seq,
          snapshot.epoch,
          mode === 'rows' ? start : undefined
        )
        if (got.expired) throw new Error('historical snapshot expired')
        expect(got.pages.length).toBeGreaterThan(0)
        const bytes =
          mode === 'rows'
            ? got.pages
                .flatMap((page) => page.rows)
                .reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)
            : got.pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page.rows)), 0)
        expect(bytes).toBeLessThanOrEqual(budget)
        for (const page of got.pages) {
          expect(page.from).toBe(collected.length)
          collected.push(...page.rows)
        }
        wanted = got.omitted ?? []
        if (got.next !== undefined) {
          expect(mode).toBe('rows')
          expect(got.next).toBe(collected.length)
          expect(wanted[0]).toBe(Math.floor(got.next / TIMELINE_PAGE_ROWS))
        }
        start = got.next ?? (wanted[0] ?? 0) * TIMELINE_PAGE_ROWS
      }
      expect(replies).toBeGreaterThan(1)
      expect(collected).toEqual(expected)
      expect(reads.mock.calls.some(([pages]) => pages.includes(0))).toBe(cache === 'stored')
      // Undo must not mutate the live rows while serving historical text.
      const live = await p.openSnapshot()
      const current = await p.pagesAsOf([0, 1], live.seq, live.epoch)
      if (current.expired) throw new Error('live snapshot expired')
      expect(JSON.stringify(current.pages)).not.toContain('historical-')
      expect(JSON.stringify(current.pages)).toContain('tiny')
    } finally {
      await p.close()
    }
  })
})

test('opt-in opens preview large tool results and read the original through bounded detail chunks', async () => {
  const rawContent = 'long 🧪 command output\n'.repeat(12_000)
  const history = buffered([
    { kind: 'tool-call', id: 'command', name: 'Bash', input: { command: 'build' } },
    { kind: 'tool-result', toolUseId: 'command', rawContent, structured: null, isError: false }
  ])
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history,
    agentStartedTurns: true
  })
  try {
    const compact = await projection.openSnapshot('instance')
    expect(compact.state.length).toBeLessThan(8_000)
    const [row] = decodeTimelineState(compact.state).timeline
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') throw new Error('missing tool')
    const { toolDetail } = row.invocation as typeof row.invocation & {
      toolDetail: { instance: string; epoch: number; row: number; toolUseId: string }
    }
    expect(toolDetail).toEqual({
      instance: 'instance',
      epoch: compact.epoch,
      row: 0,
      toolUseId: 'command'
    })
    const parts: string[] = []
    let offset = 0
    let revision: string | undefined
    for (;;) {
      const chunk = await projection.toolDetail(toolDetail, offset, revision)
      if (!chunk) throw new Error('missing chunk')
      expect(chunk.data.length).toBeLessThanOrEqual(64 * 1024)
      parts.push(chunk.data)
      if (chunk.next === null) break
      revision = chunk.revision
      offset = chunk.next
    }
    expect(parts.length).toBeGreaterThan(1)
    expect(JSON.parse(parts.join('')).result.rawContent).toBe(rawContent)
    expect(await projection.toolDetail({ ...toolDetail, toolUseId: 'other' }, 0)).toBeNull()

    const [legacy] = decodeTimelineState((await projection.openSnapshot()).state).timeline
    expect(legacy?.kind === 'tool' && legacy.invocation.result?.rawContent).toBe(rawContent)

    const first = await projection.toolDetail(toolDetail, 0)
    if (!first?.next) throw new Error('expected another chunk')
    await projection.apply({
      seq: 2,
      event: {
        kind: 'tool-result',
        toolUseId: 'command',
        rawContent: 'updated result',
        structured: null,
        isError: false
      }
    })
    expect(await projection.toolDetail(toolDetail, first.next, first.revision)).toBeNull()
    expect(await projection.toolDetail(toolDetail, 0)).toMatchObject({
      data: expect.stringContaining('updated result')
    })
  } finally {
    await projection.close()
  }
})

test('file previews preserve change counts and search beyond the preview in sealed pages and the tail', async () => {
  const body = 'large file line\n'.repeat(4_000) + 'HiddenSearchWord\n'
  const write = (id: string, path: string): AgentEvent[] => [
    { kind: 'tool-call', id, name: 'Write', input: { file_path: path, content: body } },
    {
      kind: 'tool-result',
      toolUseId: id,
      rawContent: 'saved',
      structured: { type: 'create', filePath: path, content: body },
      isError: false
    }
  ]
  const history = buffered([
    ...write('older', '/repo/older.txt'),
    ...Array.from(
      { length: TIMELINE_PAGE_ROWS * 3 },
      (_, i): AgentEvent => ({ kind: 'assistant-text', messageId: `message-${i}`, text: 'row' })
    ),
    ...write('newer', '/repo/newer.txt')
  ])
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history,
    agentStartedTurns: true
  })
  try {
    const opened = await projection.openSnapshot('instance')
    const tail = decodeTimelineState(opened.state).timeline.at(-1)
    if (tail?.kind !== 'tool') throw new Error('missing Write row')
    expect(tail.invocation.input).toMatchObject({ file_path: '/repo/newer.txt' })
    expect(opened.state).not.toContain('HiddenSearchWord')
    expect(tail.invocation.toolPreview?.files).toEqual([
      { path: '/repo/newer.txt', additions: 4001, deletions: 0, created: true }
    ])
    const older = await projection.pagesAsOf([0], opened.seq, opened.epoch, 0, 'instance')
    expect(JSON.stringify(older)).not.toContain('HiddenSearchWord')
    expect(await projection.searchToolMatches('hiddensearchword', false)).toEqual({
      pages: [0],
      windowedPages: [0, Math.floor((history.length - 2) / 16)],
      toolUseIds: ['older', 'newer']
    })
    expect(await projection.searchToolMatches('hiddensearchword', true)).toEqual({
      pages: [0],
      windowedPages: [],
      toolUseIds: []
    })
  } finally {
    await projection.close()
  }
})

test('Codex file previews retain exact diff counts and recover the original patch', async () => {
  const hidden = 'new line '.repeat(1_500) + 'end of patch'
  const diff = `@@ -1 +1 @@\n-old line\n+${hidden}`
  const changes = [{ path: '/repo/code.ts', kind: { type: 'update' }, diff }]
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history: buffered([
      { kind: 'tool-call', id: 'edit', name: 'codex/fileChange', input: { changes } },
      {
        kind: 'tool-result',
        toolUseId: 'edit',
        rawContent: '',
        structured: { changes },
        isError: false
      }
    ]),
    agentStartedTurns: true
  })
  try {
    const opened = await projection.openSnapshot('session')
    const row = decodeTimelineState(opened.state).timeline[0]
    if (row?.kind !== 'tool' || !row.invocation.toolDetail) throw new Error('missing preview')
    expect(opened.state.includes('end of patch')).toBe(false)
    expect(row.invocation.toolPreview?.files).toEqual([
      { path: '/repo/code.ts', additions: 1, deletions: 1, created: false }
    ])
    const chunk = await projection.toolDetail(row.invocation.toolDetail, 0)
    expect(chunk?.next).toBeNull()
    expect(JSON.parse(chunk!.data).result.structured.changes[0].diff).toEqual(diff)
  } finally {
    await projection.close()
  }
})

test('hidden thinking sends a stub in the tail and history pages and retains full text for search and reveal', async () => {
  const thought = 'MixedCase reasoning '.repeat(4_000)
  const thinking = (messageId: string): AgentEvent => ({
    kind: 'assistant-thinking',
    messageId,
    text: thought,
    hasSignature: true
  })
  const history = buffered([
    thinking('old'),
    ...Array.from(
      { length: TIMELINE_PAGE_ROWS * 2 },
      (_, i): AgentEvent => ({
        kind: 'assistant-text',
        messageId: `text-${i}`,
        text: 'Keep this answer'
      })
    ),
    thinking('new')
  ])
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history,
    agentStartedTurns: true
  })
  try {
    const hidden = await projection.openSnapshot('instance', { hideThinking: true })
    const visible = await projection.openSnapshot('instance')
    expect(hidden.displaySettings).toBe(CHAT_HISTORY_DISPLAY_VERSION)
    expect(hidden.state.length).toBeLessThan(visible.state.length - thought.length / 2)
    expect(hidden.state).toContain('Keep this answer')
    const oldPage = await projection.pagesAsOf([0], hidden.seq, hidden.epoch, 0, 'instance', {
      hideThinking: true
    })
    expect(oldPage.expired).toBe(false)
    if (oldPage.expired) throw new Error('missing old page')
    const old = oldPage.pages[0].rows[0]
    const latest = decodeTimelineState(hidden.state).timeline.at(-1)
    for (const row of [old, latest]) {
      if (row?.kind !== 'thinking' || !row.textDetail) throw new Error('missing thinking stub')
      expect(row.text).toBe('')
      expect(row.hasSignature).toBe(true)
      expect(
        await projection.toolDetail({ ...row.textDetail, messageId: 'different' }, 0)
      ).toBeNull()
      const first = await projection.toolDetail(row.textDetail, 0)
      if (!first?.next) throw new Error('expected chunking')
      const second = await projection.toolDetail(row.textDetail, first.next, first.revision)
      expect(second?.next).toBeNull()
      expect(JSON.parse(first.data + second?.data)).toBe(thought)
    }
    expect(await projection.searchToolMatches('MixedCase', true)).toMatchObject({
      textMatches: { epoch: hidden.epoch, rows: [0, history.length - 1] }
    })
    expect(await projection.searchToolMatches('mixedcase', true)).not.toHaveProperty('textMatches')
  } finally {
    await projection.close()
  }
})

test('hidden activities keep final answers and file counts while leaving bodies and reply copies on the computer', async () => {
  const progress = 'Searching earlier attempts '.repeat(4_000)
  const output = 'Full command output '.repeat(8_000)
  const patch = 'File body '.repeat(12_000)
  const history = buffered([
    { kind: 'user-message', id: 'start', text: 'Update the file' },
    { kind: 'assistant-text', messageId: 'progress', text: progress },
    { kind: 'tool-call', id: 'bash', name: 'Bash', input: { command: 'pwd' } },
    {
      kind: 'tool-result',
      toolUseId: 'bash',
      rawContent: output,
      structured: null,
      isError: false
    },
    {
      kind: 'tool-call',
      id: 'write',
      name: 'Write',
      input: { file_path: 'test.txt', content: patch }
    },
    {
      kind: 'tool-result',
      toolUseId: 'write',
      rawContent: null,
      structured: { type: 'create' },
      isError: false
    },
    { kind: 'assistant-text', messageId: 'final', text: 'File updated.' },
    {
      kind: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 100,
      durationApiMs: 90,
      totalCostUsd: 0,
      numTurns: 1,
      text: null,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      },
      modelUsage: {},
      stopReason: null,
      terminalReason: null,
      permissionDenials: []
    },
    { kind: 'user-message', id: 'open', text: 'Continue' },
    { kind: 'assistant-text', messageId: 'open-response', text: 'Still running.' },
    { kind: 'tool-call', id: 'work', name: 'Read', input: { file_path: 'working.txt' } },
    {
      kind: 'tool-result',
      toolUseId: 'work',
      rawContent: 'Current activity',
      structured: null,
      isError: false
    }
  ])
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history,
    agentStartedTurns: true
  })
  try {
    const config = { hideActivityMessages: true, hideActivityTools: true } as const
    const opened = await projection.openSnapshot('instance', config)
    expect(opened.state.length).toBeLessThan(8_000)
    const state = decodeTimelineState(opened.state)
    const row = state.timeline.find(
      (item) => item?.kind === 'text' && item.messageId === 'progress'
    )
    if (row?.kind !== 'text' || !row.textDetail)
      throw new Error('Expected a deferred activity message')
    expect(row.text).toBe('')
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'File updated.' })
    )
    expect(state.timeline).toContainEqual(
      expect.objectContaining({ kind: 'text', text: 'Still running.' })
    )
    const tool = state.timeline.find(
      (item) => item?.kind === 'tool' && item.invocation.id === 'write'
    )
    if (tool?.kind !== 'tool' || !tool.invocation.toolDetail)
      throw new Error('Expected a deferred tool')
    expect(tool.invocation.toolPreview).toMatchObject({
      hidden: true,
      files: [{ path: 'test.txt', additions: 1 }]
    })
    const preview = await projection.toolDetail({ ...tool.invocation.toolDetail, preview: true }, 0)
    if (!preview) throw new Error('Expected a revealed tool preview')
    expect(preview.next).toBeNull()
    expect(JSON.parse(preview.data)).toMatchObject({
      input: { file_path: 'test.txt' },
      toolPreview: { input: true, files: [{ path: 'test.txt' }] },
      toolDetail: tool.invocation.toolDetail
    })
    const result = state.timeline.find((item) => item?.kind === 'result')
    if (result?.kind !== 'result' || !result.copyDetail)
      throw new Error('Expected a deferred reply copy')
    expect(result.copyText).toBeNull()

    const fullText = async (
      ref: NonNullable<typeof result.copyDetail> | NonNullable<typeof row.textDetail>
    ) => {
      let part = await projection.toolDetail(ref, 0)
      if (!part) throw new Error('Expected full text')
      let text = part.data
      while (part.next !== null) {
        part = await projection.toolDetail(ref, part.next, part.revision)
        if (!part) throw new Error('Missing chunk')
        text += part.data
      }
      return JSON.parse(text)
    }
    expect(await fullText(row.textDetail)).toBe(progress)
    expect(await fullText(result.copyDetail)).toBe(progress + '\n\nFile updated.')
    expect(await projection.searchToolMatches('earlier attempts', true)).toMatchObject({
      textMatches: { epoch: opened.epoch, rows: [1] }
    })
    const closedDisclosure = await projection.openSnapshot('instance', { hideActivities: true })
    const closedTimeline = decodeTimelineState(closedDisclosure.state).timeline
    expect(closedTimeline).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        invocation: expect.objectContaining({
          id: 'write',
          toolPreview: expect.objectContaining({ hidden: true })
        })
      })
    )
    expect(closedTimeline).toContainEqual(
      expect.objectContaining({
        kind: 'tool',
        invocation: expect.objectContaining({ id: 'work', input: { file_path: 'working.txt' } })
      })
    )
  } finally {
    await projection.close()
  }
})

test('completed background polls leave no open index and late replies update the original shell from sealed rows', async () => {
  const events = buffered([
    {
      kind: 'tool-call',
      id: 'spawn',
      name: 'Bash',
      input: { command: 'check', run_in_background: true }
    },
    {
      kind: 'tool-result',
      toolUseId: 'spawn',
      rawContent: '',
      structured: { shellId: 'shell-1' },
      isError: false
    },
    { kind: 'tool-call', id: 'poll', name: 'BashOutput', input: { bash_id: 'shell-1' } },
    {
      kind: 'tool-result',
      toolUseId: 'poll',
      rawContent: '',
      structured: { status: 'running', stdout: 'first' },
      isError: false
    },
    ...Array.from(
      { length: TIMELINE_PAGE_ROWS * 6 },
      (_, i): AgentEvent => ({
        kind: 'assistant-text',
        messageId: `note-${i}`,
        text: 'More history'
      })
    )
  ])
  const projection = await TimelineProjection.open({
    store: memoryStore().store,
    history: events,
    agentStartedTurns: true
  })
  try {
    const before = decodeTimelineState((await projection.openSnapshot()).state)
    expect(before.timeline[1]).toBeUndefined()
    expect(before.bgShells.get('spawn')?.latestStdout).toBe('first')
    expect(before).not.toHaveProperty('bgShellPollIndex')
    await projection.apply(
      buffered(
        [
          {
            kind: 'tool-result',
            toolUseId: 'poll',
            rawContent: '',
            structured: { status: 'completed', stdout: 'last', exitCode: 0 },
            isError: false
          }
        ],
        events.length
      )[0]
    )
    const after = decodeTimelineState((await projection.openSnapshot()).state)
    expect(after.bgShells.get('spawn')).toMatchObject({
      latestStdout: 'last',
      status: 'completed',
      exitCode: 0
    })
  } finally {
    await projection.close()
  }
})

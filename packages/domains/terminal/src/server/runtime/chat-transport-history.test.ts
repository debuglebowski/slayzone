/**
 * A tab's history is never cut (plan 4.1): the transport keeps only the newest
 * events in memory, but a replay — what a chat panel opens with — and the saved
 * buffer read return EVERY saved event, the older ones read back from the store.
 */
import { afterEach, expect, test, vi } from 'vitest'
import {
  CHAT_HISTORY_PAGE_MAX_BYTES,
  jsonByteLength,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import { CACHED_EVENTS_PER_TAB, pageOfRows, type BufferedEvent } from '../chat-events-store'
import * as mgr from './chat-transport-manager'
import { TimelineProjection, TIMELINE_PROJECTION_VERSION } from './chat-timeline-projection'
import {
  emitLine,
  sj,
  startTab,
  TAB_OPTS,
  transportHarness,
  until,
  wait
} from './chat-transport-testkit'

afterEach(() => {
  mgr.__resetForTests()
  mgr.resetTransportDeps()
})

const history = (n: number) =>
  Array.from({ length: n }, (_, seq) => ({
    seq,
    event: { kind: 'stderr', text: `old ${seq}` } as AgentEvent
  }))

test.each([undefined, 'background-agent'])(
  'hydrate only interrupts unfinished main tools (parent %s)',
  async (parentToolUseId) => {
    const h = transportHarness({
      history: [
        { seq: 0, event: { kind: 'interrupted' } },
        {
          seq: 1,
          event: { kind: 'tool-call', id: 'late-tool', name: 'Bash', input: {}, parentToolUseId }
        }
      ]
    })
    await mgr.hydrateSession({ ...TAB_OPTS })
    expect(h.savedKinds().includes('interrupted')).toBe(parentToolUseId === undefined)
  }
)

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

// --- Bounded hydrate (2026-11-14 17:15: a hydrate/getReplay burst stalled the computer 18 s) ---

/**
 * A long history of heavy events (screenshots): a turn whose message was never
 * confirmed, left unfinished (a tool call, no result).
 */
function heavyHistory(n: number, kb: number): BufferedEvent[] {
  const out: BufferedEvent[] = []
  for (let seq = 0; seq < n - 3; seq++)
    out.push({ seq, event: { kind: 'stderr', text: `${seq}:${'x'.repeat(kb * 1024)}` } })
  out.push({
    seq: n - 3,
    event: { kind: 'user-message', id: 'm-lost', text: 'never confirmed' } as AgentEvent
  })
  out.push({ seq: n - 2, event: { kind: 'stderr', text: 'thinking' } })
  out.push({
    seq: n - 1,
    event: { kind: 'tool-call', id: 't1', name: 'Bash', input: {} }
  })
  return out
}

test('hydrating a huge history reads it a page at a time and gives the event loop back between pages', async () => {
  const rows = heavyHistory(6_000, 8) // ~48 MB
  // Another task on the loop; every read records how much was read since it last ran.
  let ticks = 0
  let stop = false
  const spin = () => {
    ticks++
    if (!stop) setImmediate(spin)
  }
  const reads: Array<{ bytes: number; tick: number }> = []
  const h = transportHarness({
    deps: {
      eventStore: {
        insert: async () => 'inserted',
        readPage: async (_tab, after, before, budget) => {
          const page = pageOfRows(rows, after, before, budget)
          reads.push({ bytes: page.bytes.reduce((a, b) => a + b, 0), tick: ticks })
          return page
        },
        tailStart: async (_tab, count) =>
          rows.length >= count ? rows[rows.length - count].seq : null
      }
    }
  })
  setImmediate(spin)
  try {
    await mgr.hydrateSession({ ...TAB_OPTS })
  } finally {
    stop = true
  }
  expect(reads.length).toBeGreaterThan(10)
  // No read is above a page (a single event over the budget would be alone).
  for (const r of reads) expect(r.bytes).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_MAX_BYTES)
  // Between two turns of the loop, at most two pages were read (the end of one pass
  // meets the start of the next): never a whole history in one synchronous stretch.
  let sinceTick = 0
  for (let i = 0; i < reads.length; i++) {
    sinceTick =
      i > 0 && reads[i].tick === reads[i - 1].tick ? sinceTick + reads[i].bytes : reads[i].bytes
    expect(sinceTick).toBeLessThanOrEqual(2 * CHAT_HISTORY_PAGE_MAX_BYTES)
  }
  // Same outcome as before: the unconfirmed message failed, the unfinished turn
  // got its interrupted marker, and the whole history replays.
  await until(() => h.saved().some((e) => e.kind === 'interrupted'))
  expect(
    h
      .saved()
      .some((e) => e.kind === 'user-message-delivery' && e.id === 'm-lost' && e.state === 'failed')
  ).toBe(true)
  const replay = await mgr.getReplay(TAB_OPTS.tabId, -1)
  expect(replay.events.slice(0, rows.length).map((e) => e.seq)).toEqual(rows.map((r) => r.seq))
})

test('a replay read page by page equals the whole replay; only the last page carries the live part', async () => {
  const rows = heavyHistory(3_000, 4)
  transportHarness({ history: rows })
  await mgr.hydrateSession({ ...TAB_OPTS })
  const whole = await mgr.getReplay(TAB_OPTS.tabId, -1)
  const paged: BufferedEvent[] = []
  let after = -1
  let pages = 0
  for (;;) {
    const page = await mgr.getReplayPage(TAB_OPTS.tabId, after, { maxBytes: 1024 * 1024 })
    pages++
    expect(jsonByteLength(page.events.map((e) => e.event))).toBeLessThanOrEqual(1024 * 1024 + 4096)
    paged.push(...page.events)
    if (!page.hasMore) {
      expect(page.live).toEqual(whole.live)
      break
    }
    expect('live' in page).toBe(false)
    after = page.events.at(-1)!.seq
  }
  expect(pages).toBeGreaterThan(5)
  expect(paged).toEqual(whole.events)
  const events: BufferedEvent[] = []
  for (let from = -1; ; ) {
    const page = await mgr.readEventPage(TAB_OPTS.tabId, from, { maxEvents: 500 })
    events.push(...page.events)
    if (!page.hasMore) break
    from = page.events.at(-1)!.seq
  }
  expect(events).toEqual(await mgr.readEventsSince(TAB_OPTS.tabId, -1))
})

test('a page of an unknown tab is empty, with no more and an empty live part', async () => {
  transportHarness()
  expect(await mgr.readEventPage('nope', -1)).toEqual({ events: [], hasMore: false })
  expect(await mgr.getReplayPage('nope', -1)).toEqual({
    events: [],
    hasMore: false,
    live: { afterSeq: -1, liveSeq: 0, events: [] }
  })
})

/** A projection store in memory (the computer keeps it in its chat SQLite). */
function memoryTimelineStore() {
  const pages = new Map<number, { rows: string; summary: string; searchText: string }>()
  let checkpoint: { version: string; seq: number; data: string } | null = null
  return {
    loadCheckpoint: async () => checkpoint,
    loadPages: async (wanted: readonly number[]) =>
      wanted.flatMap((page) => {
        const p = pages.get(page)
        return p ? [{ page, rows: p.rows }] : []
      }),
    loadSummaries: async () =>
      [...pages.entries()]
        .sort(([a], [b]) => a - b)
        .map(([page, p]) => ({ page, summary: p.summary })),
    save: async (write: {
      dropPagesFrom: number | null
      pages: Array<{ page: number; rows: string; summary: string; searchText: string }>
      checkpoint: { version: string; seq: number; data: string } | null
    }) => {
      if (write.dropPagesFrom !== null)
        for (const page of [...pages.keys()]) if (page >= write.dropPagesFrom) pages.delete(page)
      for (const p of write.pages) pages.set(p.page, p)
      checkpoint = write.checkpoint
    },
    searchPages: async () => [],
    discard: async () => {
      pages.clear()
      checkpoint = null
    }
  }
}

test('hydrate reports why the original checkpoint missed without reading it again', async () => {
  const store = memoryTimelineStore()
  await store.save({
    dropPagesFrom: null,
    pages: [],
    checkpoint: { version: 'old', seq: 0, data: '{}' }
  })
  const loadCheckpoint = vi.spyOn(store, 'loadCheckpoint')
  const diagnostic = vi.fn()
  transportHarness({
    history: history(1),
    deps: { timelineStore: () => store, diagnostic }
  })

  await mgr.hydrateSession({ ...TAB_OPTS })

  expect(loadCheckpoint).toHaveBeenCalledTimes(1)
  expect(diagnostic).toHaveBeenCalledWith(
    TAB_OPTS.tabId,
    expect.objectContaining({
      event: 'chat.open_hydrate',
      payload: expect.objectContaining({ restored: false, checkpoint: 'checkpoint-version' })
    })
  )
})

test('a burst of hydrates reads about one history page per event-loop turn in total, not one per tab', async () => {
  const rows = heavyHistory(3_000, 8) // ~24 MB per tab
  let readsSinceTick = 0
  let maxReadsPerTick = 0
  let stop = false
  const spin = () => {
    maxReadsPerTick = Math.max(maxReadsPerTick, readsSinceTick)
    readsSinceTick = 0
    if (!stop) setImmediate(spin)
  }
  const perTab = new Map<string, number>()
  transportHarness({
    deps: {
      eventStore: {
        insert: async () => 'inserted',
        readPage: async (tab, after, before, budget) => {
          readsSinceTick++
          const page = pageOfRows(rows, after, before, budget)
          perTab.set(tab, (perTab.get(tab) ?? 0) + page.events.length)
          return page
        },
        tailStart: async (_tab, count) =>
          rows.length >= count ? rows[rows.length - count].seq : null
      },
      // No checkpoint yet: every projection rebuilds, fed by the hydrate's own pass.
      timelineStore: () => memoryTimelineStore()
    }
  })
  setImmediate(spin)
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => mgr.hydrateSession({ ...TAB_OPTS, tabId: `tab-${i}` }))
    )
  } finally {
    stop = true
  }
  // Eight tabs at once, yet between two turns of the loop about one page was read.
  expect(maxReadsPerTick).toBeLessThanOrEqual(2)
  // One pass per tab: the ring's tail, then the history once (scan + projection rebuild).
  for (let i = 0; i < 8; i++) {
    expect(perTab.get(`tab-${i}`)).toBeLessThanOrEqual(rows.length + 2_000)
    const opened = await mgr.openTimeline(`tab-${i}`, TIMELINE_PROJECTION_VERSION)
    expect(opened.kind).toBe('paged')
  }
})

test('openTimeline answers the events saved while its snapshot waited within a page budget, consistent with the live part', async () => {
  // The snapshot waits for every queued projection step; what is saved meanwhile
  // followed it UNPAGED (the whole ring of up to 2,000 events, MB-sized rows).
  const store = memoryTimelineStore()
  let gate: Promise<void> | null = null
  let release: () => void = () => undefined
  let saves = 0
  const save = store.save
  store.save = async (w) => {
    saves++
    if (gate) await gate
    return save(w)
  }
  const h = transportHarness({ deps: { timelineStore: () => store } })
  await startTab()
  const f = h.fakes[0]
  emitLine(f, sj.init('sid-open'))
  await until(() => h.rows.length > 0)
  // The projection's next write waits: every step queued behind it waits too.
  gate = new Promise<void>((r) => {
    release = r
  })
  const before = saves
  await until(() => saves > before, 5_000)
  const opening = mgr.openTimeline(TAB_OPTS.tabId, TIMELINE_PROJECTION_VERSION)
  await wait(20)
  const rowsBefore = h.rows.length
  const big = 'x'.repeat(1024 * 1024)
  for (let i = 0; i < 6; i++) emitLine(f, sj.text(`${i}:${big}`, { id: `msg_big_${i}` }))
  await until(() => h.rows.length >= rowsBefore + 6)
  release()
  gate = null
  const opened = await opening
  expect(opened.kind).toBe('paged')
  if (opened.kind !== 'paged') return
  const bytes = opened.events.reduce((n, e) => n + jsonByteLength(e.event), 0)
  expect(bytes).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_MAX_BYTES)
  // The snapshot plus its events reach exactly the live part's start.
  expect(opened.events.at(-1)?.seq ?? opened.snapshot.seq).toBe(opened.live.afterSeq)
})

test('opening a timeline waits for accepted delayed commits before snapshot and bounded tail', async () => {
  const rows: BufferedEvent[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let writing = false
  const h = transportHarness({
    deps: {
      timelineStore: () => memoryTimelineStore(),
      eventStore: {
        ...mgr.memoryChatEventReads(() => rows),
        insert: async (_tab, seq, event, at) => {
          if (event.kind === 'assistant-text') {
            writing = true
            await gate
          }
          rows.push({ seq, event, at })
          return 'inserted'
        }
      }
    }
  })
  await startTab()
  emitLine(h.fakes[0], sj.text('delayed-text'))
  await until(() => writing)
  let finished = false
  const opening = mgr.openTimeline(TAB_OPTS.tabId, TIMELINE_PROJECTION_VERSION).then((value) => {
    finished = true
    return value
  })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).toBe(false)
  } finally {
    release()
  }
  const opened = await opening
  expect(opened.kind).toBe('paged')
  if (opened.kind !== 'paged') return
  expect(JSON.stringify(opened)).toContain('delayed-text')
  expect(
    opened.events.reduce((bytes, e) => bytes + jsonByteLength(e.event), 0)
  ).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_MAX_BYTES)
  expect(opened.events.at(-1)?.seq ?? opened.snapshot.seq).toBe(opened.live.afterSeq)
})

test('cold hydrate resumes the outbox and unfinished-turn scan after its checkpoint', async () => {
  const saved = history(CACHED_EVENTS_PER_TAB + 200)
  saved.push({
    seq: saved.length,
    event: { kind: 'user-message', id: 'pending-before-restart', text: 'Still here' }
  })
  const store = memoryTimelineStore()
  const projection = await TimelineProjection.open({
    store,
    history: saved,
    agentStartedTurns: true
  })
  await projection.close()

  saved.push({
    seq: saved.length,
    event: { kind: 'tool-call', id: 'late-main-tool', name: 'Bash', input: {} }
  })
  const diagnostic = vi.fn()
  const reads: number[] = []
  const h = transportHarness({
    deps: {
      timelineStore: () => store,
      diagnostic,
      eventStore: {
        insert: async () => 'inserted',
        readPage: async (_tab, after, before, budget) => {
          reads.push(after)
          return pageOfRows(saved, after, before, budget)
        },
        tailStart: async (_tab, count) =>
          saved.length >= count ? saved[saved.length - count].seq : null
      }
    }
  })
  await mgr.hydrateSession({ ...TAB_OPTS })
  await until(() => h.savedKinds().includes('interrupted'))
  expect(h.saved()).toContainEqual(
    expect.objectContaining({
      kind: 'user-message-delivery',
      id: 'pending-before-restart',
      state: 'failed'
    })
  )
  expect(reads).not.toContain(-1)
  expect(diagnostic).toHaveBeenCalledWith(
    TAB_OPTS.tabId,
    expect.objectContaining({
      event: 'chat.open_hydrate',
      payload: expect.objectContaining({ scannedEvents: 1, restored: true })
    })
  )
})

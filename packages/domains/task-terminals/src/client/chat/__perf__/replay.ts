/**
 * Phase 0: headless replay of captured Claude Code stream-json fixtures
 * through the chat-timeline reducer. Used for perf baseline + regression gate.
 *
 * Fixtures live at packages/domains/terminal/test/fixtures/claude-stream/*.ndjson
 * (raw provider JSON). Each line goes through a Claude session driver — the
 * adapter's parse plus what the per-process driver resolves (task frames →
 * sub-agents / command tasks) — exactly the events the app receives. We feed
 * those into the reducer one event at a time, the same path useChatSession takes.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { claudeChatBackend } from '@slayzone/terminal/agents'
import { reducer, initialState, type ChatTimelineState } from '@slayzone/terminal/reducer'
import { decodeTimelineState } from '@slayzone/terminal/timeline-checkpoint'
import {
  TimelineProjection,
  type TimelineProjectionStore
} from '@slayzone/terminal/timeline-projection'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { buildLongSession, LONG_SESSION_EVENTS } from '@slayzone/test-utils/chat-long-session'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const FIXTURES_DIR = join(__dirname, '../../../../../terminal/test/fixtures/claude-stream')

export function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
}

export function loadFixture(name: string): AgentEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  const events: AgentEvent[] = []
  const driver = claudeChatBackend.createDriver()
  void driver.start({
    write: () => undefined,
    emit: (event) => events.push(event),
    cwd: '/tmp',
    sessionId: 'perf',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: null,
    chatCollaboration: null,
    chatFastMode: false
  })
  for (const line of raw.split('\n')) if (line.trim()) driver.handleLine(line)
  driver.dispose()
  return events
}

export interface ReplayMetrics {
  fixture: string
  events: number
  iterations: number
  finalTimelineLength: number
  totalReducerMs: number
  longestReducerMs: number
  meanReducerMs: number
  p99ReducerMs: number
}

export interface ReplayOpts {
  /** Repeat the fixture this many times, accumulating samples. Smooths sub-ms noise. */
  iterations?: number
  /** Throw away the slowest M% of samples before computing summary stats. */
  trimSlowestPct?: number
}

const DEFAULT_OPTS: Required<ReplayOpts> = {
  iterations: 200,
  trimSlowestPct: 0
}

export function replayFixture(name: string, opts: ReplayOpts = {}): ReplayMetrics {
  return replayEvents(name, loadFixture(name), opts)
}

/** Name of the generated 10,000-event session in metrics and the baseline. */
export const LONG_SESSION_FIXTURE = `long-session-${LONG_SESSION_EVENTS / 1000}k (generated)`

/**
 * The plan's 4.1 budget session: 10,000 events of a long Claude Code
 * conversation (`@slayzone/test-utils/chat-long-session`, fixed seed) — what a
 * tab replays when it opens such a session.
 */
export function longSessionEvents(): AgentEvent[] {
  return buildLongSession({ events: LONG_SESSION_EVENTS, seed: 1 })
}

/**
 * Time to reduce `events` as ONE batch from an empty state — the shape of
 * opening a saved session (`useChatSession` replays history in one render).
 * Best of `runs`, after a warmup.
 */
export function hydrateBatchMs(
  events: AgentEvent[],
  runs = 5,
  provider: 'claude' | 'codex' = 'claude'
): number {
  // As the app runs each provider's chat tab (only Claude Code starts turns by itself).
  const fresh = () => initialState({ agentStartedTurns: provider === 'claude' })
  reducer(fresh(), { type: 'events', events })
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    reducer(fresh(), { type: 'events', events })
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

/** A generated session of `events` events of `provider` (fixed seed), for the scale budget. */
export function scaleSessionEvents(
  events: number,
  provider: 'claude' | 'codex',
  askEveryTool = false
): AgentEvent[] {
  return buildLongSession({ events, seed: 1, provider, askEveryTool })
}

export function replayEvents(
  name: string,
  events: AgentEvent[],
  opts: ReplayOpts = {}
): ReplayMetrics {
  const { iterations, trimSlowestPct } = { ...DEFAULT_OPTS, ...opts }
  const samples: number[] = []
  let finalTimelineLength = 0

  const tStart = performance.now()
  for (let iter = 0; iter < iterations; iter++) {
    // As the app runs a Claude Code chat tab (its provider starts turns by itself).
    let state: ChatTimelineState = initialState({ agentStartedTurns: true })
    for (const event of events) {
      const t0 = performance.now()
      state = reducer(state, { type: 'event', event })
      samples.push(performance.now() - t0)
    }
    finalTimelineLength = state.timeline.length
  }
  const totalReducerMs = performance.now() - tStart

  samples.sort((a, b) => a - b)
  const trimmed =
    trimSlowestPct > 0
      ? samples.slice(0, Math.floor(samples.length * (1 - trimSlowestPct)))
      : samples
  const longestReducerMs = trimmed[trimmed.length - 1] ?? 0
  const meanReducerMs = trimmed.length ? trimmed.reduce((s, x) => s + x, 0) / trimmed.length : 0
  const p99ReducerMs = trimmed.length
    ? (trimmed[Math.floor(trimmed.length * 0.99)] ?? longestReducerMs)
    : 0

  return {
    fixture: name,
    events: events.length,
    iterations,
    finalTimelineLength,
    totalReducerMs,
    longestReducerMs,
    meanReducerMs,
    p99ReducerMs
  }
}

export function replayAll(opts: ReplayOpts = {}): ReplayMetrics[] {
  return listFixtures().map((f) => replayFixture(f, opts))
}

/**
 * Run replayAll multiple times and keep the **fastest** run per fixture.
 * Min-of-N is the right summary for perf benchmarks: it represents what the
 * code can do in steady state, and it's not pulled around by GC pauses or
 * background OS noise the way mean is.
 */
export function replayAllBestOf(runs: number, opts: ReplayOpts = {}): ReplayMetrics[] {
  // Warmup pass — JIT + caches.
  replayAll(opts)
  let best: ReplayMetrics[] | null = null
  for (let i = 0; i < runs; i++) {
    const current = replayAll(opts)
    if (!best) {
      best = current
      continue
    }
    for (let j = 0; j < current.length; j++) {
      const c = current[j]
      const b = best[j]
      if (!b || c.totalReducerMs < b.totalReducerMs) best[j] = c
    }
  }
  return best ?? []
}

/** An in-memory projection store (what the hub keeps in SQLite). */
function memoryTimelineStore(): TimelineProjectionStore {
  const pages = new Map<number, { rows: string; summary: string; searchText: string }>()
  let checkpoint: { version: string; seq: number; data: string } | null = null
  return {
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
      if (write.dropPagesFrom !== null) {
        for (const page of [...pages.keys()]) if (page >= write.dropPagesFrom) pages.delete(page)
      }
      for (const p of write.pages) pages.set(p.page, p)
      checkpoint = write.checkpoint
    },
    searchPages: async (needle) =>
      [...pages.entries()].filter(([, p]) => p.searchText.includes(needle)).map(([page]) => page),
    discard: async () => {
      pages.clear()
      checkpoint = null
    }
  }
}

export interface PagedOpenMetrics {
  /** Hub: no stored projection — every event folded, every page written. */
  rebuildMs: number
  /** Hub: a tab loading again from its stored checkpoint. */
  reopenMs: number
  /** Hub: the snapshot a client opens from (state as of now, page summaries). */
  snapshotMs: number
  /** Client: decoding and restoring that snapshot (what it holds: the tail). */
  clientOpenMs: number
  /** Rows the client holds after opening. */
  clientRows: number
  /** Most sealed pages the hub held at once while rebuilding. */
  hubPeakPages: number
}

/**
 * Opening a saved session paged (chat F), hub and client side. Best of `runs`
 * for each step (store in memory: SQLite time is not the reducer's).
 */
export async function pagedOpen(
  events: AgentEvent[],
  provider: 'claude' | 'codex',
  runs = 3
): Promise<PagedOpenMetrics> {
  const history = events.map((event, seq) => ({ seq, event, at: 1_000 + seq }))
  const agentStartedTurns = provider === 'claude'
  const best: PagedOpenMetrics = {
    rebuildMs: Infinity,
    reopenMs: Infinity,
    snapshotMs: Infinity,
    clientOpenMs: Infinity,
    clientRows: 0,
    hubPeakPages: 0
  }
  for (let i = 0; i < runs; i++) {
    const store = memoryTimelineStore()
    let t0 = performance.now()
    const built = await TimelineProjection.open({ store, history, agentStartedTurns })
    best.rebuildMs = Math.min(best.rebuildMs, performance.now() - t0)
    best.hubPeakPages = Math.max(best.hubPeakPages, built.peakResidentPages)
    await built.close()
    t0 = performance.now()
    const p = await TimelineProjection.open({ store, history, agentStartedTurns })
    best.reopenMs = Math.min(best.reopenMs, performance.now() - t0)
    t0 = performance.now()
    const snapshot = await p.openSnapshot()
    best.snapshotMs = Math.min(best.snapshotMs, performance.now() - t0)
    t0 = performance.now()
    const state = reducer(initialState({ agentStartedTurns }), {
      type: 'restore',
      state: decodeTimelineState(snapshot.state)
    })
    best.clientOpenMs = Math.min(best.clientOpenMs, performance.now() - t0)
    best.clientRows = state.timeline.filter((r) => r !== undefined).length
  }
  return best
}

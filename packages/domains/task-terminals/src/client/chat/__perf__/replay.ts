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
import type { AgentEvent } from '@slayzone/terminal-contracts'

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
  const { iterations, trimSlowestPct } = { ...DEFAULT_OPTS, ...opts }
  const events = loadFixture(name)
  const samples: number[] = []
  let finalTimelineLength = 0

  const tStart = performance.now()
  for (let iter = 0; iter < iterations; iter++) {
    let state: ChatTimelineState = initialState()
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

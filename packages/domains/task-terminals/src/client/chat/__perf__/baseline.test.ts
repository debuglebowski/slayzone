/**
 * Phase 0 perf baseline test.
 *
 * Run via:   pnpm test:chat:perf
 * Update via: pnpm test:chat:perf -- --update
 *
 * Reads __perf__/baseline.json. For each fixture:
 *   - Replays through the reducer.
 *   - Compares longest + p99 + total reducer ms against committed baseline.
 *   - Fails if any metric regresses by more than REGRESSION_BUDGET (default 25%).
 *
 * Plus the long-session budget (plan 4.1): a generated 10,000-event session
 * replayed event by event and as one hydrate batch, against the ABSOLUTE limits
 * in budget.json (`longSession`). Its relative entry is in baseline.json too.
 * (budget.json's `render` limits are checked in real Chromium by
 * e2e/perf/chat-long-session.spec.ts.)
 *
 * On `--update`, writes the current run to baseline.json (and the conditions it
 * was measured under to baseline.meta.json) instead of comparing. Only on a
 * quiet machine: under load every number is inflated.
 *
 * Phase 6 will wire this into CI with a stricter budget (15%).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LONG_SESSION_FIXTURE,
  hydrateBatchMs,
  longSessionEvents,
  replayAllBestOf,
  replayEvents,
  type ReplayMetrics
} from './replay'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BASELINE_PATH = join(__dirname, 'baseline.json')
const BASELINE_META_PATH = join(__dirname, 'baseline.meta.json')
const BUDGET_PATH = join(__dirname, 'budget.json')

interface LongSessionBudget {
  events: number
  /** Replaying every event one dispatch at a time (the live path), total. */
  replayTotalMs: number
  /** Opening the saved session: all events reduced as one batch. */
  hydrateBatchMs: number
  /** The slowest single event of the replay (trimmed 1%). */
  longestEventMs: number
}
const REGRESSION_BUDGET = 0.25
/** Skip regression checks for metrics measured below this absolute threshold — sub-ms noise dominates. */
const MIN_ABS_MS = 0.5

interface BaselineEntry {
  fixture: string
  events: number
  iterations: number
  finalTimelineLength: number
  longestReducerMs: number
  p99ReducerMs: number
  meanReducerMs: number
  totalReducerMs: number
}

function toEntry(m: ReplayMetrics): BaselineEntry {
  return {
    fixture: m.fixture,
    events: m.events,
    iterations: m.iterations,
    finalTimelineLength: m.finalTimelineLength,
    longestReducerMs: round(m.longestReducerMs),
    p99ReducerMs: round(m.p99ReducerMs),
    meanReducerMs: round(m.meanReducerMs),
    totalReducerMs: round(m.totalReducerMs)
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function loadBaseline(): BaselineEntry[] | null {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as BaselineEntry[]
}

function writeBaseline(entries: BaselineEntry[]): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + '\n', 'utf8')
}

function main(): void {
  const update = process.argv.includes('--update')
  // 1000 iterations × best-of-5 runs after a warmup. Min-of-N + warmup gives
  // tight, repeatable totals while still representing real reducer cost.
  const metrics = replayAllBestOf(5, { iterations: 1000, trimSlowestPct: 0.01 })
  // The long session: 10,000 events per pass, so a few passes, best of 5.
  const longEvents = longSessionEvents()
  let long: ReplayMetrics | null = null
  replayEvents(LONG_SESSION_FIXTURE, longEvents, { iterations: 1 })
  for (let i = 0; i < 5; i++) {
    const m = replayEvents(LONG_SESSION_FIXTURE, longEvents, {
      iterations: 3,
      trimSlowestPct: 0.01
    })
    if (!long || m.totalReducerMs < long.totalReducerMs) long = m
  }
  const longPass: ReplayMetrics = {
    ...long!,
    totalReducerMs: long!.totalReducerMs / long!.iterations
  }
  const batchMs = hydrateBatchMs(longEvents)
  metrics.push(longPass)
  const current = metrics.map(toEntry)

  console.log('\n  Replay metrics (1000 iterations × best-of-5, trimmed 1%):')
  for (const m of metrics) {
    console.log(
      `  ${m.fixture.padEnd(22)} events=${String(m.events).padStart(4)}  ` +
        `tl=${String(m.finalTimelineLength).padStart(3)}  ` +
        `total=${m.totalReducerMs.toFixed(2)}ms  ` +
        `longest=${m.longestReducerMs.toFixed(4)}ms  ` +
        `p99=${m.p99ReducerMs.toFixed(4)}ms  ` +
        `mean=${m.meanReducerMs.toFixed(4)}ms`
    )
  }

  const budget = (
    JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as { longSession: LongSessionBudget }
  ).longSession
  console.log(
    `\n  Long session (${longPass.events} events, timeline ${longPass.finalTimelineLength} rows):` +
      `\n    replay ${longPass.totalReducerMs.toFixed(1)}ms (budget ${budget.replayTotalMs}ms)` +
      `  hydrate batch ${batchMs.toFixed(1)}ms (budget ${budget.hydrateBatchMs}ms)` +
      `  longest event ${longPass.longestReducerMs.toFixed(2)}ms (budget ${budget.longestEventMs}ms)` +
      `\n    load average ${loadavg()
        .map((n) => n.toFixed(1))
        .join(' ')} on ${cpus().length} cpus`
  )
  let overBudget = 0
  if (longPass.events !== budget.events) {
    console.error(`  ✗ long session has ${longPass.events} events, budget is for ${budget.events}`)
    overBudget++
  }
  for (const [label, value, limit] of [
    ['replay', longPass.totalReducerMs, budget.replayTotalMs],
    ['hydrate batch', batchMs, budget.hydrateBatchMs],
    ['longest event', longPass.longestReducerMs, budget.longestEventMs]
  ] as const) {
    if (value > limit) {
      console.error(`  ✗ long session ${label}: ${value.toFixed(2)}ms > ${limit}ms`)
      overBudget++
    }
  }

  if (update) {
    writeBaseline(current)
    writeFileSync(
      BASELINE_META_PATH,
      JSON.stringify(
        {
          date: new Date().toISOString(),
          loadAverage: loadavg().map((n) => Math.round(n * 100) / 100),
          cpus: cpus().length,
          cpuModel: cpus()[0]?.model ?? null,
          node: process.version
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    console.log(`\n  ✓ Wrote baseline to ${BASELINE_PATH} (conditions: ${BASELINE_META_PATH})`)
    if (overBudget > 0) process.exit(1)
    return
  }

  const baseline = loadBaseline()
  if (!baseline) {
    writeBaseline(current)
    console.log(`\n  ✓ No baseline found — initialized at ${BASELINE_PATH}`)
    return
  }

  let failed = 0
  console.log('\n  Compared to baseline:')
  for (const cur of current) {
    const base = baseline.find((b) => b.fixture === cur.fixture)
    if (!base) {
      console.log(`  + ${cur.fixture} (new — no baseline entry)`)
      continue
    }
    const checks: Array<{ key: keyof BaselineEntry; label: string }> = [
      { key: 'totalReducerMs', label: 'total' },
      { key: 'meanReducerMs', label: 'mean' },
      { key: 'p99ReducerMs', label: 'p99' }
    ]
    for (const { key, label } of checks) {
      const baseVal = base[key] as number
      const curVal = cur[key] as number
      if (baseVal === 0) continue
      const delta = (curVal - baseVal) / baseVal
      const skipped = baseVal < MIN_ABS_MS && curVal < MIN_ABS_MS
      const flag = skipped ? '·' : delta > REGRESSION_BUDGET ? '✗' : '✓'
      if (!skipped && delta > REGRESSION_BUDGET) failed++
      console.log(
        `  ${flag} ${cur.fixture.padEnd(22)} ${label.padEnd(8)} ` +
          `${baseVal.toFixed(4)}ms → ${curVal.toFixed(4)}ms ` +
          `(${(delta * 100).toFixed(1)}%)${skipped ? ' [sub-threshold]' : ''}`
      )
    }
    if (cur.finalTimelineLength !== base.finalTimelineLength) {
      console.log(
        `  ! ${cur.fixture.padEnd(22)} timeline length changed: ${base.finalTimelineLength} → ${cur.finalTimelineLength}`
      )
    }
  }

  if (failed > 0 || overBudget > 0) {
    if (failed > 0) {
      console.error(`\n  ✗ ${failed} metric(s) regressed beyond ${REGRESSION_BUDGET * 100}% budget`)
    }
    if (overBudget > 0) console.error(`\n  ✗ ${overBudget} long-session budget(s) exceeded`)
    process.exit(1)
  }
  console.log('\n  ✓ All metrics within budget')
}

main()

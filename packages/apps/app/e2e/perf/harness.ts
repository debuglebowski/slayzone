import type { Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type {
  CdpPerfSnapshot,
  IterationResult,
  LongTaskEntry,
  PerfMark,
  PerfMeasure,
  ProfilerCommit,
  ScenarioResult
} from './types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolves to <repo>/working-notes/performance — same convention used by the
 * older 68/69 perf specs so all reports live in one place.
 */
export function defaultResultsDir(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', '..', 'working-notes', 'performance')
}

export interface ScenarioDefinition {
  name: string
  description: string
  iterations?: number
  warmupIterations?: number
  /** Runs once before any iteration. Use to seed data or navigate to a starting state. */
  setup?: (page: Page) => Promise<void>
  /** Runs before EACH iteration to reset to the starting state of the measured action. */
  beforeEach?: (page: Page, iteration: number) => Promise<void>
  /** The measured interaction. Wall time is taken around this function. */
  run: (page: Page, iteration: number) => Promise<void>
  /** Optional teardown after each iteration (does not count toward wall time). */
  afterEach?: (page: Page, iteration: number) => Promise<void>
}

interface CdpMetricsResponse {
  metrics: Array<{ name: string; value: number }>
}

function extractCdpMetric(metrics: CdpMetricsResponse, name: string): number {
  return metrics.metrics.find((m) => m.name === name)?.value ?? 0
}

function snapshotFromMetrics(metrics: CdpMetricsResponse): CdpPerfSnapshot {
  return {
    jsHeapUsedMB: Math.round(extractCdpMetric(metrics, 'JSHeapUsedSize') / 1048576),
    domNodes: extractCdpMetric(metrics, 'Nodes'),
    jsEventListeners: extractCdpMetric(metrics, 'JSEventListeners'),
    layoutCount: extractCdpMetric(metrics, 'LayoutCount'),
    recalcStyleCount: extractCdpMetric(metrics, 'RecalcStyleCount'),
    layoutDurationMs: Math.round(extractCdpMetric(metrics, 'LayoutDuration') * 1000),
    recalcStyleDurationMs: Math.round(extractCdpMetric(metrics, 'RecalcStyleDuration') * 1000),
    scriptDurationMs: Math.round(extractCdpMetric(metrics, 'ScriptDuration') * 1000),
    taskDurationMs: Math.round(extractCdpMetric(metrics, 'TaskDuration') * 1000)
  }
}

/**
 * Installs page-side instrumentation:
 *   - longtask PerformanceObserver buffer
 *   - IPC invoke wrapper that records per-channel call counts and durations
 *
 * Idempotent — calling it twice is a no-op. We tag a sentinel on window.
 */
async function installInstrumentation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __slayzone_perf_installed__?: boolean
      __slayzone_perf_longTasks__?: Array<{ startTime: number; duration: number }>
      __slayzone_perf_ipc__?: Map<string, { count: number; totalMs: number; maxMs: number }>
      electron?: {
        ipcRenderer?: { invoke?: (channel: string, ...args: unknown[]) => Promise<unknown> }
      }
    }
    if (w.__slayzone_perf_installed__) return
    w.__slayzone_perf_installed__ = true

    const longTasks: Array<{ startTime: number; duration: number }> = []
    w.__slayzone_perf_longTasks__ = longTasks
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ startTime: entry.startTime, duration: entry.duration })
          if (longTasks.length > 5000) longTasks.shift()
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
    } catch {
      // longtask not supported in this environment — silently skip
    }

    const ipcStats = new Map<string, { count: number; totalMs: number; maxMs: number }>()
    w.__slayzone_perf_ipc__ = ipcStats

    function record(channel: string, elapsedMs: number) {
      const existing = ipcStats.get(channel) ?? { count: 0, totalMs: 0, maxMs: 0 }
      existing.count += 1
      existing.totalMs += elapsedMs
      if (elapsedMs > existing.maxMs) existing.maxMs = elapsedMs
      ipcStats.set(channel, existing)
    }

    // Wrap legacy window.electron.ipcRenderer.invoke if present
    const legacyOriginal = w.electron?.ipcRenderer?.invoke
    if (legacyOriginal && w.electron?.ipcRenderer) {
      w.electron.ipcRenderer.invoke = async function wrapped(channel: string, ...args: unknown[]) {
        const start = performance.now()
        try {
          return await legacyOriginal.call(this, channel, ...args)
        } finally {
          record(`electron.ipcRenderer.invoke:${channel}`, performance.now() - start)
        }
      }
    }

    // Recursively wrap contextBridge-exposed functions so preload calls
    // namespaces (db, settings, theme, tags, …) get measured per call.
    const api = (window as unknown as { api?: Record<string, unknown> }).api
    if (api && typeof api === 'object') {
      const visited = new WeakSet<object>()
      const wrap = (obj: Record<string, unknown>, prefix: string) => {
        if (visited.has(obj)) return
        visited.add(obj)
        for (const key of Object.keys(obj)) {
          const value = obj[key]
          if (typeof value === 'function') {
            const channel = `${prefix}${key}`
            const original = value as (...args: unknown[]) => unknown
            obj[key] = function wrapped(...args: unknown[]) {
              const start = performance.now()
              const finish = () => record(channel, performance.now() - start)
              try {
                const result = original.apply(this, args)
                if (result && typeof (result as Promise<unknown>).then === 'function') {
                  return (result as Promise<unknown>).finally(finish)
                }
                finish()
                return result
              } catch (err) {
                finish()
                throw err
              }
            }
          } else if (value && typeof value === 'object') {
            wrap(value as Record<string, unknown>, `${prefix}${key}.`)
          }
        }
      }
      try {
        wrap(api, 'api.')
      } catch {
        // contextBridge objects are sometimes frozen — silently skip if so
      }
    }
  })
}

interface IterationCollectorState {
  startMark: string
  endMark: string
  marksBefore: number
}

async function beginIteration(
  page: Page,
  name: string,
  index: number
): Promise<IterationCollectorState> {
  const startMark = `sz:perf:${name}:${index}:start`
  const endMark = `sz:perf:${name}:${index}:end`
  const marksBefore = await page.evaluate(() => performance.getEntriesByType('mark').length)
  await page.evaluate((s) => {
    performance.mark(s)
    const w = window as unknown as {
      __slayzone_perf_longTasks__?: unknown[]
      __slayzone_perf_ipc__?: Map<string, unknown>
      __slayzone_profiler__?: { enabled: boolean; reset?: () => void }
    }
    w.__slayzone_perf_longTasks__ = []
    w.__slayzone_perf_ipc__ = new Map()
    if (w.__slayzone_profiler__) {
      w.__slayzone_profiler__.reset?.()
      w.__slayzone_profiler__.enabled = true
    }
  }, startMark)
  return { startMark, endMark, marksBefore }
}

async function endIteration(
  page: Page,
  state: IterationCollectorState
): Promise<{
  marks: PerfMark[]
  measures: PerfMeasure[]
  longTasks: LongTaskEntry[]
  profilerCommits: ProfilerCommit[]
  ipc: {
    perChannel: Array<{ channel: string; count: number; totalMs: number; maxMs: number }>
    total: { count: number; totalMs: number }
  }
}> {
  await page.evaluate((endMark) => {
    performance.mark(endMark)
  }, state.endMark)

  return await page.evaluate(
    ({ startMark, endMark, marksBefore }) => {
      const allMarks = performance.getEntriesByType('mark') as PerformanceMark[]
      const newMarks = allMarks.slice(marksBefore)
      const startEntry = newMarks.find((m) => m.name === startMark)
      const endEntry = newMarks.find((m) => m.name === endMark)
      const startTime = startEntry?.startTime ?? 0
      const endTime = endEntry?.startTime ?? Number.POSITIVE_INFINITY

      const marks = newMarks
        .filter((m) => m.startTime >= startTime && m.startTime <= endTime)
        .map((m) => ({ name: m.name, startTime: Math.round(m.startTime - startTime) }))

      const measures = (performance.getEntriesByType('measure') as PerformanceMeasure[])
        .filter((m) => m.startTime >= startTime && m.startTime <= endTime)
        .map((m) => ({
          name: m.name,
          startTime: Math.round(m.startTime - startTime),
          duration: Math.round(m.duration)
        }))

      const w = window as unknown as {
        __slayzone_perf_longTasks__?: Array<{ startTime: number; duration: number }>
        __slayzone_perf_ipc__?: Map<string, { count: number; totalMs: number; maxMs: number }>
        __slayzone_profiler__?: {
          commits: Array<{
            id: string
            phase: string
            actualDuration: number
            baseDuration: number
            startTime: number
            commitTime: number
          }>
          reset?: () => void
        }
      }

      const longTasks = (w.__slayzone_perf_longTasks__ ?? [])
        .filter((lt) => lt.startTime >= startTime && lt.startTime <= endTime)
        .map((lt) => ({
          startTime: Math.round(lt.startTime - startTime),
          duration: Math.round(lt.duration)
        }))

      const profilerCommits = (w.__slayzone_profiler__?.commits ?? [])
        .filter((c) => c.commitTime >= startTime && c.commitTime <= endTime)
        .map((c) => ({
          id: c.id,
          phase: c.phase as 'mount' | 'update' | 'nested-update',
          actualDuration: Math.round(c.actualDuration * 100) / 100,
          baseDuration: Math.round(c.baseDuration * 100) / 100,
          startTime: Math.round(c.startTime - startTime),
          commitTime: Math.round(c.commitTime - startTime)
        }))

      const perChannel: Array<{ channel: string; count: number; totalMs: number; maxMs: number }> =
        []
      let totalCount = 0
      let totalMs = 0
      for (const [channel, stats] of w.__slayzone_perf_ipc__ ?? new Map()) {
        perChannel.push({
          channel,
          count: stats.count,
          totalMs: Math.round(stats.totalMs),
          maxMs: Math.round(stats.maxMs)
        })
        totalCount += stats.count
        totalMs += stats.totalMs
      }
      perChannel.sort((a, b) => b.totalMs - a.totalMs)

      // Disable buffer until next iteration enables it again
      if (w.__slayzone_profiler__) w.__slayzone_profiler__.enabled = false

      return {
        marks,
        measures,
        longTasks,
        profilerCommits,
        ipc: { perChannel, total: { count: totalCount, totalMs: Math.round(totalMs) } }
      }
    },
    { startMark: state.startMark, endMark: state.endMark, marksBefore: state.marksBefore }
  )
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function summarize(runs: IterationResult[]): ScenarioResult['summary'] {
  const wall = runs.map((r) => r.wallMs)
  const longTask = runs.map((r) => r.longTaskTotalMs)
  const profilerActual = runs.map((r) =>
    r.profilerCommits.reduce((sum, c) => sum + c.actualDuration, 0)
  )
  const ipcCount = runs.map((r) => r.ipcTotal.count)
  return {
    wallP50: percentile(wall, 50),
    wallP95: percentile(wall, 95),
    wallMax: Math.max(0, ...wall),
    longTaskP95: percentile(longTask, 95),
    profilerActualP95: percentile(profilerActual, 95),
    ipcCountP50: percentile(ipcCount, 50)
  }
}

/**
 * The single reusable primitive. Wraps a user flow and captures all key
 * performance signals. Use one call per scenario; results dump to disk in
 * <resultsDir>/<runId>/<scenario>.json plus per-iteration .cpuprofile files.
 */
export async function profileScenario(
  page: Page,
  definition: ScenarioDefinition,
  options: { runDir: string; collectCpuProfile?: boolean } = { runDir: '' }
): Promise<ScenarioResult> {
  const iterations = definition.iterations ?? 5
  const warmup = definition.warmupIterations ?? 1
  const collectCpuProfile = options.collectCpuProfile ?? true
  const runDir = options.runDir || path.join(defaultResultsDir(), `run-${Date.now()}`)
  fs.mkdirSync(runDir, { recursive: true })

  await installInstrumentation(page)
  if (definition.setup) await definition.setup(page)

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  if (collectCpuProfile) await cdp.send('Profiler.enable')

  const runs: IterationResult[] = []
  const startedAt = new Date().toISOString()
  const totalStart = Date.now()

  for (let i = 0; i < iterations + warmup; i++) {
    const isWarmup = i < warmup
    const realIndex = i - warmup
    if (definition.beforeEach) await definition.beforeEach(page, isWarmup ? -1 : realIndex)

    const cdpBeforeMetrics = (await cdp.send('Performance.getMetrics')) as CdpMetricsResponse
    const heapBeforeMB = Math.round(extractCdpMetric(cdpBeforeMetrics, 'JSHeapUsedSize') / 1048576)
    const cdpBefore = snapshotFromMetrics(cdpBeforeMetrics)

    const collector = await beginIteration(page, definition.name, isWarmup ? -1 : realIndex)
    if (collectCpuProfile && !isWarmup) await cdp.send('Profiler.start')

    const wallStart = Date.now()
    await definition.run(page, isWarmup ? -1 : realIndex)
    const wallMs = Date.now() - wallStart

    let cpuProfilePath: string | null = null
    if (collectCpuProfile && !isWarmup) {
      const { profile } = await cdp.send('Profiler.stop')
      cpuProfilePath = path.join(runDir, `${definition.name}-iter${realIndex}.cpuprofile`)
      fs.writeFileSync(cpuProfilePath, JSON.stringify(profile))
    }

    const collected = await endIteration(page, collector)

    const cdpAfterMetrics = (await cdp.send('Performance.getMetrics')) as CdpMetricsResponse
    const heapAfterMB = Math.round(extractCdpMetric(cdpAfterMetrics, 'JSHeapUsedSize') / 1048576)
    const cdpAfter = snapshotFromMetrics(cdpAfterMetrics)

    if (definition.afterEach) await definition.afterEach(page, isWarmup ? -1 : realIndex)

    if (isWarmup) continue

    runs.push({
      index: realIndex,
      wallMs,
      marks: collected.marks,
      measures: collected.measures,
      longTasks: collected.longTasks,
      longTaskTotalMs: collected.longTasks.reduce((sum, lt) => sum + lt.duration, 0),
      profilerCommits: collected.profilerCommits,
      ipcCalls: collected.ipc.perChannel,
      ipcTotal: collected.ipc.total,
      heapBeforeMB,
      heapAfterMB,
      cdpBefore,
      cdpAfter,
      cpuProfilePath: cpuProfilePath ? path.relative(runDir, cpuProfilePath) : null
    })
  }

  if (collectCpuProfile) await cdp.send('Profiler.disable')
  await cdp.send('Performance.disable')

  const result: ScenarioResult = {
    name: definition.name,
    description: definition.description,
    iterations,
    warmupDropped: warmup,
    startedAt,
    durationMs: Date.now() - totalStart,
    runs,
    summary: summarize(runs)
  }

  fs.writeFileSync(path.join(runDir, `${definition.name}.json`), JSON.stringify(result, null, 2))
  return result
}

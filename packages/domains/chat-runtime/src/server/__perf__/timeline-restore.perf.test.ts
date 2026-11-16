/**
 * Measurement (not a pass/fail gate): how long the computer's event loop is blocked
 * while many chats open their timeline projections at once over the REAL computer
 * store — a boot restore. On 2026-11-14 restoring ~60 chat agents gave 1–11 s stalls
 * in `saveTimeline` / `flushNow` / `putRecord` (crash-fix follow-up FU4, item 6).
 *
 * Scenarios, each with every tab at once:
 *  - rebuild: no stored projection (a version bump, a reset) → every page written;
 *  - restore: the stored projection is opened again (checkpoint + page summaries);
 *  - reset: the backfill's timeline reset of every chat, one after another
 *    (`dropTimelineInSteps`; before FU4: one `DELETE` per chat, no loop turn between).
 *
 * Reported, load-independent first: the most main-thread CPU spent in ONE event-loop
 * iteration (`process.threadCpuUsage` between two turns of a setImmediate probe) —
 * what the computer's heartbeats wait for on an idle machine. Then the production
 * stall detector's freezes ≥ 250 ms (count, longest, its
 * main-thread CPU and innermost frames — on a saturated machine a freeze with little
 * CPU is the OS descheduling the process, not its own work), the longest gap between
 * two event-loop turns (a setImmediate probe), the p99 / max of
 * `monitorEventLoopDelay`, and wall time. Machine-dependent: run by hand
 *   SLZ_PERF_TABS=60 SLZ_PERF_EVENTS=2000 npx vitest run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/domains/chat-runtime/src/server/__perf__/timeline-restore.perf.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, expect, test } from 'vitest'
import {
  startEventLoopStallDetector,
  type EventLoopStall
} from '@slayzone/platform/event-loop-stall'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  TimelineProjection,
  type TimelineHistorySource
} from '@slayzone/terminal/timeline-projection'
import { historyReadTurns } from '@slayzone/terminal/history-turns'
import { openChatStorage, type ChatStorage } from '../storage'
import { createLocalChatData } from '../local-data'
import { dropTimelineInSteps } from '../timeline-drop'

const TABS = Number(process.env.SLZ_PERF_TABS ?? 60)
const EVENTS = Number(process.env.SLZ_PERF_EVENTS ?? 2000)
const PAGE_EVENTS = 400

const root = mkdtempSync(join(tmpdir(), 'slz-timeline-perf-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Row sizes shaped like the dev store's text tool output: mostly small, a few huge. */
function sizeOf(i: number): number {
  const r = (i * 2654435761) % 1000
  if (r < 900) return 1024
  if (r < 990) return 20 * 1024
  return 400 * 1024
}

function seed(store: ChatStorage): string[] {
  const tabs: string[] = []
  for (let t = 0; t < TABS; t++) {
    const id = `perf-${t}`
    const identity = { id, taskId: `task-${t}`, tabId: `tab-${t}`, mode: 'claude-chat', epoch: 1 }
    store.createConversation(identity)
    store.transaction(() => {
      for (let seq = 0; seq < EVENTS; seq++) {
        const event: AgentEvent =
          seq % 50 === 0
            ? ({ kind: 'user-message', id: `m-${t}-${seq}`, text: `prompt ${seq}` } as AgentEvent)
            : ({ kind: 'stderr', text: `${seq}:${'x'.repeat(sizeOf(seq + t))}` } as AgentEvent)
        store.appendAt(id, 1, seq, event, 1_000 + seq)
      }
    })
    tabs.push(identity.tabId)
  }
  return tabs
}

/** The tab's saved events a page at a time, each read in its turn (as a hydrate: `ChatEventLog.pages`). */
function historyOf(store: ChatStorage, tabId: string): TimelineHistorySource {
  const id = store.forTab(tabId)!.identity.id
  return {
    lastSeq: EVENTS - 1,
    async *pages(afterSeq) {
      for (let after = afterSeq; ; ) {
        const from = after
        const page = await historyReadTurns.take(async () =>
          store.readPage(id, from, Number.MAX_SAFE_INTEGER, {
            maxBytes: 4 * 1024 * 1024,
            maxEvents: PAGE_EVENTS
          })
        )
        if (page.events.length === 0) return
        yield page.events
        after = page.events[page.events.length - 1].seq
        if (!page.more) return
        await new Promise<void>((r) => setImmediate(r))
      }
    }
  }
}

/** Per loop iteration (probe turn): units of history work run and their CPU (diagnostics). */
let iteration = 0
const unitsByIteration = new Map<number, Array<{ kind: string; cpuMs: number }>>()
for (const kind of ['take'] as const) {
  const original = historyReadTurns[kind].bind(historyReadTurns) as (
    work: () => unknown
  ) => Promise<unknown>
  ;(historyReadTurns as unknown as Record<string, unknown>)[kind] = (work: () => unknown) =>
    original(async () => {
      const before = process.threadCpuUsage()
      try {
        return await work()
      } finally {
        const after = process.threadCpuUsage()
        const list = unitsByIteration.get(iteration) ?? []
        list.push({
          kind,
          cpuMs: (after.user + after.system - before.user - before.system) / 1000
        })
        unitsByIteration.set(iteration, list)
      }
    })
}

async function measure(label: string, work: () => Promise<void>): Promise<void> {
  unitsByIteration.clear()
  let worstIteration = -1
  const stalls: EventLoopStall[] = []
  const detector = startEventLoopStallDetector({ thresholdMs: 250, onStall: (x) => stalls.push(x) })
  const delay = monitorEventLoopDelay({ resolution: 10 })
  let maxGap = 0,
    last = performance.now(),
    lastCpu = process.threadCpuUsage(),
    maxCpu = 0,
    stop = false
  const probe = () => {
    const now = performance.now()
    const cpu = process.threadCpuUsage()
    maxGap = Math.max(maxGap, now - last)
    const spent = (cpu.user + cpu.system - lastCpu.user - lastCpu.system) / 1000
    if (spent > maxCpu) worstIteration = iteration
    maxCpu = Math.max(maxCpu, spent)
    iteration++
    last = now
    lastCpu = cpu
    if (!stop) setImmediate(probe)
  }
  delay.enable()
  setImmediate(probe)
  // Settle first (the seeding's garbage, the detector's thread starting): measured is the work.
  await new Promise((r) => setTimeout(r, 1000))
  maxCpu = 0
  maxGap = 0
  stalls.length = 0
  unitsByIteration.clear()
  const start = performance.now()
  const startEpoch = Date.now()
  await work()
  const wall = performance.now() - start
  // One more turn: a block that ends with the work is measured too.
  await new Promise<void>((r) => setImmediate(r))
  stop = true
  delay.disable()
  // A freeze is reported once the thread runs again, after a short grace.
  await new Promise((r) => setTimeout(r, 600))
  detector.stop()
  // Freezes that began before the measured work (the settling) are not its.
  const own = stalls.filter((x) => x.startedAt >= startEpoch)
  stalls.length = 0
  stalls.push(...own)
  const worst = [...stalls].sort((a, b) => b.durationMs - a.durationMs)[0]
  const busy = stalls.filter((x) => (x.mainThreadCpuMs ?? 0) >= 250)
  console.log(
    `[timeline-perf] ${label}: stalls>=250ms=${stalls.length} (cpu>=250ms: ${busy.length}, ` +
      `longest busy=${Math.max(0, ...busy.map((x) => x.durationMs))}ms) ` +
      `longest=${worst?.durationMs ?? 0}ms cpu=${worst?.mainThreadCpuMs ?? 0}ms ` +
      `top=${JSON.stringify(worst?.stacks[0]?.frames.slice(0, 4) ?? [])}`
  )
  if (process.env.SLZ_PERF_DETAIL) {
    const units = unitsByIteration.get(worstIteration) ?? []
    console.log(
      `[timeline-perf] ${label} worst iteration #${worstIteration}: ${units.length} units ` +
        `${JSON.stringify(units.map((u) => `${u.kind}:${u.cpuMs.toFixed(0)}`).slice(0, 20))}; ` +
        `max units in one iteration=${Math.max(0, ...[...unitsByIteration.values()].map((u) => u.length))}`
    )
  }
  if (process.env.SLZ_PERF_DETAIL && worst)
    console.log(
      `[timeline-perf] ${label} longest detail: at=+${worst.startedAt - startEpoch}ms of ${wall.toFixed(0)}ms gc=${worst.gcMs}ms processCpu=${worst.processCpuMs}ms ` +
        JSON.stringify(worst.stacks.map((x) => x.frames.slice(0, 8)))
    )
  console.log(
    `[timeline-perf] ${label}: tabs=${TABS} events/tab=${EVENTS} maxIterationCpu=${maxCpu.toFixed(0)}ms maxBlock=${maxGap.toFixed(0)}ms ` +
      `p99=${(delay.percentile(99) / 1e6).toFixed(0)}ms max=${(delay.max / 1e6).toFixed(0)}ms ` +
      `wall=${(wall / 1000).toFixed(1)}s`
  )
}

test('timeline projections of many chats: rebuild, restore, reset', async () => {
  const store = openChatStorage({ stateDir: root, hubScope: 'perf' })
  const { data } = createLocalChatData(store)
  const tabs = seed(store)
  const projectionStore = (tabId: string) => ({
    loadCheckpoint: () => data.loadTimelineCheckpoint(tabId),
    loadPages: (pages: readonly number[]) => data.loadTimelinePages(tabId, [...pages]),
    loadSummaries: () => data.loadTimelineSummaries(tabId),
    save: (write: Parameters<typeof data.saveTimeline>[1]) => {
      saves++
      return data.saveTimeline(tabId, write)
    },
    searchPages: (needle: string) => data.searchTimelinePages(tabId, needle),
    discard: () => data.clearTimeline(tabId)
  })
  const openAll = () =>
    Promise.all(
      tabs.map((tabId) =>
        TimelineProjection.open({
          store: projectionStore(tabId),
          history: historyOf(store, tabId),
          agentStartedTurns: false
        })
      )
    )

  let projections: TimelineProjection[] = []
  let saves = 0
  await measure('rebuild', async () => {
    projections = await openAll()
  })
  await Promise.all(projections.map((p) => p.close()))
  expect(projections.every((p) => p.usable)).toBe(true)
  console.log(`[timeline-perf] rebuild: ${saves} store writes`)
  saves = 0

  await measure('restore', async () => {
    projections = await openAll()
  })
  await Promise.all(projections.map((p) => p.close()))
  // A restore writes nothing: its checkpoint covers every event.
  console.log(`[timeline-perf] restore: ${saves} store writes`)
  expect(saves).toBe(0)

  await measure('reset', async () => {
    for (const tabId of tabs) {
      const owner = store.forTab(tabId)!.identity
      // SLZ_PERF_RESET=whole: as before FU4 (one DELETE per chat, no loop turn between).
      if (process.env.SLZ_PERF_RESET === 'whole') {
        store.compose((db) =>
          db
            .prepare("DELETE FROM records WHERE conversation_id=? AND kind='timeline'")
            .run(owner.id)
        )
        await Promise.resolve()
      } else await dropTimelineInSteps(store, owner.id, owner.epoch)
    }
  })
  store.close()
}, 1_800_000)

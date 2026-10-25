/**
 * Event-loop stall detector: notices when this process's main thread stops
 * running for at least `thresholdMs`, and reports — once it runs again — what
 * it was doing.
 *
 * A server whose main thread freezes looks dead to everything talking to it:
 * heartbeats go unanswered, connections drop, timers fire late all at once. On
 * 2026-10-23 a ~20s hub freeze did exactly that, and nothing recorded WHY — the
 * diagnostics simply went silent for 20s. This makes the next freeze name its
 * cause.
 *
 * ── The evidence, and how to read it ────────────────────────────────────────
 * A frozen thread cannot report on itself, so a WATCHER THREAD (a worker) sees
 * the main thread's heartbeat stop and, while it is still frozen, collects:
 *
 *   - `stacks`   — the main thread's JavaScript stack, sampled through the
 *                  inspector. Names the culprit when JS is running (a busy loop,
 *                  or a loop of short blocking calls — the stack is taken between
 *                  calls). Cannot be taken INSIDE a single long native call: the
 *                  sample then lands just after it returns, often in event-loop
 *                  internals.
 *   - `children` — this process's child processes. A thread blocked in
 *                  `spawnSync` / `execFileSync` is waiting on one of them, so a
 *                  long-lived `git …` or `zsh -l -c …` here names exactly what a
 *                  single long blocking call is waiting for.
 *
 * And the main thread, on thawing, adds what it costs:
 *
 *   - `mainThreadCpuMs` a large share of `durationMs` → the thread was BUSY (JS
 *     or GC; see `gcMs`). Below 100% when the machine is saturated: the OS
 *     deschedules even a spinning thread (see `machineCpuBusyPct`).
 *   - `mainThreadCpuMs` near zero → it was WAITING: a blocking call (see
 *     `children`), or almost never scheduled on a saturated machine.
 *
 * Cost while healthy: one 100ms timer on the main thread and one on the watcher.
 * The inspector is only touched during a stall.
 *
 * @module platform/event-loop-stall
 */

import { cpus } from 'node:os'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'

export interface EventLoopStall {
  /** Epoch ms of the last on-time heartbeat — when the freeze began, within one tick. */
  startedAt: number
  /** How long the main thread produced no heartbeat. */
  durationMs: number
  /** CPU time the MAIN thread used over the freeze; `null` where Node cannot measure it. */
  mainThreadCpuMs: number | null
  /** CPU time of the whole process (every thread) over the freeze. */
  processCpuMs: number
  /** Garbage-collection pause time overlapping the freeze. */
  gcMs: number
  /** How busy the whole machine's CPUs were over the freeze, 0–100; `null` if unknown. */
  machineCpuBusyPct: number | null
  /** Main-thread JS stacks sampled during the freeze, innermost frame first. */
  stacks: Array<{ atMs: number; frames: string[] }>
  /** This process's child processes, snapshotted during the freeze. */
  children: Array<{
    atMs: number
    processes: Array<{ pid: number; elapsed: string; command: string }>
  }>
}

export interface EventLoopStallDetectorOptions {
  /** Report a freeze this long or longer. Default 1000. */
  thresholdMs?: number
  /** Called once per freeze, after the thread runs again. Must not throw (it is guarded). */
  onStall: (stall: EventLoopStall) => void
}

export interface EventLoopStallDetector {
  stop(): void
}

const TICK_MS = 100
/** How long to wait after thawing for the watcher's samples to arrive. */
const REPORT_GRACE_MS = 300
const SAMPLE_EVERY_MS = 1_000
const MAX_SAMPLES_PER_STALL = 5
const MAX_FRAMES = 20
/** Watcher messages older than this cannot belong to a freeze still being reported. */
const MESSAGE_TTL_MS = 120_000
const GC_ENTRY_TTL_MS = 300_000

type WatcherMessage =
  | { kind: 'stack'; at: number; frames: string[] }
  | {
      kind: 'children'
      at: number
      processes: Array<{ pid: number; elapsed: string; command: string }>
    }

/**
 * The watcher thread, as source: an `eval` worker needs no file of its own, so a
 * bundled consumer (the hub ships as one `bin.cjs`) carries it with no extra
 * asset to resolve at runtime.
 */
const WATCHER_SOURCE = `
'use strict'
const { parentPort, workerData } = require('node:worker_threads')
const { execFile } = require('node:child_process')
const { beat, thresholdMs, tickMs, sampleEveryMs, maxSamples, maxFrames, parentPid } = workerData

let session = null
try {
  const inspector = require('node:inspector')
  session = new inspector.Session()
  session.connectToMainThread()
} catch {
  session = null // no inspector in this runtime: children snapshots still work
}

let pausePending = false
let psPending = false
if (session) {
  session.on('Debugger.paused', (message) => {
    const frames = message.params.callFrames.slice(0, maxFrames).map((f) => {
      const file = (f.url || '').split('/').pop() || '?'
      return (f.functionName || '(anonymous)') + ' (' + file + ':' + (f.location.lineNumber + 1) + ':' + (f.location.columnNumber + 1) + ')'
    })
    try { session.post('Debugger.resume') } catch {}
    try { session.post('Debugger.disable') } catch {}
    pausePending = false
    parentPort.postMessage({ kind: 'stack', at: Date.now(), frames })
  })
}

function snapshotChildren() {
  if (process.platform === 'win32' || psPending) return
  psPending = true
  const ps = execFile('ps', ['-A', '-o', 'pid=,ppid=,etime=,command='], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    psPending = false
    if (err) return
    const processes = []
    for (const line of String(stdout).split('\\n')) {
      const m = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/)
      if (!m || Number(m[2]) !== parentPid) continue
      const pid = Number(m[1])
      if (pid === ps.pid) continue // this snapshot's own ps
      processes.push({ pid, elapsed: m[3], command: m[4].slice(0, 300) })
    }
    parentPort.postMessage({ kind: 'children', at: Date.now(), processes })
  })
}

let stallBeat = -1
let taken = 0
let lastSampleAt = 0
setInterval(() => {
  const lastBeat = Number(Atomics.load(beat, 0))
  if (Date.now() - lastBeat < thresholdMs) return
  if (lastBeat !== stallBeat) {
    stallBeat = lastBeat
    taken = 0
    lastSampleAt = 0
  }
  if (taken >= maxSamples || Date.now() - lastSampleAt < sampleEveryMs) return
  taken++
  lastSampleAt = Date.now()
  snapshotChildren()
  if (session && !pausePending) {
    pausePending = true
    try {
      // Queued for the main thread: it is handled the moment JS runs there again
      // (between blocking calls, or inside a busy loop).
      session.post('Debugger.enable')
      session.post('Debugger.pause')
    } catch {
      pausePending = false
    }
  }
}, tickMs)
`

interface Tick {
  perf: number
  wall: number
  threadCpuUs: number | null
  processCpuUs: number
  machine: { idle: number; total: number } | null
}

const threadCpuUsage = (
  process as unknown as { threadCpuUsage?: () => { user: number; system: number } }
).threadCpuUsage

function readMachineCpu(): { idle: number; total: number } | null {
  try {
    let idle = 0
    let total = 0
    for (const cpu of cpus()) {
      const t = cpu.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.irq + t.idle
    }
    return total > 0 ? { idle, total } : null
  } catch {
    return null
  }
}

function readTick(): Tick {
  const proc = process.cpuUsage()
  const thread = threadCpuUsage?.call(process)
  return {
    perf: performance.now(),
    wall: Date.now(),
    threadCpuUs: thread ? thread.user + thread.system : null,
    processCpuUs: proc.user + proc.system,
    machine: readMachineCpu()
  }
}

export function startEventLoopStallDetector(
  options: EventLoopStallDetectorOptions
): EventLoopStallDetector {
  const thresholdMs = options.thresholdMs ?? 1_000
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8))
  Atomics.store(heartbeat, 0, BigInt(Date.now()))

  // ── Watcher thread: optional evidence, never a reason to fail ──
  const messages: WatcherMessage[] = []
  let watcher: Worker | null = null
  try {
    watcher = new Worker(WATCHER_SOURCE, {
      eval: true,
      workerData: {
        beat: heartbeat,
        thresholdMs,
        tickMs: TICK_MS,
        sampleEveryMs: SAMPLE_EVERY_MS,
        maxSamples: MAX_SAMPLES_PER_STALL,
        maxFrames: MAX_FRAMES,
        parentPid: process.pid
      }
    })
    watcher.on('message', (m: WatcherMessage) => {
      messages.push(m)
      const cutoff = Date.now() - MESSAGE_TTL_MS
      while (messages.length > 0 && messages[0]!.at < cutoff) messages.shift()
    })
    // A broken watcher costs only the samples; the duration/CPU report stands.
    watcher.on('error', () => undefined)
    watcher.unref()
  } catch {
    watcher = null
  }

  // ── GC pauses, so a busy freeze can be told apart from a collection ──
  const gcEntries: Array<{ start: number; duration: number }> = []
  let gcObserver: PerformanceObserver | null = null
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        gcEntries.push({ start: e.startTime, duration: e.duration })
      const cutoff = performance.now() - GC_ENTRY_TTL_MS
      while (gcEntries.length > 0 && gcEntries[0]!.start < cutoff) gcEntries.shift()
    })
    gcObserver.observe({ entryTypes: ['gc'] })
  } catch {
    gcObserver = null
  }

  const reportTimers = new Set<ReturnType<typeof setTimeout>>()
  let last = readTick()

  const report = (from: Tick, to: Tick): void => {
    const durationMs = Math.round(to.perf - from.perf)
    const gcMs = gcEntries
      .filter((e) => e.start + e.duration > from.perf && e.start < to.perf)
      .reduce((sum, e) => sum + e.duration, 0)
    let machineCpuBusyPct: number | null = null
    if (from.machine && to.machine) {
      const total = to.machine.total - from.machine.total
      const idle = to.machine.idle - from.machine.idle
      if (total > 0) machineCpuBusyPct = Math.round((1 - idle / total) * 100)
    }
    // Only evidence taken WHILE frozen: a sample after `to.wall` is the watcher
    // catching up with a thread that was already running again.
    const during = messages.filter((m) => m.at >= from.wall && m.at <= to.wall)
    const stall: EventLoopStall = {
      startedAt: from.wall,
      durationMs,
      mainThreadCpuMs:
        from.threadCpuUs !== null && to.threadCpuUs !== null
          ? Math.round((to.threadCpuUs - from.threadCpuUs) / 1000)
          : null,
      processCpuMs: Math.round((to.processCpuUs - from.processCpuUs) / 1000),
      gcMs: Math.round(gcMs),
      machineCpuBusyPct,
      stacks: during.flatMap((m) =>
        m.kind === 'stack' ? [{ atMs: m.at - from.wall, frames: m.frames }] : []
      ),
      children: during.flatMap((m) =>
        m.kind === 'children' ? [{ atMs: m.at - from.wall, processes: m.processes }] : []
      )
    }
    try {
      options.onStall(stall)
    } catch {
      // A reporting failure must never take the process down with it.
    }
  }

  const tick = setInterval(() => {
    const now = readTick()
    Atomics.store(heartbeat, 0, BigInt(now.wall))
    const from = last
    last = now
    if (now.perf - from.perf - TICK_MS < thresholdMs) return
    // Thawed. The watcher's samples are already queued behind this timer; give
    // them one short window to land, then report.
    const timer = setTimeout(() => {
      reportTimers.delete(timer)
      report(from, now)
    }, REPORT_GRACE_MS)
    timer.unref?.()
    reportTimers.add(timer)
  }, TICK_MS)
  tick.unref?.()

  return {
    stop: () => {
      clearInterval(tick)
      for (const t of reportTimers) clearTimeout(t)
      reportTimers.clear()
      gcObserver?.disconnect()
      if (watcher) void watcher.terminate()
    }
  }
}

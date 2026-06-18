import { app, webContents, type WebContents } from 'electron'

/**
 * Proactive renderer GC.
 *
 * Root cause (measured 2026-06-18): under continuous load the renderer never goes
 * idle, so Blink's Oilpan collector falls behind and uncollected garbage accumulates
 * to GBs — a forced GC on a grown renderer reclaimed ~1.5GB of `blink_gc`. Across many
 * busy renderers that is the multi-GB OOM. This nudges a full GC on any renderer whose
 * RSS crosses a threshold, reclaiming the garbage WITHOUT changing any functionality.
 *
 * Mechanism: CDP `HeapProfiler.collectGarbage` over `webContents.debugger` — the exact
 * call that reclaimed the memory in testing. It triggers a unified V8 + Blink/Oilpan GC
 * and needs no `--expose-gc` flag. The debugger is attached only for the call and
 * detached immediately, so it never holds the channel away from DevTools.
 */

const THRESHOLD_MB = Number(process.env.SLAYZONE_GC_THRESHOLD_MB ?? 1100)
const INTERVAL_MS = Number(process.env.SLAYZONE_GC_INTERVAL_MS ?? 30_000)
const COOLDOWN_MS = Number(process.env.SLAYZONE_GC_COOLDOWN_MS ?? 20_000)

let timer: ReturnType<typeof setInterval> | null = null
const lastGcAt = new Map<number, number>() // webContents.id -> last GC timestamp

async function collectGarbageIn(wc: WebContents): Promise<void> {
  // Skip if something else (DevTools, Playwright) already owns the debugger.
  if (wc.debugger.isAttached()) return
  let attached = false
  try {
    wc.debugger.attach('1.3')
    attached = true
    await wc.debugger.sendCommand('HeapProfiler.collectGarbage')
  } catch {
    /* DevTools opened mid-cycle / frame gone — skip, retry next tick */
  } finally {
    if (attached) {
      try {
        wc.debugger.detach()
      } catch {
        /* ignore */
      }
    }
  }
}

function tick(): void {
  let metrics: Electron.ProcessMetric[]
  try {
    metrics = app.getAppMetrics()
  } catch {
    return
  }
  const rssKbByPid = new Map<number, number>()
  for (const m of metrics) rssKbByPid.set(m.pid, m.memory.workingSetSize)

  const now = Date.now()
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || wc.isCrashed()) continue
    let pid: number
    try {
      pid = wc.getOSProcessId()
    } catch {
      continue
    }
    const rssKb = rssKbByPid.get(pid)
    if (!rssKb || rssKb / 1024 < THRESHOLD_MB) continue
    if (now - (lastGcAt.get(wc.id) ?? 0) < COOLDOWN_MS) continue
    lastGcAt.set(wc.id, now)
    console.log(
      `[proactive-gc] nudging GC on wc ${wc.id} (pid ${pid}, ~${Math.round(rssKb / 1024)}MB RSS)`
    )
    void collectGarbageIn(wc)
  }
}

/** Start the supervisor. No-op under Playwright (would contend with its CDP session). */
export function startProactiveGc(): void {
  if (timer) return
  if (process.env.PLAYWRIGHT) return
  timer = setInterval(tick, INTERVAL_MS)
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref()
  console.log(
    `[proactive-gc] started (threshold ${THRESHOLD_MB}MB, every ${INTERVAL_MS}ms, cooldown ${COOLDOWN_MS}ms)`
  )
}

export function stopProactiveGc(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  lastGcAt.clear()
}

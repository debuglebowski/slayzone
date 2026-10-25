/**
 * Pre-init leg of the terminal mount trace. `terminal.mount_timeline` starts its
 * clock when init begins, so it cannot see the time between the user's open
 * action and that point (tab switch, task view render, Terminal mount, effect
 * scheduling). A caller that opens a session traces the request here; the
 * Terminal notes its mount; the mount timeline takes both legs at init start.
 * Times are `performance.now()` — one renderer, one clock.
 */

/** A trace older than this is not the open that mounted this terminal. */
const OPEN_TRACE_TTL_MS = 60_000

interface OpenTrace {
  openAt: number
  mountAt: number | null
}

const traces = new Map<string, OpenTrace>()

/** Record that the user asked to open `sessionId` now. */
export function traceSessionOpen(sessionId: string, at: number = performance.now()): void {
  traces.set(sessionId, { openAt: at, mountAt: null })
}

/** The Terminal for `sessionId` committed its mount. First mount wins. */
export function noteTerminalMounted(sessionId: string, at: number = performance.now()): void {
  const trace = traces.get(sessionId)
  if (trace && trace.mountAt === null) trace.mountAt = at
}

export interface OpenTraceLegs {
  /** Open requested → init started. */
  openToInitMs: number
  /** Open requested → Terminal mounted. Null when the mount was not noted. */
  openToMountMs: number | null
  /** Terminal mounted → init started. Null when the mount was not noted. */
  mountToInitMs: number | null
}

/** Consume the trace for `sessionId` at init start; null when none is live. */
export function takeOpenTrace(
  sessionId: string,
  initAt: number = performance.now()
): OpenTraceLegs | null {
  const trace = traces.get(sessionId)
  if (!trace) return null
  traces.delete(sessionId)
  if (initAt - trace.openAt > OPEN_TRACE_TTL_MS) return null
  const { openAt, mountAt } = trace
  return {
    openToInitMs: Math.round(initAt - openAt),
    openToMountMs: mountAt === null ? null : Math.round(mountAt - openAt),
    mountToInitMs: mountAt === null ? null : Math.round(initAt - mountAt)
  }
}

/** Test seam. */
export function __resetOpenTraceForTest(): void {
  traces.clear()
}

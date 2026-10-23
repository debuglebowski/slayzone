/**
 * Drop a window's warm-pool tab counts once that window is gone.
 *
 * Each renderer window reports its open-task-tab counts over its `/trpc` socket
 * (`pty.warmSetProjectTabCounts`, keyed by the socket's `?windowId=`), and the warm
 * pool keeps a pre-booted agent for every project with a count. A window that closes
 * never sends an empty report, so the hub has to notice it went: when the window's
 * last socket closes and none reopens within {@link DEFAULT_GRACE_MS}, its counts are
 * cleared and the pool tears down agents nobody can use any more.
 *
 * The grace covers a reload or a dropped-and-restored connection: the window comes
 * back under the same id and its counts are still right, so clearing them would
 * leave the pool cold until the next tab change.
 *
 * This replaces an Electron-host listener that cleared a copy of the pool that was
 * never initialised in that process — the pool runs here, in the hub.
 *
 * @module hub/warm-window-sockets
 */

export const DEFAULT_GRACE_MS = 10_000

/** The part of a `ws` WebSocket this needs. */
export interface WindowSocket {
  once(event: 'close', listener: () => void): unknown
}

export interface WarmWindowSocketTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface WarmWindowSockets {
  /** Count `socket` as open for `windowId` until it closes. */
  track(windowId: number, socket: WindowSocket): void
}

export function createWarmWindowSockets(opts: {
  clearWindow: (windowId: number) => void
  graceMs?: number
  timers?: WarmWindowSocketTimers
}): WarmWindowSockets {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS
  const timers: WarmWindowSocketTimers = opts.timers ?? {
    setTimeout: (fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    },
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
  }
  const open = new Map<number, number>()
  const pendingClear = new Map<number, unknown>()

  return {
    track(windowId, socket) {
      const pending = pendingClear.get(windowId)
      if (pending !== undefined) {
        timers.clearTimeout(pending)
        pendingClear.delete(windowId)
      }
      open.set(windowId, (open.get(windowId) ?? 0) + 1)
      socket.once('close', () => {
        const left = (open.get(windowId) ?? 1) - 1
        if (left > 0) {
          open.set(windowId, left)
          return
        }
        open.delete(windowId)
        pendingClear.set(
          windowId,
          timers.setTimeout(() => {
            pendingClear.delete(windowId)
            opts.clearWindow(windowId)
          }, graceMs)
        )
      })
    }
  }
}

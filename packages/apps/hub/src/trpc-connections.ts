/**
 * Open `/trpc` connections, by the account they signed in as (T-12).
 *
 * WHY. A `/trpc` socket resolves its principal ONCE, when it opens
 * (`resolveConnectionPrincipal` in createContext), and keeps it for its whole life. So
 * revoking a session — disabling the account, an Entra refusal — stops every NEW
 * request, but an open socket would go on with the account and role it opened with.
 * This registry is how the hub reaches those sockets:
 *   - {@link TrpcConnectionRegistry.closeUser}: disabling or a refusal closes the
 *     account's sockets at once; a role change closes them so they reconnect with the
 *     new role;
 *   - every {@link REVALIDATE_INTERVAL_MS} each socket's credential is resolved again,
 *     and a socket whose session has ended for any other reason (expired, signed out,
 *     revoked by hand) is closed — so a socket never outlives its session by more than
 *     that.
 * A closed client reconnects as it does after any drop and is then unauthenticated.
 *
 * Only authenticated sockets are tracked: on a hub with login off (the desktop app's)
 * no principal is ever resolved, so nothing is tracked and no timer exists. The timer
 * starts with the first tracked socket and stops with the last.
 *
 * @module hub/trpc-connections
 */

/** Close code for a socket whose session ended (4000-4999 is the application range). */
export const SESSION_ENDED_CLOSE_CODE = 4401

/** How often each open socket's credential is resolved again. */
export const REVALIDATE_INTERVAL_MS = 15 * 60 * 1000

/** The part of a `ws` WebSocket this needs. */
export interface TrackedSocket {
  readonly readyState: number
  close(code?: number, reason?: string): void
  once(event: 'close', listener: () => void): unknown
}

/** The timer functions the sweep uses; swapped by tests. */
export interface ConnectionTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

const realTimers: ConnectionTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
}

export interface TrpcConnectionRegistry {
  /**
   * Track a socket that authenticated as `userId`. `revalidate` resolves the socket's
   * credential again: the user id it still stands for, or null when it no longer does.
   */
  track(socket: TrackedSocket, userId: string, revalidate: () => Promise<string | null>): void
  /** Close every open socket of `userId`. Returns how many were closed. */
  closeUser(userId: string, reason: string): number
  /** Resolve every socket's credential now; close those that no longer resolve to the
   *  same account (or whose check threw). Returns how many were closed. */
  revalidateAll(): Promise<number>
  /** Open tracked sockets, of one user or all. */
  count(userId?: string): number
  /** Clear the timer and forget every socket (closes none). */
  stop(): void
}

const CLOSING = 2

export function createTrpcConnectionRegistry(
  opts: { timers?: ConnectionTimers; intervalMs?: number } = {}
): TrpcConnectionRegistry {
  const timers = opts.timers ?? realTimers
  const intervalMs = opts.intervalMs ?? REVALIDATE_INTERVAL_MS
  const sockets = new Map<
    TrackedSocket,
    { userId: string; revalidate: () => Promise<string | null> }
  >()
  let timer: unknown = null
  let sweeping = false

  const close = (socket: TrackedSocket, reason: string): void => {
    sockets.delete(socket)
    try {
      socket.close(SESSION_ENDED_CLOSE_CODE, reason.slice(0, 120))
    } catch {
      // Already gone.
    }
    if (sockets.size === 0) stopTimer()
  }

  const stopTimer = (): void => {
    if (timer === null) return
    timers.clearInterval(timer)
    timer = null
  }

  const revalidateAll = async (): Promise<number> => {
    if (sweeping) return 0
    sweeping = true
    let closed = 0
    try {
      for (const [socket, entry] of [...sockets]) {
        if (!sockets.has(socket)) continue
        let still: string | null
        try {
          still = await entry.revalidate()
        } catch {
          still = null // fail closed: the client reconnects and is checked afresh
        }
        if (still !== entry.userId && sockets.has(socket)) {
          close(socket, 'session ended')
          closed++
        }
      }
    } finally {
      sweeping = false
    }
    return closed
  }

  return {
    track(socket, userId, revalidate) {
      if (socket.readyState >= CLOSING) return
      sockets.set(socket, { userId, revalidate })
      socket.once('close', () => {
        sockets.delete(socket)
        if (sockets.size === 0) stopTimer()
      })
      if (timer === null) {
        timer = timers.setInterval(() => void revalidateAll(), intervalMs)
        // Never what keeps the hub alive.
        ;(timer as { unref?: () => void } | null)?.unref?.()
      }
    },
    closeUser(userId, reason) {
      let closed = 0
      for (const [socket, entry] of [...sockets]) {
        if (entry.userId !== userId) continue
        close(socket, reason)
        closed++
      }
      return closed
    },
    revalidateAll,
    count(userId) {
      if (userId === undefined) return sockets.size
      let n = 0
      for (const entry of sockets.values()) if (entry.userId === userId) n++
      return n
    },
    stop() {
      stopTimer()
      sockets.clear()
    }
  }
}

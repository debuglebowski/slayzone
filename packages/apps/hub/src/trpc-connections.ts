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
 *   - IdP-role mode ({@link TrpcConnectionRegistry.setDeadline}): each socket ALSO has a
 *     timer at its account's persisted evidence deadline (signed `iat` + interval). When
 *     it fires the deadline is read again, synchronously: if the evidence was re-proven
 *     meanwhile (the hub's sweep refreshes accounts minutes ahead) the timer re-arms for
 *     the new deadline; otherwise the socket is closed AT ONCE — no await, so no
 *     operation or subscription output runs past the deadline while a refresh is
 *     pending. The client reconnects, and the gate re-proves (or refuses) the account
 *     on the new socket. So no socket outlives its account's role evidence.
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
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  now?: () => number
}

const realTimers: Required<ConnectionTimers> = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now()
}

/** Longest single timer (setTimeout's 32-bit limit); a later deadline re-arms. */
const MAX_TIMER_MS = 2_147_483_647

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
  /**
   * IdP-role mode: the account's evidence deadline (Unix ms; null = none). From then on
   * every tracked socket — and every one tracked later — closes at that deadline unless
   * its credential, resolved again, re-proved the account.
   */
  setDeadline(deadlineMs: (userId: string) => number | null): void
  /** Clear the timer and forget every socket (closes none). */
  stop(): void
}

const CLOSING = 2

export function createTrpcConnectionRegistry(
  opts: { timers?: ConnectionTimers; intervalMs?: number } = {}
): TrpcConnectionRegistry {
  const timers = { ...realTimers, ...(opts.timers ?? {}) }
  const intervalMs = opts.intervalMs ?? REVALIDATE_INTERVAL_MS
  const sockets = new Map<
    TrackedSocket,
    { userId: string; revalidate: () => Promise<string | null>; deadlineTimer?: unknown }
  >()
  let timer: unknown = null
  let sweeping = false
  let deadlineOf: ((userId: string) => number | null) | null = null

  const clearDeadline = (socket: TrackedSocket): void => {
    const entry = sockets.get(socket)
    if (entry?.deadlineTimer !== undefined) {
      timers.clearTimeout(entry.deadlineTimer)
      entry.deadlineTimer = undefined
    }
  }

  /** Arm the socket's deadline timer from its account's current deadline. */
  const armDeadline = (socket: TrackedSocket): void => {
    const entry = sockets.get(socket)
    if (!entry || !deadlineOf) return
    clearDeadline(socket)
    let deadline: number | null
    try {
      deadline = deadlineOf(entry.userId)
    } catch {
      deadline = 0 // unknown: check now, fail closed
    }
    if (deadline === null) return
    const wait = Math.max(0, Math.min(deadline - timers.now(), MAX_TIMER_MS))
    const handle = timers.setTimeout(() => onDeadline(socket), wait)
    ;(handle as { unref?: () => void } | null)?.unref?.()
    entry.deadlineTimer = handle
  }

  /** Synchronous on purpose: nothing is awaited between the deadline and the close. */
  const onDeadline = (socket: TrackedSocket): void => {
    const entry = sockets.get(socket)
    if (!entry) return
    entry.deadlineTimer = undefined
    let next: number | null = 0
    try {
      next = deadlineOf?.(entry.userId) ?? null
    } catch {
      next = 0 // unreadable: fail closed
    }
    // Re-proven already (a later persisted deadline), or a long deadline re-armed in
    // steps: keep and re-arm. Anything else: close now.
    if (next !== null && next > timers.now()) armDeadline(socket)
    else close(socket, 'role evidence expired')
  }

  const close = (socket: TrackedSocket, reason: string): void => {
    clearDeadline(socket)
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
        clearDeadline(socket)
        sockets.delete(socket)
        if (sockets.size === 0) stopTimer()
      })
      armDeadline(socket)
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
    setDeadline(fn) {
      deadlineOf = fn
      for (const socket of sockets.keys()) armDeadline(socket)
    },
    stop() {
      stopTimer()
      for (const socket of sockets.keys()) clearDeadline(socket)
      sockets.clear()
    }
  }
}

import { isLoopbackAuthority } from '@slayzone/platform/hub-addr'
import type { HubConnectProbe } from './connectPacing'
import type { ConnectTrace } from './connectTrace'

/**
 * Bound every connect attempt to a hub: a socket whose opening handshake does not
 * finish is given up, so the next attempt can run.
 *
 * WHY. @trpc/client has no handshake timeout (`asyncWsOpen` waits for `open` or
 * `error`, nothing else), and every connect path joins the ONE attempt in flight —
 * the reconnect loop awaits it, and every query's `open()` gets the same
 * `openPromise` back. So a single socket that stays CONNECTING parks every operation
 * on that hub until the browser itself gives up on it — Chromium after 240s
 * (`kHandshakeTimeoutIntervalInSeconds`), and Chromium also lets only one socket per
 * host:port be connecting at a time, so nothing could overtake it anyway. The pacer's
 * probe cannot help: it is asked in `url()`, which is not called again while the
 * stuck attempt is pending. Seen after a hub restart: the hub listening again within
 * a second, `/health` answering, and the renderer reporting it unreachable for 75s+
 * ("did not connect within 15000ms (Initialization error)").
 *
 * WHAT THIS DOES, per socket, while it is CONNECTING:
 *  - HEDGE. After a grace period it asks the same reachability probe the pacer uses
 *    (Electron: main's GET /health). The hub answering while our handshake has not
 *    finished means the SOCKET is stuck, not the hub — so it is closed (which fails
 *    it: `error` + `close`), trpc's ordinary failure path runs, and the pacer is told
 *    the hub answered so the retry does not wait for the backoff. A hub that is merely
 *    BUSY cannot trigger this: `/health` runs on the same event loop as the upgrade,
 *    so while one waits the other does too, and the probe says down (or times out).
 *    The grace doubles with every hedge that is not followed by an open: a socket that
 *    is only waiting in Chromium's per-process throttle (≤5s) costs a few extra
 *    connects, never a steady stream of failed ones — those failures are exactly what
 *    that throttle counts (connectPacing.ts).
 *  - HARD DEADLINE. Past it the socket is closed whatever the probe says, and with no
 *    probe installed (Chromium fork, web shell) this is the only bound. The runtime
 *    expedites one serialized replacement without asserting that the hub is healthy.
 *
 * Applied through @trpc/client's public `WebSocket` option: a constructor that makes
 * a real socket of the CURRENT global `WebSocket` and watches it. Nothing about the
 * socket itself changes; an attempt that opens in time is untouched.
 */

/**
 * Hedge grace for a loopback hub. A hub that is serving completes a loopback
 * handshake in tens of milliseconds; one that cannot (event loop blocked) cannot
 * answer the probe either, so a short grace cannot misfire on a slow hub.
 */
export const HANDSHAKE_HEDGE_LOOPBACK_MS = 1_000

/**
 * Hedge grace for any other hub: TLS and network round trips, plus up to the 5s a
 * socket can wait in Chromium's per-process throttle before its handshake starts.
 */
export const HANDSHAKE_HEDGE_REMOTE_MS = 5_000

/**
 * Hard deadline for one attempt. Above the throttle cap plus TLS, so a healthy slow
 * handshake is never cut; below the operation deadline (`HUB_CONNECT_DEADLINE_MS`,
 * 15s) so an operation waiting on a stuck socket still sees a fresh attempt before it
 * is reported unreachable.
 */
export const HANDSHAKE_DEADLINE_MS = 10_000

export type HandshakeAbortReason = 'hedge' | 'deadline'

export interface HandshakeTiming {
  /** First hedge grace (doubles per consecutive hedge). Default: by host. */
  hedgeAfterMs?: number
  /** Hard deadline per attempt. Default {@link HANDSHAKE_DEADLINE_MS}. */
  deadlineMs?: number
}

/** One stuck socket given up — what the app reports to its diagnostics. */
export interface HubConnectAbort {
  url: string
  reason: HandshakeAbortReason
  /** How long the socket had been connecting. */
  waitedMs: number
}

let abortListener: ((abort: HubConnectAbort) => void) | null = null

/**
 * Install (or clear with null) the process-wide listener told about every stuck socket
 * given up, on any hub. The renderer records them as diagnostics events.
 */
export function setHubConnectAbortListener(
  listener: ((abort: HubConnectAbort) => void) | null
): void {
  abortListener = listener
}

export interface HandshakeWatchOpts extends HandshakeTiming {
  wsUrl: string
  /** The probe to ask (read per check, like the pacer). */
  probe: () => HubConnectProbe | null
  /** A stuck socket was closed. `hedge`: the probe had just said the hub is up. */
  onAbort?: (reason: HandshakeAbortReason) => void
  /** Where each socket's outcome is recorded (connectTrace.ts). */
  trace?: ConnectTrace
}

/** Grace before the first hedge for `wsUrl`'s host. */
export function hedgeGraceFor(wsUrl: string): number {
  let host = ''
  try {
    host = new URL(wsUrl).host
  } catch {
    // Unparseable: not loopback (fails closed to the longer grace).
  }
  return host && isLoopbackAuthority(host) ? HANDSHAKE_HEDGE_LOOPBACK_MS : HANDSHAKE_HEDGE_REMOTE_MS
}

const CONNECTING = 0

/**
 * A `WebSocket` constructor for `createWSClient({ WebSocket })` that watches every
 * socket it makes. Undefined when this environment has no global `WebSocket` (the
 * caller then passes nothing, exactly as before).
 */
export function createWatchedWebSocket(opts: HandshakeWatchOpts): typeof WebSocket | undefined {
  if (typeof globalThis.WebSocket === 'undefined') return undefined
  const hedgeBase = opts.hedgeAfterMs ?? hedgeGraceFor(opts.wsUrl)
  const deadlineMs = opts.deadlineMs ?? HANDSHAKE_DEADLINE_MS
  /** Hedges since the last socket that opened: each one doubles the next grace. */
  let consecutiveHedges = 0

  const watch = (ws: WebSocket): void => {
    const createdAt = Date.now()
    const attempt = opts.trace?.socketCreated()
    const grace = Math.min(hedgeBase * 2 ** consecutiveHedges, deadlineMs)
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null
    let probing = false
    let settled = false

    const stop = (): void => {
      settled = true
      if (hedgeTimer) clearTimeout(hedgeTimer)
      clearTimeout(deadlineTimer)
      hedgeTimer = null
    }
    const abort = (reason: HandshakeAbortReason): void => {
      if (settled || ws.readyState !== CONNECTING) return
      stop()
      if (reason === 'hedge') consecutiveHedges++
      if (attempt) opts.trace?.settle(attempt, reason)
      // Told first, so the pacer has its hint before trpc's failure path reads it.
      opts.onAbort?.(reason)
      abortListener?.({ url: opts.wsUrl, reason, waitedMs: Date.now() - createdAt })
      // On a CONNECTING socket this FAILS the connection (`error`, then `close`):
      // trpc's ordinary failure path takes it from here.
      ws.close()
    }
    const check = (): void => {
      hedgeTimer = null
      if (settled || ws.readyState !== CONNECTING) return
      const probe = opts.probe()
      if (!probe || probing) {
        armHedge()
        return
      }
      probing = true
      void probe(opts.wsUrl)
        .catch(() => false)
        .then((up) => {
          probing = false
          if (settled || ws.readyState !== CONNECTING) return
          if (up) abort('hedge')
          else armHedge()
        })
    }
    const armHedge = (): void => {
      if (!settled && !hedgeTimer) hedgeTimer = setTimeout(check, grace)
    }
    const deadlineTimer = setTimeout(() => abort('deadline'), deadlineMs)

    const failed = (): void => {
      if (attempt) opts.trace?.settle(attempt, 'failed')
      stop()
    }
    ws.addEventListener('open', () => {
      consecutiveHedges = 0
      if (attempt) opts.trace?.settle(attempt, 'open')
      stop()
    })
    ws.addEventListener('close', failed)
    ws.addEventListener('error', failed)
    armHedge()
  }

  // A plain constructor function (not a subclass): it returns a real socket of the
  // CURRENT global, so a host or test that swaps `WebSocket` later is honoured.
  function WatchedWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
    const ws = new globalThis.WebSocket(url, protocols)
    watch(ws)
    return ws
  }
  // trpc reads the readyState constants off the constructor (`isOpen()`).
  Object.assign(WatchedWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  return WatchedWebSocket as unknown as typeof WebSocket
}

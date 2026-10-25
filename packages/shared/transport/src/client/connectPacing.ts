/**
 * Keep an unreachable hub from costing the renderer WebSocket failures.
 *
 * WHY. Chromium's network service throttles every NEW WebSocket a renderer
 * process opens by that process's recent failed connects
 * (`WebSocketPerProcessThrottler`: delay = rand(1..5s) ·
 * 2^min(pending + failed/(succeeded+1), 16) / 65536, counters kept over a
 * rolling few-minute window and surviving a page reload). The failures are not
 * per host: a dead federated hub failing ~12×/min drove the throttle to its
 * cap, so the DEFAULT hub's socket on a renderer reload waited 2.4s before its
 * handshake (trace: WebSocketCreate 1.096s → SendHandshakeRequest 3.518s; a
 * direct socket from node opened in 27ms) and the whole boot waited with it.
 *
 * WHERE THE FAILURES CAME FROM. Not @trpc/client's reconnect loop — that backs
 * off 0, 2, 4, … 30s — but its `batchSend`, which calls `open()` for every
 * operation issued while the socket is down and so opens a fresh socket per
 * query, outside the backoff.
 *
 * WHAT THIS DOES. While a hub is in a failure streak (its last attempt never
 * opened), an attempt that comes OUTSIDE the reconnect schedule first asks a
 * cheap reachability probe that does not go through the renderer's WebSocket
 * stack (Electron: the main-process GET /health). Probe says up → the socket
 * opens right away, exactly as before (a recovered hub is still picked up by
 * the next query, not the next backoff tick). Probe says down → no socket is
 * created; the operation stays queued for the reconnect loop, which keeps its
 * own schedule and still tries the real socket (so a probe that is wrong — e.g.
 * a certificate only Chromium trusts — can delay a reconnect to the next
 * backoff tick, never prevent it).
 *
 * Untouched: the first connect, the first reconnect after a drop, every
 * scheduled loop attempt, and every client when no probe is installed (the
 * Chromium fork and the web shell install none → byte-identical).
 */

/** Resolves true when a socket to `wsUrl` is worth attempting now. */
export type HubConnectProbe = (wsUrl: string) => Promise<boolean>

let installedProbe: HubConnectProbe | null = null

/** Install (or clear with null) the process-wide probe. Read per attempt. */
export function setHubConnectProbe(probe: HubConnectProbe | null): void {
  installedProbe = probe
}

/**
 * @trpc/client's default reconnect delay, reproduced so the pacer can know when
 * the loop's next attempt is due (the library does not export it).
 */
export function exponentialBackoff(attemptIndex: number): number {
  return attemptIndex === 0 ? 0 : Math.min(1000 * 2 ** attemptIndex, 30_000)
}

/** An out-of-schedule attempt the probe declined — no socket was created. */
export class HubConnectDeferredError extends Error {
  constructor(url: string) {
    super(`Hub not reachable (${url}); waiting for the next reconnect attempt`)
    this.name = 'HubConnectDeferredError'
  }
}

/**
 * Slack for "is this the loop's scheduled attempt?". The loop calls `open()`
 * right after its timer fires; timers can fire a little early or late.
 */
const SCHEDULE_SLACK_MS = 50

export interface ConnectPacer {
  /** Pass as createWSClient `url`. */
  url: () => Promise<string>
  /** Pass as createWSClient `retryDelayMs`. */
  retryDelayMs: (attemptIndex: number) => number
  onOpen: () => void
  /** Wire to both onClose and onError. */
  onCloseOrError: () => void
}

export function createConnectPacer(
  wsUrl: string,
  deps: { now?: () => number; probe?: () => HubConnectProbe | null } = {}
): ConnectPacer {
  const now = deps.now ?? Date.now
  const getProbe = deps.probe ?? (() => installedProbe)
  /** The last attempt ended without the socket ever opening. */
  let failing = false
  /** The current attempt's socket reached `open`. */
  let opened = false
  /** When the reconnect loop's next attempt is due. */
  let nextScheduledAt = 0

  return {
    retryDelayMs: (attemptIndex) => {
      const delay = exponentialBackoff(attemptIndex)
      nextScheduledAt = now() + delay
      return delay
    },
    url: async () => {
      const probe = getProbe()
      if (probe && failing && now() < nextScheduledAt - SCHEDULE_SLACK_MS) {
        const up = await probe(wsUrl).catch(() => false)
        if (!up) throw new HubConnectDeferredError(wsUrl)
      }
      opened = false
      return wsUrl
    },
    onOpen: () => {
      opened = true
      failing = false
    },
    onCloseOrError: () => {
      if (!opened) failing = true
    }
  }
}

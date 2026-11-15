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
 * THE SCHEDULE WINS OVER A STALE "DOWN". trpc keeps one attempt in flight, and the
 * loop's own attempt JOINS a query's attempt that is still waiting on the probe. So
 * the probe's answer is read against the schedule as it is when the answer
 * arrives: once the loop's attempt is due, a "down" no longer defers. Otherwise a
 * slow probe that says down (main busy, timing out) took every scheduled attempt
 * with it while queries kept arriving, and the client never reconnected.
 *
 * A STUCK SOCKET GIVEN UP WHILE THE HUB ANSWERS (connectHandshake.ts →
 * `noteHubAnswered`): the next attempt is immediate — loop delay 0, no probe —
 * once. runtime.ts also wakes an already-sleeping retry loop; a new delay alone
 * cannot cancel its existing wait. The watchdog's doubling grace keeps these rare.
 *
 * Untouched: the first connect, the first reconnect after a drop, every
 * scheduled loop attempt, and every client when no probe is installed (the
 * Chromium fork and the web shell install none → byte-identical).
 */

import type { ConnectTrace } from './connectTrace'

/** Resolves true when a socket to `wsUrl` is worth attempting now. */
export type HubConnectProbe = (wsUrl: string) => Promise<boolean>

let installedProbe: HubConnectProbe | null = null

/** Install (or clear with null) the process-wide probe. Read per attempt. */
export function setHubConnectProbe(probe: HubConnectProbe | null): void {
  installedProbe = probe
}

/** The process-wide probe, as installed now (the handshake watchdog asks it too). */
export function getHubConnectProbe(): HubConnectProbe | null {
  return installedProbe
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
  /**
   * The probe just said the hub is up while a socket sat in its handshake, and that
   * socket was given up (connectHandshake.ts). The retry should not wait: the loop's
   * next delay is 0 and the next attempt is not probed again.
   */
  noteHubAnswered: () => void
}

export function createConnectPacer(
  wsUrl: string,
  deps: {
    now?: () => number
    probe?: () => HubConnectProbe | null
    /** Where each attempt's decision is recorded (connectTrace.ts). */
    trace?: ConnectTrace
  } = {}
): ConnectPacer {
  const now = deps.now ?? Date.now
  const trace = deps.trace
  const getProbe = deps.probe ?? (() => installedProbe)
  /** The last attempt ended without the socket ever opening. */
  let failing = false
  /** The current attempt's socket reached `open`. */
  let opened = false
  /** When the reconnect loop's next attempt is due. */
  let nextScheduledAt = 0
  /** `noteHubAnswered`: the loop's next delay is 0 (consumed by `retryDelayMs`). */
  let retryNow = false
  /** `noteHubAnswered`: the next attempt skips the probe (consumed by `url`). */
  let hubAnswered = false

  return {
    retryDelayMs: (attemptIndex) => {
      const delay = retryNow ? 0 : exponentialBackoff(attemptIndex)
      retryNow = false
      nextScheduledAt = now() + delay
      return delay
    },
    url: async () => {
      const probe = getProbe()
      const skipProbe = hubAnswered
      // Whoever makes the next attempt used the hint; a later loop tick must not
      // take a stale "retry now" from it.
      hubAnswered = false
      retryNow = false
      const offSchedule = failing && now() < nextScheduledAt - SCHEDULE_SLACK_MS
      const attempt = trace?.begin(!offSchedule)
      if (probe && offSchedule && !skipProbe) {
        const asked = now()
        if (attempt) attempt.outcome = 'probing'
        const up = await probe(wsUrl).catch(() => false)
        if (attempt) {
          attempt.probe = { ms: now() - asked, up }
          attempt.outcome = 'connecting'
        }
        // Re-read the schedule: the loop's own attempt may have come due while the probe
        // was out. That attempt JOINS this one (trpc keeps one attempt in flight), so a
        // stale "down" here would cost the loop its unprobed attempt — and with queries
        // arriving faster than a slow probe answers, every one of them, for good.
        if (!up && now() < nextScheduledAt - SCHEDULE_SLACK_MS) {
          if (attempt) trace?.settle(attempt, 'deferred')
          throw new HubConnectDeferredError(wsUrl)
        }
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
    },
    noteHubAnswered: () => {
      retryNow = true
      hubAnswered = true
    }
  }
}

/**
 * What every connect attempt to a hub did, kept per hub url: the last
 * {@link HUB_CONNECT_TRACE_LIMIT} attempts.
 *
 * WHY. "The hub was up but the app said unreachable" cannot be diagnosed from the
 * symptom: the operation deadline only reports that no socket opened in time. Whether
 * the attempts were deferred by the probe, waiting in a handshake, failing, or never
 * made is exactly what tells the causes apart — and it is gone by the time anyone
 * looks. The pacer records each attempt's decision (connectPacing.ts), the handshake
 * watchdog records what its socket did (connectHandshake.ts). Read-only to everyone
 * else: e2e specs dump it on failure.
 */

/** Hub connect attempts kept per url. Enough for several minutes of backoff. */
export const HUB_CONNECT_TRACE_LIMIT = 64

export type HubConnectOutcome =
  /** Asked the probe; no answer yet. */
  | 'probing'
  /** The probe said down: no socket was created. */
  | 'deferred'
  /** A socket is (about to be) connecting. */
  | 'connecting'
  | 'open'
  /** The socket failed or closed before it opened. */
  | 'failed'
  /** Given up while connecting because the hub answered its probe (stuck socket). */
  | 'hedge'
  /** Given up at the per-attempt hard deadline. */
  | 'deadline'

export interface HubConnectAttempt {
  /** When the attempt began (epoch ms). */
  at: number
  /** The reconnect loop's own (or the first) attempt — never probed. */
  onSchedule: boolean
  /** The probe's answer, when it was asked. */
  probe: { ms: number; up: boolean } | null
  /** When its socket was created (epoch ms); null when none was. */
  socketAt: number | null
  /** When it reached its outcome (epoch ms); null while in progress. */
  settledAt: number | null
  outcome: HubConnectOutcome
}

export interface ConnectTrace {
  /** A new attempt (the pacer's `url()`). */
  begin: (onSchedule: boolean) => HubConnectAttempt
  /** The socket made for the latest attempt that has none yet (or a new entry). */
  socketCreated: () => HubConnectAttempt
  settle: (attempt: HubConnectAttempt, outcome: HubConnectOutcome) => void
  entries: () => readonly HubConnectAttempt[]
}

const traces = new Map<string, ConnectTrace>()

/** The trace for `url`, created on first use. One client per hub url shares it. */
export function connectTraceFor(url: string, now: () => number = Date.now): ConnectTrace {
  const existing = traces.get(url)
  if (existing) return existing
  const attempts: HubConnectAttempt[] = []
  const push = (a: HubConnectAttempt): HubConnectAttempt => {
    attempts.push(a)
    if (attempts.length > HUB_CONNECT_TRACE_LIMIT) attempts.shift()
    return a
  }
  const trace: ConnectTrace = {
    begin: (onSchedule) =>
      push({
        at: now(),
        onSchedule,
        probe: null,
        socketAt: null,
        settledAt: null,
        outcome: 'connecting'
      }),
    socketCreated: () => {
      const t = now()
      for (let i = attempts.length - 1; i >= 0; i--) {
        const a = attempts[i]
        if (a.outcome === 'connecting' && a.socketAt === null) {
          a.socketAt = t
          return a
        }
      }
      // A socket no pacer decision announced (a client built without the pacer).
      return push({
        at: t,
        onSchedule: true,
        probe: null,
        socketAt: t,
        settledAt: null,
        outcome: 'connecting'
      })
    },
    settle: (attempt, outcome) => {
      // First outcome wins: a hedged socket's own `error` afterwards is not a new fact.
      if (attempt.settledAt !== null) return
      attempt.outcome = outcome
      attempt.settledAt = now()
    },
    entries: () => attempts
  }
  traces.set(url, trace)
  return trace
}

/** A copy of `url`'s connect attempts, oldest first. Empty for an unknown url. */
export function getHubConnectTrace(url: string): HubConnectAttempt[] {
  return (traces.get(url)?.entries() ?? []).map((a) => ({
    ...a,
    probe: a.probe ? { ...a.probe } : null
  }))
}

/** Every hub's trace, keyed by url (e2e failure dumps). */
export function getHubConnectTraces(): Record<string, HubConnectAttempt[]> {
  return Object.fromEntries([...traces.keys()].map((url) => [url, getHubConnectTrace(url)]))
}

/** Test-only: forget every trace. */
export function _resetHubConnectTraces(): void {
  traces.clear()
}

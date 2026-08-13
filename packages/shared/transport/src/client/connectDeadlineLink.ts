import { TRPCClientError, type TRPCLink, type TRPCWebSocketClient } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '../server/router'

/**
 * Fail an operation that is still waiting for its hub's socket to open.
 *
 * WHY. `wsLink` queues an operation issued while the socket is down and flushes
 * it on the next successful connect. Nothing in that path ever gives up:
 * `batchSend` awaits `open()`, a failed `open()` hands back the reconnect
 * promise, and that promise only settles when the hub answers. A hub that is
 * simply GONE therefore produces neither a result nor an error — every caller
 * sits on `isPending` for as long as the app runs. That is what a remote hub
 * card's computer list showed: skeleton rows with no end, on a hub the header had
 * already reported unreachable. (Requests that were already IN FLIGHT when a
 * socket dies do get errored by @trpc/client — this link closes the gap for the
 * ones queued while it is down, so both cases now end the same way.)
 *
 * WHY A DEADLINE ON CONNECTING, NOT A REQUEST TIMEOUT. The clock runs only
 * while the hub is not connected, and is thrown away the moment it is. A slow
 * procedure on a healthy hub — cloning a repo, spawning an agent — is never
 * touched, however long it takes, so this cannot become the reason a legitimate
 * long operation dies. What it bounds is exactly the unanswerable state: nobody
 * to send to.
 *
 * WHY IT LIVES IN THE TRANSPORT rather than in the one surface that showed the
 * symptom. Every query against an unreachable hub hangs the same way; a fix at
 * the call site would leave the same defect behind ~500 other `useTRPC()` sites
 * and would have to be re-made for each new one. Applied here, an unreachable
 * hub becomes an ordinary query error, which the UI layer already knows how to
 * render (React Query's `isError`, `retry: false`, refetch on focus).
 *
 * SUBSCRIPTIONS ARE EXEMPT. A subscription is long-lived by design and is meant
 * to survive a reconnect; `wsLink` already forwards connection state to its
 * subscriber, so a consumer can see "connecting" without the subscription being
 * torn down. Deadlining one would break live streams (pty output, agent events)
 * on every blip.
 */

/**
 * How long an operation may wait for a connection before it is called
 * unreachable.
 *
 * DERIVED, not picked: it must exceed the local sidecar supervisor's own
 * per-attempt health budget (`HEALTH_BOOT_TIMEOUT_MS`, 10s — the point at which
 * IT gives up on a child and respawns). At exactly 10s the client would start
 * calling the hub unreachable in the same instant the supervisor still expects
 * the restart to succeed; the margin keeps "we gave up" strictly downstream of
 * "the thing that owns the process gave up". Still short enough that a dead hub
 * reports as dead while the operator is looking at it.
 */
export const HUB_CONNECT_DEADLINE_MS = 15_000

/** The subset of `TRPCWebSocketClient` this link reads — its connection state. */
export type ConnectionStateSource = Pick<TRPCWebSocketClient, 'connectionState'>['connectionState']

export interface ConnectDeadlineLinkOpts {
  /** The hub socket's state stream. `pending` is @trpc/client's word for open. */
  connectionState: ConnectionStateSource
  /** Override the deadline (tests use a short one). */
  deadlineMs?: number
  /** Named in the error, so a multi-hub client says WHICH hub went missing. */
  hubUrl?: string
}

export function connectDeadlineLink(opts: ConnectDeadlineLinkOpts): TRPCLink<AppRouter> {
  const deadlineMs = opts.deadlineMs ?? HUB_CONNECT_DEADLINE_MS
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        if (op.type === 'subscription') return next(op).subscribe(observer)

        let timer: ReturnType<typeof setTimeout> | null = null
        let done = false
        const disarm = (): void => {
          if (timer) clearTimeout(timer)
          timer = null
        }

        // Subscribing IS sending — the operation is registered downstream here,
        // before the deadline is armed, so the ordinary path is unchanged.
        const request = next(op).subscribe({
          next: (value) => observer.next(value),
          error: (err) => {
            done = true
            disarm()
            observer.error(err)
          },
          complete: () => {
            done = true
            disarm()
            observer.complete()
          }
        })

        const expire = (): void => {
          if (done) return
          done = true
          disarm()
          const cause = opts.connectionState.get().error
          // Erroring an observable runs ITS teardown (below) synchronously, so
          // this is also what drops the queued request — it is not left in the
          // request manager to be flushed at some later reconnect, long after
          // its caller stopped listening.
          observer.error(
            TRPCClientError.from(
              new Error(
                `Hub unreachable — ${opts.hubUrl ? `${opts.hubUrl} did not ` : 'no '}` +
                  `connect within ${deadlineMs}ms${cause ? ` (${cause.message})` : ''}`
              )
            )
          )
        }

        // Armed whenever the socket is not open — including a hub that drops
        // after the operation was queued but before it could be flushed — and
        // disarmed the moment it is.
        const arm = (state: string): void => {
          if (state === 'pending') {
            disarm()
            return
          }
          if (!timer && !done) timer = setTimeout(expire, deadlineMs)
        }
        const stateSub = opts.connectionState.subscribe({ next: (s) => arm(s.state) })
        arm(opts.connectionState.get().state)

        return () => {
          disarm()
          stateSub.unsubscribe()
          request.unsubscribe()
        }
      })
}

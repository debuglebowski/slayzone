import type { TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'

/** Resolves a query or mutation; a throw/rejection surfaces as the operation's error. */
// biome-ignore lint/suspicious/noExplicitAny: inputs are whatever the caller sends
export type InProcessProcedure = (input: any) => unknown
/** Starts a subscription; call `emit` per event, return the teardown. */
export type InProcessSubscription = (
  // biome-ignore lint/suspicious/noExplicitAny: see InProcessProcedure
  input: any,
  emit: (data: unknown) => void
) => (() => void) | void

/** What answers a hub's operations in this process, by dotted path. */
export interface InProcessBackend {
  /** Queries + mutations, keyed by dotted path (`'fileEditor.readFile'`). */
  procedures?: Record<string, InProcessProcedure>
  /** Subscriptions, keyed by dotted path (`'fileEditor.watch'`). */
  subscriptions?: Record<string, InProcessSubscription>
}

/**
 * A terminating link that resolves every operation against `backend` in this process
 * instead of sending it down a hub socket: what a hub served in-process (the mobile
 * app's demo hub, `FederationProvider`'s `inProcessLinks`) and the client test harness
 * (`@slayzone/transport/testing`) answer with. An operation with no handler fails
 * loudly (`unexpected op <path>`), so a caller that grows a new call can't silently
 * get nothing.
 *
 * No transformer runs: answers reach the caller as the handler returned them, by
 * reference. A backend that keeps mutable state hands out copies.
 */
export function inProcessLink(backend: InProcessBackend): TRPCLink<AnyTRPCRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') {
          const start = backend.subscriptions?.[op.path]
          if (!start) {
            observer.error(new Error(`unexpected op ${op.path}`) as never)
            return () => undefined
          }
          observer.next({ result: { type: 'started' } })
          const teardown = start(op.input, (data) =>
            observer.next({ result: { type: 'data', data } })
          )
          return () => teardown?.()
        }
        const resolve = backend.procedures?.[op.path]
        if (!resolve) {
          observer.error(new Error(`unexpected op ${op.path}`) as never)
          return () => undefined
        }
        Promise.resolve()
          .then(() => resolve(op.input))
          .then(
            (data) => {
              observer.next({ result: { type: 'data', data } })
              observer.complete()
            },
            (err: unknown) => observer.error(err as never)
          )
        return () => undefined
      })
}

/**
 * The demo hub's handlers, typed by the app router: a handler for `'task.get'` takes
 * what the app sends `task.get` and must answer what the hub would. A procedure the
 * router renames or reshapes fails the app's typecheck here, not the demo at runtime.
 */
import type { InProcessProcedure, InProcessSubscription } from '@slayzone/transport/client'
import type { RouterInputs, RouterOutputs } from '../trpc'

type At<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never

/** What the app sends procedure `P` (dotted path). */
export type ProcIn<P extends string> = At<RouterInputs, P>
/** What the hub answers procedure `P` (dotted path); a subscription's: one event. */
export type ProcOut<P extends string> = At<RouterOutputs, P>

type Handlers<K extends string> = {
  [P in K]: (input: ProcIn<P>) => ProcOut<P> | Promise<ProcOut<P>>
}
type SubscriptionHandlers<K extends string> = {
  [P in K]: (input: ProcIn<P>, emit: (event: SubscriptionEvent<P>) => void) => () => void
}
/** One event of subscription `P`. */
export type SubscriptionEvent<P extends string> =
  ProcOut<P> extends AsyncIterable<infer E> ? E : ProcOut<P>

/** Queries + mutations by path, each checked against the router. */
export function procedures<K extends string>(handlers: Handlers<K>): Record<K, InProcessProcedure> {
  return handlers as Record<K, InProcessProcedure>
}

/** Subscriptions by path, each checked against the router. */
export function subscriptions<K extends string>(
  handlers: SubscriptionHandlers<K>
): Record<K, InProcessSubscription> {
  return handlers as unknown as Record<K, InProcessSubscription>
}

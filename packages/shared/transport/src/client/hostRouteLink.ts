import { getUntypedClient, type TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { isHostPath } from '../shared/host-paths'
import type { RuntimeClient } from './runtime'

/**
 * Forwards every desktop-host operation ({@link isHostPath}) to the hub bridged to
 * this desktop, and passes everything else down this hub's own chain.
 *
 * Installed on each NON-local hub's client: a task pane scoped to a remote hub
 * calls `app.shell.openExternal`, `app.window.close`, `menu.on…` etc. through that
 * hub's client, but only the local hub can reach the Electron host. Forwarding at
 * the link keeps every call site (hooks, vanilla clients, future code) correct.
 *
 * The target client applies its own transformer, so data crosses here already
 * deserialized and the input is passed through unserialized. `getHost` is read
 * per operation; with no host client (yet) the op goes down this hub's chain,
 * i.e. exactly the pre-forwarding behavior.
 */
export function hostRouteLink(getHost: () => RuntimeClient | null): TRPCLink<AnyTRPCRouter> {
  return () =>
    ({ op, next }) => {
      const host = isHostPath(op.path) ? getHost() : null
      if (!host) return next(op)
      const target = getUntypedClient(host)
      return observable((observer) => {
        if (op.type === 'subscription') {
          const sub = target.subscription(op.path, op.input, {
            signal: op.signal ?? undefined,
            context: op.context,
            onStarted: () => observer.next({ result: { type: 'started' } }),
            onData: (data) => observer.next({ result: { type: 'data', data } }),
            onError: (err) => observer.error(err),
            onComplete: () => observer.complete(),
            onStopped: () => observer.complete()
          })
          return () => sub.unsubscribe()
        }
        const call = op.type === 'query' ? target.query : target.mutation
        call
          .call(target, op.path, op.input, {
            signal: op.signal ?? undefined,
            context: op.context
          })
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
}

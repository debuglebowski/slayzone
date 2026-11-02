import type { TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { compactBytesInInput, hasBytes } from '@slayzone/trpc-server/wire'

export interface CompactBytesLinkOpts {
  /** Does this connection's hub read compact bytes? Asked only for an operation carrying bytes. */
  hubReadsCompactBytes: () => Promise<boolean>
}

/**
 * Sends the `Uint8Array`s of an operation's input as base64 (`bytes:base64`) instead
 * of superjson's number array — ~4/3 of the payload instead of ~3.6× — when the hub
 * says it reads them. See `@slayzone/trpc-server/wire`.
 *
 * Gated per hub because an older hub's superjson throws on a custom value it does not
 * know: to such a hub (or one that cannot be asked) the operation goes unchanged, as
 * plain superjson, exactly as before. An operation without bytes passes straight
 * through, with no question asked. Router-agnostic: it reads only `op.input`.
 */
export function compactBytesLink<TRouter extends AnyTRPCRouter>(
  opts: CompactBytesLinkOpts
): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        if (!hasBytes(op.input)) return next(op).subscribe(observer)
        let cancelled = false
        let unsubscribe: (() => void) | null = null
        opts
          .hubReadsCompactBytes()
          .catch(() => false)
          .then((compact) => {
            if (cancelled) return
            const sent = compact ? { ...op, input: compactBytesInInput(op.input) } : op
            const sub = next(sent).subscribe(observer)
            unsubscribe = () => sub.unsubscribe()
          })
        return () => {
          cancelled = true
          unsubscribe?.()
        }
      })
}

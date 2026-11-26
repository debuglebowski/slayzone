import { TRPCClientError, type TRPCLink } from '@trpc/client'
import type { AnyTRPCRouter } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { type ApiIncompatibility, VERSION_EXEMPT_PATH } from '@slayzone/trpc-server/api-version'

export interface HubCompatLinkOpts {
  /** What is known about this connection's hub right now (synchronous; null = fine or unknown). */
  incompatibility: () => ApiIncompatibility | null
}

/** What the user reads for an incompatible hub — the same words as the banner. */
export function incompatibilityMessage(i: ApiIncompatibility): string {
  const release = i.release ? ` (${i.release})` : ''
  return i.side === 'hub'
    ? `This hub${release} runs an older SlayZone than this app needs — update the hub`
    : `This hub${release} no longer serves this version of the app — update SlayZone`
}

const MISSING_PROCEDURE = /^No "(query|mutation|subscription)"-procedure on path "([^"]+)"$/

/**
 * The client's guard for the client ↔ hub API contract (`@slayzone/trpc-server/api-version`):
 *
 * - A hub known to be incompatible (`hub.describe` said so: `knownApiIncompatibility`)
 *   is sent nothing but `hub.describe`; every other operation fails at once with the
 *   reason, instead of reaching a hub that would misread it.
 * - A NOT_FOUND for a procedure the hub does not have — a hub older than this client
 *   inside the support window, asked for something newer that was not feature-gated —
 *   reads as that instead of an opaque "No procedure on path".
 *
 * Unknown compatibility (no answer yet) passes through: nothing waits on the question.
 */
export function hubCompatLink<TRouter extends AnyTRPCRouter>(
  opts: HubCompatLinkOpts
): TRPCLink<TRouter> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        const incompatible = op.path === VERSION_EXEMPT_PATH ? null : opts.incompatibility()
        if (incompatible) {
          observer.error(TRPCClientError.from(new Error(incompatibilityMessage(incompatible))))
          return
        }
        const sub = next(op).subscribe({
          next: (v) => observer.next(v),
          complete: () => observer.complete(),
          error: (err) => {
            const missing =
              err.data?.code === 'NOT_FOUND' ? MISSING_PROCEDURE.exec(err.message) : null
            if (!missing) return observer.error(err)
            const rewritten = new TRPCClientError(
              `This hub's version does not have "${missing[2]}" — update the hub`,
              { cause: err, meta: err.meta, result: err.shape ? { error: err.shape } : undefined }
            )
            observer.error(rewritten as typeof err)
          }
        })
        return () => sub.unsubscribe()
      })
}

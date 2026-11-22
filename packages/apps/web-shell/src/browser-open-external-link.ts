import type { AppRouter } from '@slayzone/api'
import { TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'

/** Open external links in the viewer's browser while the click is still active. */
export const browserOpenExternalLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) => {
    if (op.type !== 'mutation' || op.path !== 'app.shell.openExternal') return next(op)

    return observable((observer) => {
      try {
        const input = op.input as { url?: unknown } | undefined
        if (typeof input?.url !== 'string') throw new Error('Expected an external URL')
        const url = new URL(input.url)
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
          throw new Error('Only http, https, and mailto URLs are allowed')
        }
        window.open(url.href, '_blank', 'noopener')
      } catch (error) {
        observer.error(
          TRPCClientError.from(error instanceof Error ? error : new Error('Could not open URL'))
        )
        return
      }

      observer.next({ result: { data: undefined } })
      observer.complete()
    })
  }

import type { IncomingHttpHeaders } from 'node:http'
import { peerAddress, routeOf, securityEvent } from '@slayzone/platform/security-log'
import type { RestPrincipal } from './types'

/**
 * Audit line for a refusal by a route that guards ITSELF (T-03) — the hub's REST
 * gate exempts `/api/hub/users` and `/api/computers/join-token` and lets them decide
 * (see `apps/hub/src/rest-auth.ts`), so their 403/401 is the gate's denial and is
 * written the same way: `authz.denied`, never the presented credential.
 * `not-admin`: a valid session whose account is not admin (`/api/hub/users`).
 */
export function auditRouteRefusal(
  req: {
    method?: string
    originalUrl?: string
    url?: string
    socket?: { remoteAddress?: string }
    headers: IncomingHttpHeaders
  },
  outcome: 'forbid' | 'unauthorized' | 'not-admin',
  principal: RestPrincipal | null
): void {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    actor: principal?.userId ?? null,
    ip: peerAddress(req),
    route: routeOf(req.method, req.originalUrl ?? req.url),
    detail: {
      reason:
        outcome === 'forbid'
          ? 'not_loopback'
          : outcome === 'not-admin'
            ? 'not_admin'
            : principal
              ? 'scoped_session'
              : 'unauthenticated',
      status: outcome === 'unauthorized' ? 401 : 403
    }
  })
}

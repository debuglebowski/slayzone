import type { Express } from 'express'
import { getAuthGate } from '@slayzone/trpc-server'
import { restPrincipalOf } from '../principal'
import type { RestApiDeps } from '../types'

/**
 * REST: `GET /api/computers/direct-addresses` — the computer listener addresses this
 * hub issued direct links to, for the caller's live grants only (docs/direct-link.md).
 *
 * The desktop's main process asks before its renderer's `connect-src` may name a
 * direct address: a renderer can only REPORT an address it was given, and an origin
 * main added on that word alone would let a compromised renderer open the CSP to any
 * host. So main adds an origin only when the hub that issued it confirms it here, and
 * fails closed otherwise (`direct-link-gate.ts`).
 *
 * Rides the shared REST bearer gate. On a hub with login an unauthenticated request
 * holds no grants, so it gets none.
 */
export function registerComputersDirectAddressesRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/computers/direct-addresses', (req, res) => {
    const principal = restPrincipalOf(req)
    if (getAuthGate() && !principal) {
      res.json({ addresses: [] })
      return
    }
    const addresses = deps.computers?.directAddresses?.(principal?.userId ?? null) ?? []
    res.json({ addresses })
  })
}

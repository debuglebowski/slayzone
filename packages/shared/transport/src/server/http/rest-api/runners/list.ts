import type { Express } from 'express'
import { listRunners as storeListRunners } from '@slayzone/computers/server'
import type { RestApiDeps } from '../types'

/**
 * REST: `GET /api/runners` — the runners this hub knows, with live status.
 *
 * WHY THE CLI NEEDS THIS. A runner binds no port, so unlike a hub there is nothing
 * on this machine to sweep for. `slay runner ls` therefore used to enumerate UNIT
 * FILES — which made the supervisor's registry double as the index of what exists,
 * and that index disappears exactly when there is no supervisor. The hub is the only
 * registry a runner has that survives that: it issued the credentials, so it knows
 * every runner regardless of how (or whether) the runner's own machine supervises it.
 *
 * This is the REST twin of the `runners.list` tRPC procedure, deliberately narrowed
 * to the identity fields a CLI listing needs. The CLI speaks REST to hubs (see
 * `cli/src/hub-request.ts`) and has no tRPC client, exactly as `join-token` found.
 *
 * NOT loopback-gated, unlike minting: a token is a bearer credential, whereas this is
 * the same non-secret roster the app's Runners tab already renders to any connected
 * client. It rides the shared REST bearer gate (`withRestAuth`), so an auth-enforcing
 * hub still requires a session; a loopback hub answers its own machine as before.
 */
export function registerRunnersListRoute(app: Express, deps: RestApiDeps): void {
  app.get('/api/runners', async (_req, res) => {
    try {
      const rows = await storeListRunners(deps.db)
      // Live status comes from the gateway when it is wired. An un-wired gateway
      // (init failed, or still coming up) must degrade to "known but not connected"
      // rather than 503: the roster is still the truthful answer to "what runners
      // exist", and a CLI listing that fails because a socket is down would be
      // exactly the brittleness this endpoint was added to remove.
      const gateway = deps.runners?.getGateway?.() ?? null
      const liveIds = new Set((gateway?.listRunners() ?? []).map((r) => r.runnerId))
      const usableIds = new Set((gateway?.listUsableRunners() ?? []).map((r) => r.runnerId))
      res.json(
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          platform: row.platform,
          lastSeenAt: row.last_seen_at,
          connected: liveIds.has(row.id),
          usable: usableIds.has(row.id)
        }))
      )
    } catch (err) {
      res.status(500).json({
        error: 'failed to list runners',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

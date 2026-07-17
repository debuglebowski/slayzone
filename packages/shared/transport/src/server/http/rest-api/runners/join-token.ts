import type { Express } from 'express'
import { mintJoinToken as storeMintJoinToken } from '@slayzone/runners/server'
import type { RestApiDeps } from '../types'

/**
 * REST: `POST /api/runners/join-token` — mint a single-use runner enrollment
 * token over loopback (hub/runner split, Wave3.5-D3).
 *
 * WHY REST (not tRPC): the Electron MAIN process has no tRPC client to the
 * sidecar (the capability bridge only flows sidecar→main). Main already knows
 * the sidecar's loopback HTTP base (via the sidecar supervisor's onReady port),
 * so a plain loopback fetch is the minimal channel for boot-time auto-enroll —
 * far simpler than standing up a WS tRPC client in main just to call
 * `runners.mintJoinToken`. This route wraps the SAME store `mintJoinToken`
 * logic as that proc.
 *
 * Gating (mirrors the runners router's `mintJoinToken`): only functional under
 * runner mode. `deps.runners` is wired ONLY when runner mode is on (composition),
 * and its getters return the runner listener's bound `wss://…/runners` URL + hub
 * cert fingerprint — both null until the listener has bound. So:
 *   - runner OFF (`deps.runners` absent)              → 503 (never mints)
 *   - runner ON but listener not yet bound (null url) → 503 (caller retries)
 *   - runner ON + listener bound                      → 200 `{ token, hubUrl }`
 *
 * Loopback-only: the token is a bearer-equivalent secret, so a non-loopback
 * caller is rejected. The shared HTTP server binds loopback anyway (getServerHost
 * defaults to 127.0.0.1); this is defense-in-depth for an accidental SLAYZONE_HOST
 * override. Main always dials 127.0.0.1, so it is never rejected.
 */

const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000 // 15 minutes (matches runnersRouter)

/** True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports. */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  )
}

export function registerRunnersJoinTokenRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/runners/join-token', async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
      res.status(403).json({ error: 'runner join-token is loopback-only' })
      return
    }
    if (!deps.runners) {
      res
        .status(503)
        .json({ error: 'runner mode is off — no runner join token available' })
      return
    }
    const hubUrl = deps.runners.getHubUrl()
    const certFingerprint = deps.runners.getCertFingerprint()
    if (!hubUrl || !certFingerprint) {
      res
        .status(503)
        .json({ error: 'runner listener has not bound its URL / hub identity yet' })
      return
    }

    const body = (req.body ?? {}) as { label?: unknown; ttlMs?: unknown }
    const label =
      typeof body.label === 'string' && body.label.length > 0 ? body.label : 'local-runner'
    const ttlMs =
      typeof body.ttlMs === 'number' && Number.isInteger(body.ttlMs) && body.ttlMs > 0
        ? body.ttlMs
        : DEFAULT_JOIN_TOKEN_TTL_MS

    try {
      const minted = await storeMintJoinToken(deps.db, {
        hubUrl,
        certFingerprint,
        ttlMs,
        label
      })
      // Return the token + the wss runner URL the runner should dial. The cert
      // fingerprint is embedded IN the token (decoded runner-side) — never sent
      // as a separate field.
      res.json({ token: minted.token, hubUrl })
    } catch (err) {
      res.status(500).json({
        error: 'failed to mint join token',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

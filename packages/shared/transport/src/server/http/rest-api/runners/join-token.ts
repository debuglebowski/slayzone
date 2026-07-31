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
 * `deps.runners` is wired by the composition (always, barring init failure),
 * and its getters return the runner listener's bound `wss://…/runners` URL + hub
 * cert fingerprint — both null until the listener has bound. So:
 *   - runner OFF (`deps.runners` absent)              → 503 (never mints)
 *   - runner ON but listener not yet bound (null url) → 503 (caller retries)
 *   - runner ON + listener bound                      → 200 `{ token, hubUrl }`
 *
 * WHO MAY CALL IT — loopback, or an authenticated off-box operator.
 *
 * A join token is a bearer-equivalent secret, so being on the box was originally
 * the sole authority (the shared HTTP server binds loopback anyway; the check is
 * defense-in-depth against an accidental non-loopback `SLAYZONE_HUB_ADDRESS`).
 * That left `slay runner mint` unable to target a hub on another machine — while
 * an off-box client with a session could already mint the SAME token over `/trpc`
 * (`runners.mintJoinToken` is not loopback-gated). The 403 was therefore a
 * capability gap between two transports, not a security boundary, so an off-box
 * caller is now admitted on the same authority `/trpc` accepts: a verified
 * better-auth session. See {@link joinTokenAuthDecision} for the exact matrix.
 *
 * The loopback path is checked FIRST and never consults the bearer, so the
 * Electron host's boot auto-enroll and any on-box `slay` are byte-identical — and
 * a hub that does not enforce auth (every local / supervised / e2e hub) still
 * rejects every off-box caller outright, because it has no sessions to verify.
 *
 * This route stays in the bearer gate's `SELF_GUARDED` set: it now self-guards on
 * loopback OR a verified bearer, which is still at least as tight as the gate.
 * Removing the exemption would make the outer gate 401 an off-box request before
 * this handler runs, hiding both the 503 (listener not yet bound) and the 403 that
 * distinguishes "wrong machine" from "no credential".
 */

const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000 // 15 minutes (matches runnersRouter)

/**
 * True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports.
 *
 * Exported so the peer classification is directly unit-testable: `mountRestApp`
 * always binds 127.0.0.1, so a test driving this route over HTTP can never
 * produce an off-box peer (same reasoning as `hub/users.ts`).
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr.startsWith('127.')
  )
}

/** What to do with a mint request, once its peer + credential are known. */
export type JoinTokenAuthOutcome = 'mint' | 'forbid' | 'unauthorized'

/**
 * Decide whether a caller may mint. Pure, so the off-box rows are testable
 * without a real off-box peer.
 *
 * - loopback → `mint`, always, bearer never consulted (the co-located trust
 *   boundary the loopback bind already established).
 * - off-box on a hub that does NOT enforce auth → `forbid`. There are no sessions
 *   to verify, so accepting a bearer would be theater; being on the box stays the
 *   only authority.
 * - off-box on an enforcing hub → `mint` with a verified session, else
 *   `unauthorized`. 401 rather than 403 on purpose: the caller has a credential
 *   problem (fixable by signing in), not a policy one (fixable only by moving
 *   machines), and conflating the two sends operators to the wrong fix.
 */
export function joinTokenAuthDecision(opts: {
  loopback: boolean
  authRequired: boolean
  bearerOk: boolean
}): JoinTokenAuthOutcome {
  if (opts.loopback) return 'mint'
  if (!opts.authRequired) return 'forbid'
  return opts.bearerOk ? 'mint' : 'unauthorized'
}

export function registerRunnersJoinTokenRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/runners/join-token', async (req, res) => {
    const loopback = isLoopbackAddress(req.socket.remoteAddress ?? undefined)
    // An absent `restAuth` slot (the Electron host) means no bearer authority at
    // all, which collapses this to loopback-only — today's behavior exactly.
    const authRequired = deps.restAuth?.required() === true
    // Only verify when the answer can matter: a loopback caller is already
    // admitted, and a non-enforcing hub cannot verify anything.
    const bearerOk =
      !loopback && authRequired ? await deps.restAuth!.verifyBearer(req.headers) : false
    const decision = joinTokenAuthDecision({ loopback, authRequired, bearerOk })
    if (decision === 'forbid') {
      res.status(403).json({
        error:
          'runner join-token is loopback-only on this hub — run `slay runner mint` on the ' +
          'hub machine, or put the hub in remote mode so it can authenticate you'
      })
      return
    }
    if (decision === 'unauthorized') {
      res.status(401).json({
        error: 'Unauthorized — sign in to this hub with `slay hub login <url>` first'
      })
      return
    }
    if (!deps.runners) {
      res
        .status(503)
        .json({ error: 'runner listener not ready — no join token available' })
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

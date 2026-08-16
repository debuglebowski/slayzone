import type { Express } from 'express'
import { mintJoinToken as storeMintJoinToken } from '@slayzone/computers/server'
import { isLoopbackPeer } from '@slayzone/platform'
import type { RestApiDeps } from '../types'

/**
 * REST: `POST /api/computers/join-token` — mint a single-use computer enrollment
 * token over loopback (hub/computer split, Wave3.5-D3).
 *
 * WHY REST (not tRPC): the Electron MAIN process has no tRPC client to the
 * sidecar (the capability bridge only flows sidecar→main). Main already knows
 * the sidecar's loopback HTTP base (via the sidecar supervisor's onReady port),
 * so a plain loopback fetch is the minimal channel for boot-time auto-enroll —
 * far simpler than standing up a WS tRPC client in main just to call
 * `computers.mintJoinToken`. This route wraps the SAME store `mintJoinToken`
 * logic as that proc.
 *
 * Gating (mirrors the computers router's `mintJoinToken`): only functional under
 * `deps.computers` is wired by the composition (always, barring init failure),
 * and its getters return the computer listener's bound `wss://…/computers` URL + hub
 * cert fingerprint — both null until the listener has bound. So:
 *   - computer OFF (`deps.computers` absent)              → 503 (never mints)
 *   - computer ON but listener not yet bound (null url) → 503 (caller retries)
 *   - computer ON + listener bound                      → 200 `{ token, hubUrl }`
 *
 * WHO MAY CALL IT — a bearer, from everyone, once this hub enforces auth; on a
 * hub with NO auth (supervised) loopback is the sole authority, because there are
 * no sessions to check.
 *
 * A join token is a bearer-equivalent secret, so being on the box was ORIGINALLY
 * the sole authority regardless of auth state (the shared HTTP server binds
 * loopback anyway; the check was defense-in-depth against an accidental
 * non-loopback `SLAYZONE_HUB_ADDRESS`). THAT WAS THE BUG: every non-supervised hub
 * now enforces auth (`server.ts`: `hubAuthRequired = !supervised`), and a reverse
 * proxy in front of one makes every request arrive as a loopback peer — so
 * unconditional loopback trust collapsed to "anyone who can reach the hub can mint
 * a computer enrollment secret", exactly the shape `computers/server/visibility.ts`
 * exists to prevent. See {@link joinTokenAuthDecision} for the exact matrix.
 *
 * WHY THE ELECTRON HOST'S BOOT AUTO-ENROLL STILL WORKS WITH NO BEARER: it only
 * ever calls its OWN co-located sidecar, which is supervised — `authRequired` is
 * false there, so loopback alone still admits it, unchanged.
 *
 * WHY ON-BOX `slay computer mint` STILL WORKS WITH NO OPERATOR ACTION, on a
 * standalone hub that now DOES require a bearer: `ensureBootstrapOwner`
 * (bootstrap-owner.ts) provisions a real session on first boot for exactly this,
 * and the CLI reads it automatically (api.ts, hub-request.ts) when nothing else is
 * configured — so a co-located caller presents a genuine bearer instead of relying
 * on its peer address.
 *
 * This route stays in the bearer gate's `SELF_GUARDED` set: it now self-guards on
 * this same matrix, which is at least as tight as the outer gate — actually
 * tighter than the outer gate WAS before this fix. Removing the exemption would
 * make the outer gate 401 an off-box request before this handler runs, hiding
 * both the 503 (listener not yet bound) and the 401/403 distinction below.
 */

const DEFAULT_JOIN_TOKEN_TTL_MS = 15 * 60_000 // 15 minutes (matches computersRouter)

/**
 * True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports.
 *
 * Re-exported (rather than redefined) so the peer classification stays directly
 * unit-testable here — `mountRestApp` always binds 127.0.0.1, so a test driving
 * this route over HTTP can never produce an off-box peer (same reasoning as
 * `hub/users.ts`). The implementation is the single shared one in
 * `@slayzone/platform`; this file previously carried its own copy, which had
 * already drifted from the hub's.
 */
export const isLoopbackAddress = isLoopbackPeer

/** What to do with a mint request, once its peer + credential are known. */
export type JoinTokenAuthOutcome = 'mint' | 'forbid' | 'unauthorized'

/**
 * Decide whether a caller may mint. Pure, so the off-box AND proxied-loopback
 * rows are testable without a real socket.
 *
 * - auth NOT required (supervised — no sessions exist to verify) → loopback is
 *   the sole authority, exactly as before; off-box gets nothing to authenticate
 *   with, so `forbid`.
 * - auth required (every standalone hub) → a bearer is required from EVERYONE,
 *   loopback included. `bearerOk` is never skipped for a loopback peer here —
 *   that unconditional skip was the bug: a reverse proxy in front of a standalone
 *   hub makes every request loopback, so it was the same as no gate at all.
 * - 401 (not 403) on a missing bearer when auth IS required: the caller has a
 *   credential problem (fixable by signing in / reading the owner file), not a
 *   policy one (fixable only by moving machines) — conflating the two sends
 *   operators to the wrong fix.
 */
export function joinTokenAuthDecision(opts: {
  loopback: boolean
  authRequired: boolean
  bearerOk: boolean
}): JoinTokenAuthOutcome {
  if (!opts.authRequired) return opts.loopback ? 'mint' : 'forbid'
  return opts.bearerOk ? 'mint' : 'unauthorized'
}

export function registerComputersJoinTokenRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/computers/join-token', async (req, res) => {
    const loopback = isLoopbackAddress(req.socket.remoteAddress ?? undefined)
    // An absent `restAuth` slot (the Electron host) means no bearer authority at
    // all, which collapses this to loopback-only — today's behavior exactly.
    const authRequired = deps.restAuth?.required() === true
    // Only verify when the answer can matter: a non-enforcing hub cannot verify
    // anything. NOT gated on `!loopback` — a loopback peer on an ENFORCING hub
    // must present a bearer too, since a reverse proxy makes every off-box
    // request arrive as loopback. See joinTokenAuthDecision's docstring.
    //
    // FULL ONLY, deliberately: minting a computer enrollment secret is not a
    // classified tRPC scope (this route lives entirely outside SCOPE_POLICY),
    // so a scoped web session's bearer/cookie must never satisfy it — no
    // cookies passed here, only the header, and only a `full` principal counts.
    const principal = authRequired ? await deps.restAuth!.verifyBearer(req.headers, {}) : null
    const bearerOk = principal?.scopes.includes('full') === true
    const decision = joinTokenAuthDecision({ loopback, authRequired, bearerOk })
    if (decision === 'forbid') {
      res.status(403).json({
        error:
          'computer join-token is loopback-only on this hub — run `slay computer mint` on the ' +
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
    if (!deps.computers) {
      res.status(503).json({ error: 'computer listener not ready — no join token available' })
      return
    }
    const hubUrl = deps.computers.getHubUrl()
    const certFingerprint = deps.computers.getCertFingerprint()
    if (!hubUrl || !certFingerprint) {
      res.status(503).json({ error: 'computer listener has not bound its URL / hub identity yet' })
      return
    }

    const body = (req.body ?? {}) as { label?: unknown; ttlMs?: unknown }
    const label =
      typeof body.label === 'string' && body.label.length > 0 ? body.label : 'local-computer'
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
      // Return the token + the wss computer URL the computer should dial. The cert
      // fingerprint is embedded IN the token (decoded computer-side) — never sent
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

import type { IncomingHttpHeaders } from 'node:http'
import type { Express } from 'express'
import { isLoopbackPeer } from '@slayzone/platform'
import type { RestApiDeps } from '../types'

/**
 * REST: `/api/hub/users` — operator account management, backing
 * `slay hub users add|ls|rm`.
 *
 * WHY THIS EXISTS: a hub that enforces auth gates its whole surface on a
 * better-auth bearer, and public signup is CLOSED (`emailAndPassword.disableSignUp`
 * in hub-auth's auth.ts) because `/api/auth/sign-up/email` must stay gate-exempt
 * for a token-less client to reach — which had made any reachable hub
 * self-registerable. So administering accounts needs a channel that does not
 * itself depend on the outer gate.
 *
 * WAS LOOPBACK-ONLY, NOW A BEARER FROM EVERYONE ONCE AUTH IS REQUIRED. Every
 * non-supervised hub enforces auth (`server.ts`: `hubAuthRequired = !supervised`),
 * which made the old rule — any loopback peer administers accounts, bearer never
 * consulted — the exact fail-open a reverse proxy turns into "anyone reaches this
 * route": every request through a co-located proxy arrives with a loopback
 * `remoteAddress`. Loopback stays the ONLY authority on a hub with no auth at all
 * (supervised — there are no sessions to check), because that is the one shape
 * where "on the box" genuinely is the whole story. See {@link hubUsersAuthDecision}
 * for the exact matrix — it mirrors {@link joinTokenAuthDecision}'s, by design:
 * the same reverse-proxy shape threatened both routes, and diverging their rules
 * would leave one silently unrepaired.
 *
 * WHY A LOOPBACK CALLER CAN STILL GET A BEARER, on a hub that now requires one:
 * `ensureBootstrapOwner` (bootstrap-owner.ts) provisions a real first-user session
 * on first boot specifically so a co-located caller is never locked out, and
 * `hub.owner.json` carries it. The CLI reads that file automatically when nothing
 * else is configured (api.ts, hub-request.ts) — so `slay hub users add` on the hub
 * box keeps working with no operator action, it just now carries a real
 * credential instead of relying on the peer address.
 *
 * ONE PATH, THREE METHODS. The bearer gate's `SELF_GUARDED` set
 * (`apps/hub/src/rest-auth.ts`) matches the pathname EXACTLY, so a
 * `DELETE /api/hub/users/:email` shape could not be exempted without teaching the
 * gate prefix matching — which would weaken it for every route. `rm` therefore
 * carries the email in the request body (same shape as
 * `DELETE /api/tasks/:id/tags`), keeping the gate to a single exact entry.
 *
 * Gating mirrors the join-token route: the capability slot (`deps.hubUsers`) is
 * wired only by the hub composition root, and hub-auth is built ASYNC, so
 *   - slot absent (Electron host, or a build without hub-auth) → 503
 *   - slot present but `ready()` false (init pending, or createHubAuth threw) → 503
 *   - otherwise → the operation runs
 *
 * @module transport/rest-api/hub/users
 */

/**
 * True for IPv4/IPv6 loopback, incl. the IPv4-mapped-IPv6 form node reports.
 *
 * Exported so the 403 decision is directly unit-testable: `mountRestApp` always
 * binds 127.0.0.1, so a test driving the route over HTTP can never produce a
 * non-loopback peer. The implementation is the single shared one in
 * `@slayzone/platform` — this file, the join-token route and the hub's
 * `rest-auth` each used to carry their own copy of the same predicate.
 */
export const isLoopbackAddress = isLoopbackPeer

/** What to do with a `/api/hub/users` request, once its peer + credential are
 *  known. Same three outcomes as {@link joinTokenAuthDecision} — see its
 *  docstring for the shared reasoning; this is repeated rather than imported
 *  because the two routes live in sibling directories with no shared parent
 *  that isn't `RestApiDeps` itself. */
export type HubUsersAuthOutcome = 'allow' | 'forbid' | 'unauthorized'

/**
 * Decide whether a caller may administer hub accounts. Pure, so the off-box and
 * proxied-loopback rows are testable without a real socket.
 *
 * - auth NOT required (supervised — no sessions exist) → loopback is the sole
 *   authority, exactly as before. Off-box gets nothing to authenticate with.
 * - auth required (every standalone hub) → a bearer is required from EVERYONE,
 *   loopback included. `bearerOk` is never skipped for a loopback peer here —
 *   that unconditional skip was the bug: a reverse proxy in front of a standalone
 *   hub makes every request loopback, so it was the same as no gate at all.
 * - 401 (not 403) on a missing bearer when auth IS required: the caller has a
 *   credential problem (sign in / read the owner file), not a policy one.
 */
export function hubUsersAuthDecision(opts: {
  loopback: boolean
  authRequired: boolean
  bearerOk: boolean
}): HubUsersAuthOutcome {
  if (!opts.authRequired) return opts.loopback ? 'allow' : 'forbid'
  return opts.bearerOk ? 'allow' : 'unauthorized'
}

/** The internal identity that owns computer API keys — never operator-creatable. */
const COMPUTER_SERVICE_USER_EMAIL = 'computers@slayzone.internal'

/** Cheap shape check. Real validation is the hub operator's judgement; this only
 *  rejects input that could not possibly be an address. */
function isPlausibleEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 2 && trimmed.includes('@') && !/\s/.test(trimmed)
}

export function registerHubUsersRoutes(app: Express, deps: RestApiDeps): void {
  /**
   * Resolve the capability, or write the terminal response and return null.
   * Every method needs the identical four-step preamble (peer/bearer decision
   * first, then the same capability checks as before).
   */
  const gate = async (
    req: { socket: { remoteAddress?: string | undefined }; headers: IncomingHttpHeaders },
    res: {
      status: (code: number) => { json: (body: unknown) => void }
    }
  ): Promise<NonNullable<RestApiDeps['hubUsers']> | null> => {
    const loopback = isLoopbackAddress(req.socket.remoteAddress ?? undefined)
    const authRequired = deps.restAuth?.required() === true
    // Only verify when the answer can matter — mirrors join-token.ts. An absent
    // `restAuth` slot (the Electron host) means no bearer authority at all, which
    // collapses `authRequired` to false and this whole check to loopback-only.
    //
    // FULL ONLY: administering accounts is not a classified tRPC scope, so a
    // scoped web session must never satisfy this regardless of what its bearer
    // or cookie would otherwise resolve to.
    const principal = authRequired ? await deps.restAuth!.verifyBearer(req.headers, {}) : null
    const bearerOk = principal?.scopes.includes('full') === true
    const decision = hubUsersAuthDecision({ loopback, authRequired, bearerOk })
    if (decision === 'forbid') {
      res.status(403).json({ ok: false, error: 'hub user management is loopback-only' })
      return null
    }
    if (decision === 'unauthorized') {
      res.status(401).json({
        ok: false,
        error: 'Unauthorized — sign in with `slay hub login <url>`, or run this on the hub box'
      })
      return null
    }
    const users = deps.hubUsers
    if (!users) {
      res
        .status(503)
        .json({ ok: false, error: 'hub user management is not available on this host' })
      return null
    }
    if (!users.ready()) {
      // Not merely a startup race: hubAuthRef stays null forever if createHubAuth
      // threw (the composition root swallows that into a diagnostic), so name where
      // to look rather than implying the caller should just retry.
      res.status(503).json({
        ok: false,
        error: 'hub-auth unavailable — check the hub log for `computer.init_failed`'
      })
      return null
    }
    return users
  }

  // Create an account. Returns the generated password ONCE — it is not recoverable.
  app.post('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    const body = (req.body ?? {}) as { email?: unknown; name?: unknown }
    if (!isPlausibleEmail(body.email)) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    const email = body.email.trim()
    if (email.toLowerCase() === COMPUTER_SERVICE_USER_EMAIL) {
      res.status(400).json({
        ok: false,
        error: `${COMPUTER_SERVICE_USER_EMAIL} is reserved for the internal computer service identity`
      })
      return
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
    try {
      const result = await users.create(name === undefined ? { email } : { email, name })
      if (!result.ok) {
        res.status(409).json({ ok: false, error: 'a user with that email already exists' })
        return
      }
      res.json({ ok: true, data: result.user })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to create user',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // List accounts. Excludes the computer service identity (see users.ts).
  app.get('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    try {
      res.json({ ok: true, data: await users.list() })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to list users',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // Remove an account. Email in the BODY, not the path — see the module note.
  app.delete('/api/hub/users', async (req, res) => {
    const users = await gate(req, res)
    if (!users) return
    const body = (req.body ?? {}) as { email?: unknown }
    if (!isPlausibleEmail(body.email)) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    const email = body.email.trim()
    try {
      const outcome = await users.remove(email)
      switch (outcome) {
        case 'ok':
          res.json({ ok: true, data: { email } })
          return
        case 'not-found':
          res.status(404).json({ ok: false, error: `no user with email ${email}` })
          return
        case 'protected':
          res.status(409).json({
            ok: false,
            error:
              `${COMPUTER_SERVICE_USER_EMAIL} is the internal computer service identity — ` +
              `removing it would lock out every enrolled computer`
          })
          return
        case 'last-user':
          res.status(409).json({
            ok: false,
            error:
              'refusing to remove the last remaining account — public signup is disabled, ' +
              'so the hub would be left unauthenticatable'
          })
          return
      }
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'failed to remove user',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

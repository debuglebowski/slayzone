import type { Express } from 'express'
import type { RestApiDeps } from '../types'

/**
 * REST: `/api/hub/users` — loopback-only operator account management, backing
 * `slay hub users add|ls|rm`.
 *
 * WHY THIS EXISTS: a remote hub gates its whole surface on a better-auth bearer,
 * and public signup is CLOSED (`emailAndPassword.disableSignUp` in hub-auth's
 * auth.ts) because `/api/auth/sign-up/email` must stay gate-exempt for a
 * token-less client to reach — which had made any reachable hub
 * self-registerable. So accounts need a channel that is authoritative WITHOUT a
 * pre-existing credential. Being on the box is that authority, exactly as for
 * `POST /api/runners/join-token`: an operator SSH'd into the VPS runs `slay`, which
 * dials loopback.
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
 * Exported (unlike the join-token route's private copy) so the 403 decision is
 * directly unit-testable: `mountRestApp` always binds 127.0.0.1, so a test driving
 * the route over HTTP can never produce a non-loopback peer.
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

/** The internal identity that owns runner API keys — never operator-creatable. */
const RUNNER_SERVICE_USER_EMAIL = 'runners@slayzone.internal'

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
   * Every method needs the identical three-step preamble.
   */
  const gate = (
    req: { socket: { remoteAddress?: string | undefined } },
    res: {
      status: (code: number) => { json: (body: unknown) => void }
    }
  ): NonNullable<RestApiDeps['hubUsers']> | null => {
    if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
      res.status(403).json({ ok: false, error: 'hub user management is loopback-only' })
      return null
    }
    const users = deps.hubUsers
    if (!users) {
      res.status(503).json({ ok: false, error: 'hub user management is not available on this host' })
      return null
    }
    if (!users.ready()) {
      // Not merely a startup race: hubAuthRef stays null forever if createHubAuth
      // threw (the composition root swallows that into a diagnostic), so name where
      // to look rather than implying the caller should just retry.
      res.status(503).json({
        ok: false,
        error: 'hub-auth unavailable — check the hub log for `runner.init_failed`'
      })
      return null
    }
    return users
  }

  // Create an account. Returns the generated password ONCE — it is not recoverable.
  app.post('/api/hub/users', async (req, res) => {
    const users = gate(req, res)
    if (!users) return
    const body = (req.body ?? {}) as { email?: unknown; name?: unknown }
    if (!isPlausibleEmail(body.email)) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    const email = body.email.trim()
    if (email.toLowerCase() === RUNNER_SERVICE_USER_EMAIL) {
      res.status(400).json({
        ok: false,
        error: `${RUNNER_SERVICE_USER_EMAIL} is reserved for the internal runner service identity`
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

  // List accounts. Excludes the runner service identity (see users.ts).
  app.get('/api/hub/users', async (req, res) => {
    const users = gate(req, res)
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
    const users = gate(req, res)
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
              `${RUNNER_SERVICE_USER_EMAIL} is the internal runner service identity — ` +
              `removing it would lock out every enrolled runner`
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

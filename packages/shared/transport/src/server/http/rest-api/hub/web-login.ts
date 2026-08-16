import type { Express } from 'express'
import type { RestApiDeps } from '../types'

/**
 * REST: `POST /api/auth/web-login` — the web app's scoped sign-in.
 *
 * WHY THIS ROUTE EXISTS, RATHER THAN REUSING better-auth's OWN
 * `/api/auth/sign-in/email`: that route returns a FULL session — exactly the
 * credential a browser must never hold, per `web-sessions.ts`'s design. This
 * route calls the SAME check server-side, discards its result, and hands the
 * browser a scoped `web_sessions` token instead, set as an `HttpOnly` cookie
 * so client-side JS never touches it either.
 *
 * GATE-EXEMPT, deliberately: a browser with no credential at all must be able
 * to reach this route to obtain one — it is listed in `rest-auth.ts`'s
 * `AUTH_BOOTSTRAP_PATHS` alongside better-auth's own sign-in/sign-out/
 * get-session. Unlike those three, this path is OURS, not better-auth's, so
 * keeping it working is this file's job, not a dependency's.
 *
 * CAPABILITY-GATED like `hub/users.ts` and `computers/join-token.ts`: the
 * `deps.webLogin` slot is wired only by the hub composition root and is
 * absent on a build with no hub-auth — the route 503s rather than throws.
 */
export function registerWebLoginRoute(app: Express, deps: RestApiDeps): void {
  app.post('/api/auth/web-login', async (req, res) => {
    const webLogin = deps.webLogin
    if (!webLogin) {
      res.status(503).json({ ok: false, error: 'web login is not available on this host' })
      return
    }
    const body = (req.body ?? {}) as { email?: unknown; password?: unknown }
    if (typeof body.email !== 'string' || !body.email.trim()) {
      res.status(400).json({ ok: false, error: 'email required' })
      return
    }
    if (typeof body.password !== 'string' || !body.password) {
      res.status(400).json({ ok: false, error: 'password required' })
      return
    }
    try {
      const result = await webLogin.login(body.email.trim(), body.password)
      if (!result.ok) {
        // Deliberately the SAME message/status for "no such account" and
        // "wrong password" — better-auth itself already declines to
        // distinguish these, and unwrapping a different answer here would
        // leak account existence through a side channel it closed.
        res.status(401).json({ ok: false, error: 'invalid email or password' })
        return
      }
      // HttpOnly: client-side JS never sees the token. Secure: never sent over
      // plaintext http — this cookie is meaningless (and unsafe) on anything
      // but a TLS-terminated origin, which is exactly what a browser-served
      // hub requires. SameSite=Lax (not Strict): a link from Slack/email must
      // still land signed in; the CSRF control is the request's Origin, not
      // this attribute — see the future REST-side origin check this pairs
      // with (ws-origin.ts already does the WS half).
      res.setHeader(
        'Set-Cookie',
        `${result.cookieName}=${result.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${result.maxAgeSec}`
      )
      // The token is ALSO returned in the body, for a client that keeps its
      // own tRPC WS connection (which authenticates via `connectionParams`,
      // not a cookie) — see `resolveConnectionPrincipal`'s web-session branch.
      // Returning it here is not a leak beyond the cookie: both channels
      // exist specifically so this SAME browser tab can use either transport
      // with the one credential it was just handed.
      res.json({ ok: true, token: result.token })
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: 'login failed',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  })
}

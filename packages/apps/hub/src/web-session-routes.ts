/**
 * The web shell's session routes (T-13), beside its two sign-ins (`/api/auth/web-login`
 * with a password, `/api/auth/web-sso` through Entra):
 *
 *   - `POST /api/auth/web-session` → `{ ok: true, signedIn }`. The shell cannot read its
 *     HttpOnly cookie; this is how it chooses between the sign-in screen and the app. A
 *     cookie that no longer resolves is cleared.
 *   - `POST /api/auth/web-logout` → `{ ok: true }`. Revokes the browser's `web_sessions`
 *     row (one `auth.web_session.revoke` line, as its user), ends any better-auth session
 *     the browser holds, clears both cookies, and closes the `/trpc` sockets that rode
 *     the session.
 *
 * Both act only on the cookie the request carries, so neither needs a bearer (they are
 * on rest-auth.ts's bootstrap allowlist, as better-auth's `sign-out` is). Both answer
 * only to the hub's own page: `Origin` is checked exactly as for a `/trpc` socket that
 * authenticates by the cookie (ws-origin.ts `cookieOriginDecision`), so "signed in" here
 * always means the shell's socket will be signed in too — no reload loop between the
 * two. POST, so the browser always sends that `Origin`.
 *
 * SIGN-OUT AND THE OTHER SESSIONS. better-auth's: web sign-in already ends the one it
 * made, but a device approval (T-14) in the same browser leaves one — signing out ends
 * it as well, so a signed-out browser holds no hub credential at all. Entra's own
 * session is NOT ended: it is Microsoft's single sign-on for every app the person uses,
 * not the hub's to end; the next "Sign in with Microsoft" may complete without a prompt.
 *
 * Wired only on a hub that requires login (server.ts); elsewhere these paths fall
 * through to better-auth's 404 as before.
 *
 * @module hub/web-session-routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import { cookieOnlyHeaders, type HubAuth } from '@slayzone/hub-auth/server'
import { parseCookieHeader } from './rest-auth'
import {
  clearWebSessionCookie,
  isWebSessionToken,
  resolveWebSession,
  revokeWebSessionToken,
  WEB_LOGOUT_PATH,
  WEB_SESSION_COOKIE_NAME,
  WEB_SESSION_STATUS_PATH
} from './web-sessions'

export interface WebSessionRoutesOptions {
  getAuth: () => HubAuth | null
  db: SlayzoneDb
  /** The cookie's `Secure` flag (`webSessionCookieSecure`), so the clearing cookie matches. */
  secureCookie: boolean
  /** Is the request's `Origin` the hub's own page (`cookieOriginDecision`)? */
  isCookieOriginAllowed: (req: IncomingMessage) => boolean
  /** After a sign-out: close the sockets whose session ended (trpc-connections). */
  onSignedOut?: () => void
}

interface SignOutApi {
  signOut(input: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>
}

/** End the better-auth session the browser's cookie names, if any: its clearing cookies. */
async function endBetterAuthSession(auth: HubAuth | null, req: IncomingMessage): Promise<string[]> {
  if (!auth) return []
  const ctx = await auth.$context
  if (!parseCookieHeader(req.headers)[ctx.authCookies.sessionToken.name]) return []
  try {
    const api = auth.api as unknown as SignOutApi
    return (
      await api.signOut({ headers: cookieOnlyHeaders(req), returnHeaders: true })
    ).headers.getSetCookie()
  } catch {
    return []
  }
}

/**
 * The route handler. Returns true when it took the request, so the hub's dispatcher
 * stops there.
 */
export function createWebSessionRoutes(
  opts: WebSessionRoutesOptions
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const clear = clearWebSessionCookie({ secure: opts.secureCookie })

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    cookies: string[] = []
  ): void => {
    if (res.headersSent) return
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(cookies.length > 0 ? { 'set-cookie': cookies } : {})
    })
    res.end(JSON.stringify(body))
  }

  const status = async (res: ServerResponse, token: string | null): Promise<void> => {
    const principal = token ? await resolveWebSession(opts.getAuth(), opts.db, token) : null
    send(res, 200, { ok: true, signedIn: principal !== null }, token && !principal ? [clear] : [])
  }

  const logout = async (req: IncomingMessage, res: ServerResponse, token: string | null) => {
    if (token) await revokeWebSessionToken(opts.db, token)
    send(res, 200, { ok: true }, [clear, ...(await endBetterAuthSession(opts.getAuth(), req))])
    opts.onSignedOut?.()
  }

  return (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== WEB_SESSION_STATUS_PATH && path !== WEB_LOGOUT_PATH) return false
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
      return true
    }
    if (!opts.isCookieOriginAllowed(req)) {
      const origin = req.headers.origin
      securityEvent({
        event: 'authz.denied',
        outcome: 'denied',
        actor: null,
        detail: {
          reason: 'origin',
          status: 403,
          origin: typeof origin === 'string' ? origin : null
        }
      })
      send(res, 403, { ok: false, error: "must be sent from the hub's own page" })
      return true
    }
    const cookie = parseCookieHeader(req.headers)[WEB_SESSION_COOKIE_NAME]
    const token = cookie && isWebSessionToken(cookie) ? cookie : null
    const work = path === WEB_SESSION_STATUS_PATH ? status(res, token) : logout(req, res, token)
    work.catch(() => send(res, 500, { ok: false, error: 'failed' }))
    return true
  }
}

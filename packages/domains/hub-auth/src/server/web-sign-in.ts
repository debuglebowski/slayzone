/**
 * The web shell's sign-in on an Entra hub (T-13): `GET /api/auth/web-sso`, where the
 * shell's "Sign in with Microsoft" button goes.
 *
 * FLOW. The browser holds no fresh Entra session → 302 to Entra the way the device page
 * does (./sso-page.ts), back to `?return=1`. Entra → better-auth's callback (T-09's
 * checks; it sets a better-auth session cookie) → here again. Then the hub mints the
 * browser's SCOPED web session (`opts.mint`: a `web_sessions` row and its HttpOnly
 * cookie, hub `web-sessions.ts`), ends the better-auth session the callback made, and
 * 302s to the shell at `/`.
 *
 * WHY END THE BETTER-AUTH SESSION. It is a `full` credential, and a browser must never
 * hold one (hub `web-sessions.ts`): it only proved who the person is. The scoped
 * session is what the browser keeps — the Entra twin of `webLogin` discarding the full
 * session `signInEmail` made.
 *
 * FRESH. Only a session made in the last {@link WEB_SIGN_IN_FRESH_MS} counts; an older
 * one (a device approval yesterday) is sent through Entra again. So every web session
 * follows an Entra sign-in with MFA by minutes, and its 7-day lifetime counts from it.
 *
 * NO LOOP. The return leg never goes to Entra again: a sign-in that failed, or left no
 * usable session, lands on `/?signin=failed&reason=…` and the shell says so.
 *
 * CSRF. A plain GET, like the device page's: a forged request can only make a browser
 * sign in as the person whose Entra session that browser holds — better-auth's state
 * cookie binds the callback to the browser that started the flow.
 *
 * @module hub-auth/web-sign-in
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { runAsSecurityActor } from '@slayzone/platform/security-log'
import type { HubAuth } from './auth'
import { cookieOnlyHeaders, redirectToEntraSignIn, ssoSessionFromCookie } from './sso-page'

/** The sign-in route. Under `/api/auth/` but the hub's, not better-auth's. */
export const WEB_SIGN_IN_PATH = '/api/auth/web-sso'

/** How old the browser's Entra session may be and still mint a web session. */
export const WEB_SIGN_IN_FRESH_MS = 5 * 60_000

/** The web shell, where the browser goes back to (signed in, or `?signin=failed`). */
const SHELL_PATH = '/'

/** What a failed sign-in's `reason` may carry back to the shell (better-auth's codes). */
const REASON = /^[A-Za-z0-9_]{1,64}$/

export interface WebSignInOptions {
  /**
   * Mint the browser's web session for a signed-in account; returns its `Set-Cookie`
   * values. `req` is the browser's request, carrying the web-session cookie it may still
   * hold — the hub revokes the session it replaces.
   */
  mint: (userId: string, req: IncomingMessage) => Promise<string[]>
  /** Test seam: the clock. */
  now?: () => number
}

interface SignOutApi {
  signOut(input: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>
}

/**
 * The route handler. Returns true when it took the request (`/api/auth/web-sso`), so the
 * hub's dispatcher stops there.
 */
export function createWebSignIn(
  auth: HubAuth,
  opts: WebSignInOptions
): (req: IncomingMessage, res: ServerResponse) => boolean {
  const now = opts.now ?? Date.now
  const api = auth.api as unknown as SignOutApi

  const redirect = (res: ServerResponse, location: string, cookies: string[] = []): void => {
    if (res.headersSent) return
    res.writeHead(302, {
      location,
      ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}),
      'cache-control': 'no-store',
      'referrer-policy': 'same-origin'
    })
    res.end()
  }

  const failed = (res: ServerResponse, reason: string | null): void => {
    const safe = reason && REASON.test(reason) ? reason : 'signin_failed'
    redirect(res, `${SHELL_PATH}?signin=failed&reason=${safe}`)
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const returning = url.searchParams.get('return') === '1'
    if (returning && (url.searchParams.has('signin') || url.searchParams.has('error'))) {
      failed(res, url.searchParams.get('error'))
      return
    }
    const headers = cookieOnlyHeaders(req)
    const session = await ssoSessionFromCookie(auth, headers)
    if (!session || now() - session.createdAt > WEB_SIGN_IN_FRESH_MS) {
      if (returning) {
        failed(res, 'no_session')
        return
      }
      await redirectToEntraSignIn(auth, res, headers, {
        callbackURL: `${WEB_SIGN_IN_PATH}?return=1`,
        errorCallbackURL: `${WEB_SIGN_IN_PATH}?return=1&signin=failed`
      })
      return
    }
    const cookies = await runAsSecurityActor(session.userId, () => opts.mint(session.userId, req))
    let cleared: string[] = []
    try {
      cleared = (await api.signOut({ headers, returnHeaders: true })).headers.getSetCookie()
    } catch {
      // The web session stands; the better-auth session then ends at its own expiry.
    }
    redirect(res, SHELL_PATH, [...cookies, ...cleared])
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub.invalid')
    if (url.pathname !== WEB_SIGN_IN_PATH) return false
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return true
    }
    handle(req, res, url).catch(() => failed(res, 'server_error'))
    return true
  }
}

/**
 * What the hub's Entra browser pages share: device sign-in's approval page (T-14,
 * ./device-page.ts) and the web shell's sign-in (T-13, ./web-sign-in.ts).
 *
 * The browser's session is its better-auth COOKIE (never a bearer), made by an Entra
 * sign-in that passed T-09's checks (tenant, app role, `amr` ∋ `mfa`) for an account
 * that is not disabled. Anything short of that is sent through Entra again, by
 * better-auth's own `sign-in/social` (state cookie + PKCE), in process.
 *
 * @module hub-auth/sso-page
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDisabled } from './account'
import type { HubAuth } from './auth'
import { SIGN_IN_METHOD } from './device'
import { ENTRA_PROVIDER_ID } from './entra'

/** Only the cookie: a page never accepts a bearer as the browser's session. */
export function cookieOnlyHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  if (typeof req.headers.cookie === 'string') headers.set('cookie', req.headers.cookie)
  return headers
}

/** The browser's Entra-made better-auth session. */
export interface SsoBrowserSession {
  userId: string
  email: string
  /** When the session was made (ms) — when that Entra sign-in completed. */
  createdAt: number
}

const toMs = (v: unknown): number =>
  v instanceof Date ? v.getTime() : new Date(String(v ?? '')).getTime()

/**
 * The browser's better-auth session from `headers`' cookie, when an Entra sign-in that
 * passed the checks made it (`session.signInMethod === 'sso'`) and its account is not
 * disabled. Null otherwise: no session, a password (break-glass) session, a device
 * token's session, a disabled account.
 */
export async function ssoSessionFromCookie(
  auth: HubAuth,
  headers: Headers
): Promise<SsoBrowserSession | null> {
  const found = await auth.api.getSession({ headers })
  const session = found?.session as Record<string, unknown> | undefined
  const user = found?.user as (Record<string, unknown> & { id: string; email: string }) | undefined
  if (!session || !user || session.signInMethod !== SIGN_IN_METHOD.sso || isDisabled(user)) {
    return null
  }
  return { userId: user.id, email: user.email, createdAt: toMs(session.createdAt) }
}

interface SignInSocialApi {
  signInSocial(input: {
    body: Record<string, unknown>
    headers: Headers
    returnHeaders: true
  }): Promise<{ headers: Headers; response: { url?: string } }>
}

/**
 * 302 the browser to Entra through better-auth's `sign-in/social`, which sets the state
 * cookie. Entra returns it to better-auth's callback, which redirects to `callbackURL`
 * on success and to `errorCallbackURL` (with `error=…` appended) on failure. Both are
 * paths on the hub.
 */
export async function redirectToEntraSignIn(
  auth: HubAuth,
  res: ServerResponse,
  headers: Headers,
  urls: { callbackURL: string; errorCallbackURL: string }
): Promise<void> {
  const api = auth.api as unknown as SignInSocialApi
  const { headers: set, response } = await api.signInSocial({
    body: {
      provider: ENTRA_PROVIDER_ID,
      callbackURL: urls.callbackURL,
      errorCallbackURL: urls.errorCallbackURL,
      disableRedirect: true
    },
    headers,
    returnHeaders: true
  })
  if (!response.url) throw new Error('[hub-auth] Entra sign-in returned no URL')
  res.writeHead(302, {
    location: response.url,
    'set-cookie': set.getSetCookie(),
    'cache-control': 'no-store',
    'referrer-policy': 'same-origin'
  })
  res.end()
}

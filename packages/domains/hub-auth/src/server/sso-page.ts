/**
 * What the hub's Entra browser pages share: device sign-in's approval page (T-14,
 * ./device-page.ts), the web shell's sign-in (T-13, ./web-sign-in.ts) and the app
 * sign-in's confirm page (./app-sign-in.ts).
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
  urls: { callbackURL: string; errorCallbackURL: string },
  /** More `Set-Cookie` values for the same response (the app sign-in's flow cookie). */
  extraCookies: readonly string[] = []
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
    'set-cookie': [...set.getSetCookie(), ...extraCookies],
    'cache-control': 'no-store',
    'referrer-policy': 'same-origin'
  })
  res.end()
}

/** Text for HTML (element content and quoted attribute values). */
export const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )

/**
 * Send one of the hub's Entra pages: no script, nothing loaded, one inline `<style>`
 * (passes the web shell's `style-src 'unsafe-inline'`). `formAction` is the page's
 * CSP `form-action` source list — where its forms post AND where their responses may
 * redirect (Chrome applies it to the redirect after a POST).
 */
export function sendHubPage(
  res: ServerResponse,
  page: { status: number; title: string; body: string; formAction: string }
): void {
  if (res.headersSent) return
  res.writeHead(page.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `form-action ${page.formAction}`,
      "base-uri 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin'
  })
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${escapeHtml(page.title)}</title><style>` +
      'body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}' +
      'code{font-size:1.4em;letter-spacing:.1em}form{display:inline-block;margin:0 .5rem 0 0}' +
      'button{font:inherit;padding:.4rem 1.2rem}.warn{border-left:3px solid;padding-left:.8rem}' +
      `</style></head><body><h1>${escapeHtml(page.title)}</h1>${page.body}</body></html>`
  )
}

/**
 * A page form's body (`application/x-www-form-urlencoded`, at most `maxBytes`), or
 * null: another type, or too large (reading stops at the cap).
 */
export async function readUrlEncodedForm(
  req: IncomingMessage,
  maxBytes: number
): Promise<URLSearchParams | null> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
  if (type !== 'application/x-www-form-urlencoded') return null
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) return null
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * CSRF guard of a page's cookie-authenticated form POST: the request must carry an
 * `Origin` the hub trusts (its public address, `SLAYZONE_HUB_ALLOWED_WEB_ORIGINS`). A
 * missing or `null` Origin is refused, exactly as better-auth refuses one on its own
 * cookie routes. Null when the Origin passes, else why not (the audit line's reason).
 */
export async function formOriginRefusal(
  auth: HubAuth,
  req: IncomingMessage
): Promise<'missing_origin' | 'untrusted_origin' | null> {
  const ctx = await auth.$context
  const origin = req.headers.origin
  if (typeof origin !== 'string' || !origin) return 'missing_origin'
  return origin !== 'null' && ctx.isTrustedOrigin(origin) ? null : 'untrusted_origin'
}

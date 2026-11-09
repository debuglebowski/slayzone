/**
 * Test support for OTHER packages (the hub's IdP-role tests): the local generic OpenID
 * issuer and a sign-in helper that runs the real code flow against a hub-auth instance.
 * Never imported by product code.
 *
 * @module hub-auth/testing
 */
import { OIDC_PROVIDER_ID } from './entra'
import {
  type IssuedClaims,
  FakeOidcIssuer,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET
} from './fake-oidc-issuer'
import type { HubAuth } from './auth'
import { withIssuanceBinding } from './idp-roles'

export { FakeOidcIssuer, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, type IssuedClaims }

const cookieHeader = (cookies: string[]): string => cookies.map((c) => c.split(';')[0]).join('; ')

/**
 * The browser round trip through `issuer` as one person with `claims`, against
 * `auth.handler` (base URL `baseURL`). Returns the session cookie header, or the
 * better-auth error code when the sign-in was refused.
 */
export async function signInThroughFakeIssuer(
  auth: HubAuth,
  issuer: FakeOidcIssuer,
  baseURL: string,
  claims: IssuedClaims
): Promise<{ error: string | null; cookie: string; sessionToken: string | null }> {
  const start = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: OIDC_PROVIDER_ID, callbackURL: '/' })
    })
  )
  const url = new URL(((await start.json()) as { url: string }).url)
  const code = issuer.issueCode(url, claims)
  const res = await auth.handler(
    new Request(
      `${baseURL}/api/auth/callback/${OIDC_PROVIDER_ID}?code=${code}&state=${url.searchParams.get('state')}`,
      { headers: { cookie: cookieHeader(start.headers.getSetCookie()) } }
    )
  )
  const cookies = res.headers.getSetCookie()
  const cookie = cookieHeader(cookies)
  const token = /session_token=([^;.]+)/.exec(cookie)?.[1] ?? null
  return {
    error: new URL(res.headers.get('location') ?? '/', baseURL).searchParams.get('error'),
    cookie,
    sessionToken: token ? decodeURIComponent(token) : null
  }
}

/**
 * A CLI/app-style bearer for `userId`, minted as an approved device or app code mints
 * one: through the adapter (its hooks run) and bound to the SSO authentication at
 * `authAtMs` (default: the account's current grant). Refused like the real flows.
 */
export async function mintBoundBearer(
  auth: HubAuth,
  userId: string,
  authAtMs?: number
): Promise<string> {
  const ctx = await auth.$context
  const user = (await ctx.internalAdapter.findUserById(userId)) as Record<string, unknown> | null
  const granted = typeof user?.idpGrantedAt === 'number' ? user.idpGrantedAt : Date.now()
  return withIssuanceBinding(
    { authAtMs: authAtMs ?? granted },
    async () => (await ctx.internalAdapter.createSession(userId)).token
  )
}

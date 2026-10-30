/**
 * App sign-in through Microsoft (native apps, PKCE) against a REAL better-auth instance
 * with Entra sign-in and the local fake Entra (fake-entra-harness.ts), served over HTTP
 * the way the hub serves it: the app sign-in routes first, other `/api/auth/*` →
 * better-auth. The browser is a cookie jar that follows redirects by hand; the app half
 * is the shared client (`../client/app-sign-in.ts`) over a fetch transport.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_SIGN_IN_PATHS,
  APP_SIGN_IN_REDIRECT_URI,
  exchangeAppSignInCode,
  type PendingAppSignIn,
  type PkceCrypto,
  readAppSignInCallback,
  startAppSignIn
} from '../client/app-sign-in'
import { createFetchHubTransport } from '../client/transport'
import { createAuthExpressApp } from './app'
import {
  APP_CODE_TTL_MS,
  APP_FLOW_COOKIE,
  APP_REDIRECT_URIS,
  APP_SIGN_IN_CONFIRM_PATH,
  APP_SIGN_IN_PATH,
  APP_SIGN_IN_TOKEN_PATH,
  createAppSignIn
} from './app-sign-in'
import { createHubAuth, type HubAuth } from './auth'
import { ENTRA_PROVIDER_ID, loadEntraClientCredential } from './entra'
import { CLIENT_ID, type Claims, FakeEntra, TENANT, writeHubCredential } from './fake-entra-harness'
import { createHubUser, disableHubUser } from './users'

const SECRET = 'hub-auth-app-sign-in-test-secret-at-least-32'
const MFA: Claims = { oid: 'ada', amr: ['pwd', 'mfa'] }

const nodeCrypto: PkceCrypto = {
  getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
  sha256: (data) => webcrypto.subtle.digest('SHA-256', data)
}

let tmpDir: string
let entra: FakeEntra
let credentialPaths: { certPath: string; keyPath: string }
let auth: HubAuth
let server: Server
let base: string
let audit: Array<Record<string, unknown>>
let clock: number

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-app-sign-in-test-'))
  const credential = await writeHubCredential(tmpDir)
  credentialPaths = { certPath: credential.certPath, keyPath: credential.keyPath }
  entra = new FakeEntra(credential.certPem)
  await entra.start()
})

afterAll(async () => {
  await entra.stop()
  rmSync(tmpDir, { recursive: true, force: true })
})

let dbCounter = 0

async function serve(opts: { maxPendingCodes?: number } = {}): Promise<void> {
  server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  auth = await createHubAuth({
    dbPath: join(tmpDir, `auth-${++dbCounter}.sqlite`),
    baseURL: base,
    secret: SECRET,
    sso: {
      tenantId: TENANT,
      clientId: CLIENT_ID,
      credential: loadEntraClientCredential(credentialPaths),
      requireMfa: true,
      authority: entra.authority
    }
  })
  const authApp = createAuthExpressApp(auth)
  const appSignIn = createAppSignIn(auth, { secureCookie: false, ...opts })
  server.on('request', (req, res) => {
    if (appSignIn(req, res)) return
    if ((req.url ?? '').startsWith('/api/auth/')) authApp(req, res)
    else res.writeHead(404).end()
  })
}

beforeEach(async () => {
  clock = Date.now()
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
  await serve()
})

afterEach(async () => {
  vi.useRealTimers()
  setSecurityLogSink()
  await new Promise<void>((r) => server.close(() => r()))
})

const advance = (ms: number): void => {
  clock += ms
  vi.setSystemTime(clock)
}

class Browser {
  readonly jar = new Map<string, string>()

  store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const eq = pair!.indexOf('=')
      const value = pair!.slice(eq + 1)
      if (/max-age=0/i.test(c) || value === '') this.jar.delete(pair!.slice(0, eq))
      else this.jar.set(pair!.slice(0, eq), value)
    }
  }

  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(new URL(path, base), {
      headers: this.jar.size ? { cookie: this.cookie } : {},
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  async post(path: string, form: Record<string, string>, origin: string | null): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: this.cookie
    }
    if (origin) headers.origin = origin
    const res = await fetch(new URL(path, base), {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  betterAuthCookie(): string | undefined {
    return [...this.jar.keys()].find((k) => k.endsWith('session_token'))
  }
}

const locationOf = (res: Response): string => res.headers.get('location') ?? ''

/** The app opens the start URL; the person signs in at Entra; back on the confirm page. */
async function toConfirmPage(
  browser: Browser,
  claims: Claims = MFA
): Promise<{ pending: PendingAppSignIn; page: Response }> {
  const pending = await startAppSignIn(base, nodeCrypto)
  const start = await browser.get(pending.url)
  expect(start.status, 'start → Entra').toBe(302)
  const authorize = new URL(locationOf(start))
  expect(authorize.origin).toBe(entra.authority)
  const code = entra.issueCode(authorize, claims)
  const callback = await browser.get(
    `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${authorize.searchParams.get('state')}`
  )
  expect(callback.status, 'callback redirects').toBe(302)
  const page = await browser.get(locationOf(callback))
  return { pending, page }
}

/** All the way to the redirect into the app (Continue on the confirm page). */
async function toAppRedirect(
  browser: Browser,
  claims: Claims = MFA
): Promise<{ pending: PendingAppSignIn; redirect: string }> {
  const { pending, page } = await toConfirmPage(browser, claims)
  expect(page.status, `confirm page: ${await page.clone().text()}`).toBe(200)
  const confirm = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'continue' }, base)
  expect(confirm.status, 'confirm → app').toBe(302)
  return { pending, redirect: locationOf(confirm) }
}

const transport = createFetchHubTransport(fetch)

async function codeFor(
  browser = new Browser()
): Promise<{ pending: PendingAppSignIn; code: string }> {
  const { pending, redirect } = await toAppRedirect(browser)
  const callback = readAppSignInCallback(redirect, pending)
  if (!callback.ok) throw new Error(`no code: ${redirect}`)
  return { pending, code: callback.code }
}

const exchange = (code: string, verifier: string, redirectUri = APP_SIGN_IN_REDIRECT_URI) =>
  fetch(`${base}${APP_SIGN_IN_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri })
  })

const sessionOf = async (token: string) =>
  auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) })

const events = (): string[] =>
  audit.map((l) => {
    const method = (l.detail as { method?: string } | undefined)?.method
    return `${l.event}:${l.outcome}${method ? `:${method}` : ''}`
  })

describe('the routes', () => {
  it('the client and the hub agree on the paths and the redirect', () => {
    expect(APP_SIGN_IN_PATHS.start).toBe(APP_SIGN_IN_PATH)
    expect(APP_SIGN_IN_PATHS.token).toBe(APP_SIGN_IN_TOKEN_PATH)
    expect(APP_REDIRECT_URIS).toContain(APP_SIGN_IN_REDIRECT_URI)
  })

  it('takes only its own exact paths', async () => {
    const other = await fetch(`${base}${APP_SIGN_IN_PATH}/other`, { redirect: 'manual' })
    expect(other.status, 'falls through to better-auth').toBe(404)
    const post = await fetch(`${base}${APP_SIGN_IN_PATH}`, { method: 'POST', redirect: 'manual' })
    expect(post.status).toBe(405)
    const getToken = await fetch(`${base}${APP_SIGN_IN_TOKEN_PATH}`)
    expect(getToken.status).toBe(405)
    const getConfirm = await fetch(`${base}${APP_SIGN_IN_CONFIRM_PATH}`)
    expect(getConfirm.status).toBe(405)
  })
})

describe('app sign-in: the whole flow', () => {
  it('start: 302 to Entra with the hub callback; flow cookie bound to this browser', async () => {
    const browser = new Browser()
    const pending = await startAppSignIn(base, nodeCrypto)
    const start = await browser.get(pending.url)
    expect(start.status).toBe(302)
    const authorize = new URL(locationOf(start))
    expect(authorize.origin).toBe(entra.authority)
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${base}/api/auth/callback/${ENTRA_PROVIDER_ID}`
    )
    expect(start.headers.get('cache-control')).toBe('no-store')
    const flow = start.headers.getSetCookie().find((c) => c.startsWith(`${APP_FLOW_COOKIE}=`))
    expect(flow).toBeDefined()
    expect(flow).toMatch(/; HttpOnly/i)
    expect(flow).toMatch(/; SameSite=Lax/i)
    expect(flow).toMatch(/; Path=\/api\/auth\/app-sso(;|$)/)
    expect(flow).toMatch(/; Max-Age=600/i)
    expect(flow).not.toMatch(/; Secure/i)
    // Nothing secret in the flow cookie: the challenge and state are no secrets, the
    // verifier never reaches the hub before the exchange.
    expect(flow).not.toContain(pending.verifier)
  })

  it('a Secure flow cookie on an https hub', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const handler = createAppSignIn(auth, { secureCookie: true })
    server.on('request', (req, res) => {
      if (!handler(req, res)) res.writeHead(404).end()
    })
    const port = (server.address() as AddressInfo).port
    const pending = await startAppSignIn(base, nodeCrypto)
    const start = await fetch(pending.url.replace(base, `http://127.0.0.1:${port}`), {
      redirect: 'manual'
    })
    const flow = start.headers.getSetCookie().find((c) => c.startsWith(`${APP_FLOW_COOKIE}=`))
    expect(flow).toMatch(/; Secure/i)
  })

  it('confirm page → code in the app → token: the same kind of session password sign-in gives', async () => {
    const browser = new Browser()
    const { pending, page } = await toConfirmPage(browser)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('ada@normain.test')
    expect(html).toContain(new URL(base).host)
    expect(html).toContain('SlayZone app')
    expect(/<script/i.test(html), 'no script').toBe(false)
    const csp = page.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("form-action 'self' slayzone:")
    expect(page.headers.get('cache-control')).toBe('no-store')
    const fullSession = `${browser.betterAuthCookie()}=${browser.jar.get(browser.betterAuthCookie()!)}`

    const confirm = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'continue' }, base)
    expect(confirm.status).toBe(302)
    const redirect = locationOf(confirm)
    expect(redirect.startsWith(`${APP_SIGN_IN_REDIRECT_URI}?code=`)).toBe(true)
    const callback = readAppSignInCallback(redirect, pending)
    expect(callback.ok, redirect).toBe(true)
    if (!callback.ok) return
    expect(callback.code).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // The browser keeps nothing: its better-auth session ended, the flow cookie cleared.
    expect(browser.betterAuthCookie()).toBeUndefined()
    expect(browser.jar.has(APP_FLOW_COOKIE)).toBe(false)
    expect(await auth.api.getSession({ headers: new Headers({ cookie: fullSession }) })).toBe(null)

    const result = await exchangeAppSignInCode(transport, base, {
      code: callback.code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri
    })
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    const session = await sessionOf(result.token)
    expect(session?.user.email).toBe('ada@normain.test')
    expect((session!.session as { signInMethod?: string }).signInMethod).toBe('app')

    expect(events()).toEqual(
      expect.arrayContaining([
        'auth.signin:success:sso',
        'auth.app_sso.code:success',
        'auth.signin:success:app'
      ])
    )
    const all = JSON.stringify(audit)
    for (const secret of [callback.code, pending.verifier, result.token]) {
      expect(all, 'no code, verifier or token in the audit').not.toContain(secret)
    }
    const refOf = (event: string, method?: string): string | undefined => {
      const line = audit.find(
        (l) =>
          l.event === event &&
          (method === undefined || (l.detail as { method?: string }).method === method)
      )
      return (line?.detail as { requestRef?: string } | undefined)?.requestRef
    }
    expect(refOf('auth.app_sso.code')).toMatch(/^[0-9a-f]{16}$/)
    expect(refOf('auth.signin', 'app')).toBe(refOf('auth.app_sso.code'))
  })
})

describe('the code: single use, short-lived, bound to the challenge and the redirect', () => {
  it('a replayed code is refused, and the session it minted is revoked', async () => {
    const { pending, code } = await codeFor()
    const first = await exchange(code, pending.verifier)
    expect(first.status).toBe(200)
    const token = ((await first.json()) as { token: string }).token
    expect(await sessionOf(token)).not.toBe(null)

    const again = await exchange(code, pending.verifier)
    expect(again.status).toBe(400)
    expect(await again.json()).toEqual({ error: 'invalid_grant', code: 'CODE_INVALID' })
    expect(await sessionOf(token), 'the first session is revoked').toBe(null)
    expect(events()).toContain('auth.app_sso.replay:denied')
  })

  it('a wrong verifier is refused and burns the code', async () => {
    const { pending, code } = await codeFor()
    const other = (await startAppSignIn(base, nodeCrypto)).verifier
    const wrong = await exchange(code, other)
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toEqual({ error: 'invalid_grant', code: 'CODE_INVALID' })
    const right = await exchange(code, pending.verifier)
    expect(right.status, 'used once is used').toBe(400)
    expect(
      audit.some((l) => (l.detail as { reason?: string })?.reason === 'verifier_mismatch')
    ).toBe(true)
  })

  it(`an expired code (older than ${APP_CODE_TTL_MS / 1000} s) is refused as expired`, async () => {
    const { pending, code } = await codeFor()
    advance(APP_CODE_TTL_MS + 1)
    const res = await exchange(code, pending.verifier)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_grant', code: 'CODE_EXPIRED' })
    const result = await exchangeAppSignInCode(transport, base, {
      code,
      verifier: pending.verifier,
      redirectUri: pending.redirectUri
    })
    expect(result).toMatchObject({ ok: false, reason: 'refused', code: 'CODE_INVALID' })
  })

  it('a code not yet expired works', async () => {
    const { pending, code } = await codeFor()
    advance(APP_CODE_TTL_MS - 1_000)
    expect((await exchange(code, pending.verifier)).status).toBe(200)
  })

  it('another redirect at the exchange is refused', async () => {
    const { pending, code } = await codeFor()
    const res = await exchange(code, pending.verifier, 'slayzone://auth/other')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_grant', code: 'CODE_INVALID' })
  })

  it('an unknown code is refused', async () => {
    const res = await exchange('A'.repeat(43), 'B'.repeat(43))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_grant', code: 'CODE_INVALID' })
  })

  it('a malformed exchange is invalid_request', async () => {
    for (const body of [
      'not json',
      JSON.stringify({ code: 'x' }),
      JSON.stringify({
        code: 'A'.repeat(43),
        code_verifier: 'short',
        redirect_uri: APP_SIGN_IN_REDIRECT_URI
      }),
      JSON.stringify([1])
    ]) {
      const res = await fetch(`${base}${APP_SIGN_IN_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body
      })
      expect(res.status, body).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
    }
    const form = await fetch(`${base}${APP_SIGN_IN_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=x'
    })
    expect(form.status).toBe(400)
  })

  it('an oversized exchange body is refused', async () => {
    const res = await fetch(`${base}${APP_SIGN_IN_TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'x'.repeat(10_000) })
    })
    expect(res.status).toBe(413)
  })

  it('an account disabled between the code and the exchange gets no session', async () => {
    const { pending, code } = await codeFor()
    // Not the hub's last account (users.ts refuses to disable that one).
    const other = await createHubUser(auth, { email: 'ops@normain.test', name: 'Ops' })
    if ('error' in other) throw new Error(`createHubUser: ${other.error}`)
    expect(await disableHubUser(auth, 'ada@normain.test')).toBe('ok')
    const res = await exchange(code, pending.verifier)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'access_denied', code: 'ACCOUNT_DISABLED' })
  })

  it('at most maxPendingCodes live codes; then the app is told to retry later', async () => {
    await new Promise<void>((r) => server.close(() => r()))
    await serve({ maxPendingCodes: 1 })
    await codeFor()
    const { pending, redirect } = await toAppRedirect(new Browser())
    expect(redirect).toBe(
      `${APP_SIGN_IN_REDIRECT_URI}?error=temporarily_unavailable&state=${pending.state}`
    )
    expect(
      audit.some((l) => (l.detail as { reason?: string })?.reason === 'too_many_pending')
    ).toBe(true)
    // Expired ones stop counting.
    advance(APP_CODE_TTL_MS + 1)
    const later = await codeFor()
    expect(later.code).toBeTruthy()
  })
})

describe('the start: a fixed redirect, a real challenge — never an open redirect', () => {
  const valid = {
    redirect_uri: APP_SIGN_IN_REDIRECT_URI,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    state: 'state-abcdefghijklmnop'
  }
  const start = (params: Record<string, string>) =>
    fetch(`${base}${APP_SIGN_IN_PATH}?${new URLSearchParams(params)}`, { redirect: 'manual' })

  it.each([
    ['another scheme', { redirect_uri: 'https://evil.example/cb' }],
    ['another path', { redirect_uri: 'slayzone://auth/callback/x' }],
    ['a query on the redirect', { redirect_uri: 'slayzone://auth/callback?next=evil' }],
    ['no redirect', { redirect_uri: '' }],
    ['plain method', { code_challenge_method: 'plain' }],
    ['no method', { code_challenge_method: '' }],
    ['no challenge', { code_challenge: '' }],
    ['a short challenge', { code_challenge: 'abc' }],
    ['a challenge outside base64url', { code_challenge: `${'A'.repeat(42)}=` }],
    ['no state', { state: '' }],
    ['a short state', { state: 'abc' }],
    ['a state with other characters', { state: 'state-abcdefghijklmnop<' }]
  ])('%s → 400 page, no redirect, no cookie', async (_label, override) => {
    const res = await start({ ...valid, ...override })
    expect(res.status).toBe(400)
    expect(res.headers.get('location')).toBe(null)
    expect(res.headers.getSetCookie()).toEqual([])
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('the valid start goes to Entra', async () => {
    const res = await start(valid)
    expect(res.status).toBe(302)
    expect(new URL(locationOf(res)).origin).toBe(entra.authority)
  })
})

describe('the return leg and the confirm page', () => {
  it('another browser (no flow cookie) gets nothing: back to the app with flow_expired', async () => {
    const a = new Browser()
    const pending = await startAppSignIn(base, nodeCrypto)
    const start = await a.get(pending.url)
    const authorize = new URL(locationOf(start))
    const code = entra.issueCode(authorize, MFA)
    const callback = await a.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${authorize.searchParams.get('state')}`
    )
    // Browser B has A's better-auth session but not the flow cookie (a forged return).
    const b = new Browser()
    b.jar.set(a.betterAuthCookie()!, a.jar.get(a.betterAuthCookie()!)!)
    const back = await b.get(locationOf(callback))
    expect(back.status).toBe(302)
    expect(locationOf(back)).toBe(`${APP_SIGN_IN_REDIRECT_URI}?error=flow_expired`)
    const confirm = await b.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'continue' }, base)
    expect(locationOf(confirm)).toBe(`${APP_SIGN_IN_REDIRECT_URI}?error=flow_expired`)
    expect(events()).not.toContain('auth.app_sso.code:success')
  })

  it('a tampered flow cookie is no flow', async () => {
    const browser = new Browser()
    await browser.get((await startAppSignIn(base, nodeCrypto)).url)
    const value = browser.jar.get(APP_FLOW_COOKIE)!
    browser.jar.set(APP_FLOW_COOKIE, `${value.slice(0, -2)}${value.endsWith('A') ? 'BB' : 'AA'}`)
    const back = await browser.get(`${APP_SIGN_IN_PATH}?return=1`)
    expect(locationOf(back)).toBe(`${APP_SIGN_IN_REDIRECT_URI}?error=flow_expired`)
  })

  it('a flow older than 10 minutes is lost', async () => {
    const browser = new Browser()
    const pending = await startAppSignIn(base, nodeCrypto)
    const start = await browser.get(pending.url)
    const authorize = new URL(locationOf(start))
    const code = entra.issueCode(authorize, MFA)
    advance(10 * 60_000 + 1_000)
    const callback = await browser.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${authorize.searchParams.get('state')}`
    )
    const back = await browser.get(locationOf(callback))
    expect(locationOf(back).startsWith(`${APP_SIGN_IN_REDIRECT_URI}?error=`)).toBe(true)
    expect(locationOf(back)).not.toContain('code=')
  })

  it('an Entra session from before this sign-in started does not count', async () => {
    const browser = new Browser()
    // A completed Entra sign-in in this browser, then a NEW app sign-in that skips Entra.
    await toConfirmPage(browser)
    advance(2_000)
    const second = await startAppSignIn(base, nodeCrypto)
    const start = await browser.get(second.url)
    expect(new URL(locationOf(start)).origin, 'every app sign-in goes through Entra').toBe(
      entra.authority
    )
    const back = await browser.get(`${APP_SIGN_IN_PATH}?return=1`)
    expect(locationOf(back)).toBe(
      `${APP_SIGN_IN_REDIRECT_URI}?error=no_session&state=${second.state}`
    )
  })

  it('a refused Entra sign-in (no MFA) goes back to the app with the reason and our state', async () => {
    const browser = new Browser()
    const { pending, page } = await toConfirmPage(browser, { oid: 'ada', amr: ['pwd'] })
    expect(page.status).toBe(302)
    const callback = readAppSignInCallback(locationOf(page), pending)
    expect(callback).toMatchObject({
      ok: false,
      reason: 'refused',
      code: 'unable_to_get_user_info'
    })
    expect(locationOf(page)).not.toContain('code=')
  })

  it('a reason that is not a plain code is not echoed', async () => {
    const browser = new Browser()
    const pending = await startAppSignIn(base, nodeCrypto)
    await browser.get(pending.url)
    const back = await browser.get(
      `${APP_SIGN_IN_PATH}?return=1&signin=failed&error=${encodeURIComponent('<script>')}`
    )
    expect(locationOf(back)).toBe(
      `${APP_SIGN_IN_REDIRECT_URI}?error=signin_failed&state=${pending.state}`
    )
  })

  it('Cancel on the confirm page: access_denied to the app, the browser session ended', async () => {
    const browser = new Browser()
    const { pending } = await toConfirmPage(browser)
    const cancel = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'cancel' }, base)
    expect(cancel.status).toBe(302)
    expect(locationOf(cancel)).toBe(
      `${APP_SIGN_IN_REDIRECT_URI}?error=access_denied&state=${pending.state}`
    )
    expect(browser.betterAuthCookie()).toBeUndefined()
    expect(audit.some((l) => (l.detail as { reason?: string })?.reason === 'cancelled')).toBe(true)
    expect(events()).not.toContain('auth.app_sso.code:success')
  })

  it.each([
    ['no Origin', null],
    ['a foreign Origin', 'https://evil.example'],
    ['Origin null', 'null']
  ])('a confirm with %s is refused (403), nothing issued', async (_label, origin) => {
    const browser = new Browser()
    await toConfirmPage(browser)
    const res = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'continue' }, origin)
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBe(null)
    expect(events()).not.toContain('auth.app_sso.code:success')
  })

  it('a confirm without a decision is a 400 page', async () => {
    const browser = new Browser()
    await toConfirmPage(browser)
    const res = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'maybe' }, base)
    expect(res.status).toBe(400)
  })

  it('a confirm whose Entra session ended is no_session', async () => {
    const browser = new Browser()
    const { pending } = await toConfirmPage(browser)
    browser.jar.delete(browser.betterAuthCookie()!)
    const res = await browser.post(APP_SIGN_IN_CONFIRM_PATH, { decision: 'continue' }, base)
    expect(locationOf(res)).toBe(
      `${APP_SIGN_IN_REDIRECT_URI}?error=no_session&state=${pending.state}`
    )
  })
})

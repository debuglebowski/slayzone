/**
 * The web shell's Entra sign-in (T-13) against a REAL better-auth instance with Entra
 * sign-in and the local fake Entra (fake-entra-harness.ts), served over HTTP the way
 * the hub serves it: `/api/auth/web-sso` → the sign-in route, other `/api/auth/*` →
 * better-auth. The browser is a cookie jar that follows redirects by hand.
 *
 * The web session itself (the `web_sessions` row, its cookie's flags) is the hub's —
 * `opts.mint` here is a stub, and the hub's half is `apps/hub/src/web-session-routes.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentSecurityContext, setSecurityLogSink } from '@slayzone/platform/security-log'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthExpressApp } from './app'
import { createHubAuth, type HubAuth } from './auth'
import { ENTRA_PROVIDER_ID, loadEntraClientCredential } from './entra'
import { CLIENT_ID, type Claims, FakeEntra, TENANT, writeHubCredential } from './fake-entra-harness'
import { createHubUser } from './users'
import { createWebSignIn, WEB_SIGN_IN_FRESH_MS, WEB_SIGN_IN_PATH } from './web-sign-in'

const SECRET = 'hub-auth-web-sign-in-test-secret-at-least-32'
const WEB_COOKIE = 'slayzone_web_session=szw_minted; Path=/; HttpOnly; SameSite=Lax'
const MFA: Claims = { oid: 'ada', amr: ['pwd', 'mfa'] }

let tmpDir: string
let entra: FakeEntra
let credentialPaths: { certPath: string; keyPath: string }
let auth: HubAuth
let server: Server
let base: string
let audit: Array<Record<string, unknown>>
let clock: number
let mint: ReturnType<typeof vi.fn<(userId: string, req: IncomingMessage) => Promise<string[]>>>
let mintActor: string | null | undefined

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-web-sign-in-test-'))
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

beforeEach(async () => {
  clock = Date.now()
  vi.useFakeTimers({ toFake: ['Date'], now: clock })
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
  mintActor = undefined
  mint = vi.fn(async (_userId: string, _req: IncomingMessage) => {
    mintActor = currentSecurityContext()?.actor
    return [WEB_COOKIE]
  })
  const authApp = createAuthExpressApp(auth)
  const signIn = createWebSignIn(auth, { mint })
  server.on('request', (req, res) => {
    if (signIn(req, res)) return
    if ((req.url ?? '').startsWith('/api/auth/')) authApp(req, res)
    else res.writeHead(404).end()
  })
  audit = []
  setSecurityLogSink((line) => audit.push(JSON.parse(line) as Record<string, unknown>))
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

  async get(path: string): Promise<Response> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(new URL(path, base), {
      headers: cookie ? { cookie } : {},
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  /** Press "Sign in with Microsoft"; sign in at Entra with `claims`; follow it back. */
  async signIn(claims: Claims): Promise<Response> {
    const start = await this.get(WEB_SIGN_IN_PATH)
    expect(start.status).toBe(302)
    const authorize = new URL(start.headers.get('location') ?? '')
    expect(authorize.origin).toBe(entra.authority)
    const code = entra.issueCode(authorize, claims)
    const state = authorize.searchParams.get('state') ?? ''
    const callback = await this.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${state}`
    )
    expect(callback.status).toBe(302)
    return this.get(callback.headers.get('location') ?? '/')
  }

  /** better-auth's session cookie (name depends on the base URL's scheme). */
  betterAuthCookie(): string | undefined {
    return [...this.jar.keys()].find((k) => k.endsWith('session_token'))
  }
}

const location = (res: Response): URL => new URL(res.headers.get('location') ?? '', base)

describe('web sign-in through Entra', () => {
  it('starts at Entra: 302 to the authorize URL with the hub callback, state cookie set', async () => {
    const browser = new Browser()
    const start = await browser.get(WEB_SIGN_IN_PATH)
    expect(start.status).toBe(302)
    const authorize = location(start)
    expect(authorize.origin).toBe(entra.authority)
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${base}/api/auth/callback/${ENTRA_PROVIDER_ID}`
    )
    expect(start.headers.getSetCookie().length).toBeGreaterThan(0)
    expect(start.headers.get('cache-control')).toBe('no-store')
    expect(mint).not.toHaveBeenCalled()
  })

  it('back from Entra: mints the web session, ends the better-auth session, lands on the shell', async () => {
    const browser = new Browser()
    const start = await browser.get(WEB_SIGN_IN_PATH)
    const authorize = location(start)
    const code = entra.issueCode(authorize, MFA)
    const callback = await browser.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${authorize.searchParams.get('state')}`
    )
    expect(location(callback).pathname + location(callback).search).toBe(
      `${WEB_SIGN_IN_PATH}?return=1`
    )
    const sessionCookie = browser.betterAuthCookie()
    expect(sessionCookie).toBeDefined()
    const fullSession = `${sessionCookie}=${browser.jar.get(sessionCookie!)}`

    const done = await browser.get(callback.headers.get('location') ?? '')
    expect(done.status).toBe(302)
    expect(location(done).pathname).toBe('/')
    expect(location(done).search).toBe('')
    expect(done.headers.getSetCookie()).toContain(WEB_COOKIE)

    // Minted for the Entra account, with that account as the audit actor.
    const ctx = await auth.$context
    const account = await ctx.internalAdapter.findAccountByProviderId(
      `ada.${TENANT}`,
      ENTRA_PROVIDER_ID
    )
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mint.mock.calls[0]![0]).toBe(account!.userId)
    expect(mintActor).toBe(account!.userId)

    // The full session is gone: its cookie is cleared and it no longer resolves.
    expect(browser.betterAuthCookie()).toBeUndefined()
    expect(await auth.api.getSession({ headers: new Headers({ cookie: fullSession }) })).toBe(null)
    expect(audit.map((l) => `${l.event}:${l.outcome}`)).toContain('auth.signout:success')
  })

  it('a refused Entra sign-in (no MFA) lands on the shell with the reason; nothing minted', async () => {
    const browser = new Browser()
    const done = await browser.signIn({ oid: 'ada', amr: ['pwd'] })
    expect(done.status).toBe(302)
    const back = location(done)
    expect(back.pathname).toBe('/')
    expect(back.searchParams.get('signin')).toBe('failed')
    expect(back.searchParams.get('reason')).toMatch(/^[A-Za-z0-9_]+$/)
    expect(mint).not.toHaveBeenCalled()
  })

  it('the return leg never loops to Entra: no session there is a failure', async () => {
    const browser = new Browser()
    const back = await browser.get(`${WEB_SIGN_IN_PATH}?return=1`)
    expect(back.status).toBe(302)
    expect(location(back).pathname).toBe('/')
    expect(location(back).searchParams.get('reason')).toBe('no_session')
    expect(mint).not.toHaveBeenCalled()
  })

  it('a callback better-auth cannot tie to a flow lands on the shell with ?error= (not its gated error page)', async () => {
    const browser = new Browser()
    const callback = await browser.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=x&state=not-a-state`
    )
    expect(callback.status).toBe(302)
    const back = location(callback)
    expect(back.pathname).toBe('/')
    expect(back.searchParams.get('error')).toMatch(/^[a-z_]+$/)
    expect(mint).not.toHaveBeenCalled()
  })

  it('a reason that is not a plain code is not echoed', async () => {
    const browser = new Browser()
    const back = await browser.get(
      `${WEB_SIGN_IN_PATH}?return=1&signin=failed&error=${encodeURIComponent('<script>')}`
    )
    expect(location(back).searchParams.get('reason')).toBe('signin_failed')
  })

  it(`an Entra session older than ${WEB_SIGN_IN_FRESH_MS / 60_000} minutes is sent through Entra again`, async () => {
    const browser = new Browser()
    const start = await browser.get(WEB_SIGN_IN_PATH)
    const authorize = location(start)
    const code = entra.issueCode(authorize, MFA)
    await browser.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${authorize.searchParams.get('state')}`
    )
    advance(WEB_SIGN_IN_FRESH_MS + 1_000)
    const again = await browser.get(WEB_SIGN_IN_PATH)
    expect(again.status).toBe(302)
    expect(location(again).origin).toBe(entra.authority)
    expect(mint).not.toHaveBeenCalled()
  })

  it('a password session (break-glass) mints nothing: it is sent through Entra', async () => {
    const created = await createHubUser(auth, { email: 'ops@normain.test', name: 'Ops' })
    if ('error' in created) throw new Error(`createHubUser: ${created.error}`)
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: created.email, password: created.password })
    })
    expect(signIn.status).toBe(200)
    const browser = new Browser()
    browser.store(signIn)
    const start = await browser.get(WEB_SIGN_IN_PATH)
    expect(start.status).toBe(302)
    expect(location(start).origin).toBe(entra.authority)
    const back = await browser.get(`${WEB_SIGN_IN_PATH}?return=1`)
    expect(location(back).searchParams.get('reason')).toBe('no_session')
    expect(mint).not.toHaveBeenCalled()
  })

  it('a failing mint lands on the shell as a failure and leaks nothing', async () => {
    mint.mockRejectedValueOnce(new Error('db down'))
    const browser = new Browser()
    const done = await browser.signIn(MFA)
    expect(location(done).searchParams.get('reason')).toBe('server_error')
    expect(done.headers.getSetCookie()).toEqual([])
  })

  it('only GET', async () => {
    const res = await fetch(`${base}${WEB_SIGN_IN_PATH}`, { method: 'POST', redirect: 'manual' })
    expect(res.status).toBe(405)
  })
})

/**
 * Device sign-in (T-14) against a REAL better-auth instance with Entra sign-in and a
 * LOCAL fake Entra (own signing key + JWKS + token endpoint checking the hub's client
 * assertion and PKCE, as in entra.test.ts), served over HTTP the way the hub serves it:
 * `/api/auth/*` → better-auth, `/device*` → the approval page.
 *
 * The client side (`/device/code`, `/device/token`) is driven like the CLI; the browser
 * side with a cookie jar and `Origin`, like a browser.
 */
import { createHash, generateKeyPairSync, KeyObject, randomBytes, webcrypto } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { CLIENT_ADDRESS_HEADER } from '@slayzone/platform/client-address'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { exportJWK, importX509, jwtVerify, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthExpressApp } from './app'
import { createHubAuth, type HubAuth } from './auth'
import { DEVICE_CODE_TTL_MS, MAX_PENDING_DEVICE_CODES } from './device'
import { createDevicePage, WRONG_CODE_LIMIT, WRONG_CODE_WINDOW_MS } from './device-page'
import {
  ENTRA_ADMIN_ROLE,
  ENTRA_PROVIDER_ID,
  ENTRA_USER_ROLE,
  loadEntraClientCredential
} from './entra'
import { createHubUser } from './users'
import { verifySession } from './verify'

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SECRET = 'hub-auth-device-test-secret-at-least-32-chars'
const crypto = webcrypto as unknown as Crypto

// ---------------------------------------------------------------------------
// Fake Entra (compact twin of entra.test.ts's)
// ---------------------------------------------------------------------------

interface Claims {
  oid: string
  roles?: string[]
  amr?: string[]
}

class FakeEntra {
  server!: Server
  authority = ''
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private readonly codes = new Map<
    string,
    { challenge: string; redirect: string; claims: Claims }
  >()
  constructor(private readonly hubCertPem: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.authority = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()))
  }

  issueCode(authorize: URL, claims: Claims): string {
    const code = `code-${randomBytes(8).toString('hex')}`
    this.codes.set(code, {
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirect: authorize.searchParams.get('redirect_uri') ?? '',
      claims
    })
    return code
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.authority)
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === `/${TENANT}/discovery/v2.0/keys`) {
      send(200, { keys: [{ ...(await exportJWK(this.key.publicKey)), kid: 'k1', use: 'sig' }] })
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const form = Object.fromEntries(new URLSearchParams(raw))
    try {
      await jwtVerify(form.client_assertion ?? '', await importX509(this.hubCertPem, 'PS256'), {
        audience: `${this.authority}/${TENANT}/oauth2/v2.0/token`,
        issuer: CLIENT_ID
      })
    } catch {
      send(401, { error: 'invalid_client' })
      return
    }
    const issued = this.codes.get(form.code ?? '')
    this.codes.delete(form.code ?? '')
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url')
    if (!issued || issued.challenge !== challenge || issued.redirect !== form.redirect_uri) {
      send(400, { error: 'invalid_grant' })
      return
    }
    const now = Math.floor(Date.now() / 1000)
    const c = issued.claims
    const idToken = await new SignJWT({
      ver: '2.0',
      iss: `${this.authority}/${TENANT}/v2.0`,
      tid: TENANT,
      oid: c.oid,
      sub: `pairwise-${c.oid}`,
      aud: CLIENT_ID,
      iat: now,
      nbf: now,
      exp: now + 3600,
      name: c.oid,
      email: `${c.oid}@normain.test`,
      roles: c.roles ?? [ENTRA_USER_ROLE],
      ...(c.amr ? { amr: c.amr } : {})
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
      .sign(this.key.privateKey)
    send(200, {
      token_type: 'Bearer',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token: idToken
    })
  }
}

// ---------------------------------------------------------------------------
// Harness: one hub-auth instance served over HTTP like the hub serves it
// ---------------------------------------------------------------------------

let tmpDir: string
let entra: FakeEntra
let credentialPaths: { certPath: string; keyPath: string }
let auth: HubAuth
let server: Server
let base: string
let audit: Array<Record<string, unknown>>
let logged: string[]
let clock: number

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-device-test-'))
  const keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: '01',
      name: 'CN=SlayZone hub device test',
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      keys
    },
    crypto
  )
  credentialPaths = { certPath: join(tmpDir, 'cert.pem'), keyPath: join(tmpDir, 'key.pem') }
  writeFileSync(credentialPaths.certPath, cert.toString('pem'))
  writeFileSync(
    credentialPaths.keyPath,
    KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string
  )
  entra = new FakeEntra(cert.toString('pem'))
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
  const authApp = createAuthExpressApp(auth)
  const page = createDevicePage(auth, { signInOrigin: entra.authority })
  server.on('request', (req, res) => {
    if ((req.url ?? '').startsWith('/api/auth/')) authApp(req, res)
    else if (!page(req, res)) res.writeHead(404).end()
  })
  audit = []
  logged = []
  setSecurityLogSink((line) => {
    audit.push(JSON.parse(line) as Record<string, unknown>)
    logged.push(line)
  })
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

const events = (): string[] => audit.map((l) => `${l.event}:${l.outcome}`)

// --- the CLI side -----------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

/** `from`: the client address the hub would have resolved (T-26 limits per address). */
async function requestCode(clientId = 'slayzone-cli', from?: string): Promise<DeviceCodeResponse> {
  const res = await fetch(`${base}/api/auth/device/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(from ? { [CLIENT_ADDRESS_HEADER]: from } : {})
    },
    body: JSON.stringify({ client_id: clientId })
  })
  expect(res.status).toBe(200)
  return (await res.json()) as DeviceCodeResponse
}

async function poll(
  deviceCode: string,
  clientId = 'slayzone-cli'
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId
    })
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

// --- the browser side -------------------------------------------------------

class Browser {
  readonly jar = new Map<string, string>()

  private store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const eq = pair!.indexOf('=')
      const value = pair!.slice(eq + 1)
      if (/max-age=0/i.test(c) || value === '') this.jar.delete(pair!.slice(0, eq))
      else this.jar.set(pair!.slice(0, eq), value)
    }
  }

  cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(new URL(path, base), {
      headers: this.jar.size ? { cookie: this.cookie() } : {},
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  async post(path: string, form: Record<string, string>, origin: string | null = base) {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded'
    }
    if (this.jar.size) headers.cookie = this.cookie()
    if (origin !== null) headers.origin = origin
    const res = await fetch(new URL(path, base), {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  /**
   * Open the page for a code; when it sends the browser to Entra, "sign in" there with
   * `claims` and follow the callback back. Returns the page that finally renders.
   */
  async open(userCode: string, claims: Claims): Promise<Response> {
    const first = await this.get(`/device?user_code=${userCode}`)
    if (first.status !== 302) return first
    const authorize = new URL(first.headers.get('location') ?? '')
    expect(authorize.origin).toBe(entra.authority)
    const code = entra.issueCode(authorize, claims)
    const state = authorize.searchParams.get('state') ?? ''
    const callback = await this.get(
      `/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${state}`
    )
    expect(callback.status).toBe(302)
    return this.get(callback.headers.get('location') ?? '/')
  }

  approve(userCode: string, origin: string | null = base): Promise<Response> {
    return this.post('/device/approve', { user_code: userCode }, origin)
  }
}

const MFA: Claims = { oid: 'ada', amr: ['pwd', 'mfa'] }

// ---------------------------------------------------------------------------

describe('device sign-in', () => {
  it('issues a 10-minute code for a known client, pointing at the hub page', async () => {
    const code = await requestCode()
    expect(code.expires_in).toBe(DEVICE_CODE_TTL_MS / 1000)
    expect(code.interval).toBe(5)
    expect(code.verification_uri).toBe(`${base}/device`)
    expect(code.user_code).toMatch(/^[A-Z2-9]{8}$/)
    expect(events()).toEqual(['auth.device.code:success'])
  })

  it('refuses an unknown client', async () => {
    const res = await fetch(`${base}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: 'someone-else' })
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client')
    expect(events()).toEqual(['auth.device.code:denied'])
  })

  it('approval after an Entra sign-in with MFA issues a bearer that is a normal session', async () => {
    const code = await requestCode()
    expect((await poll(code.device_code)).body.error).toBe('authorization_pending')

    const browser = new Browser()
    const page = await browser.open(code.user_code, MFA)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('SlayZone CLI (slay)')
    expect(html).toContain(`${code.user_code.slice(0, 4)}-${code.user_code.slice(4)}`)
    expect(html).toContain(new URL(base).host)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/type="password"/i)
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")

    const approved = await browser.approve(code.user_code)
    expect(approved.status).toBe(200)
    expect(await approved.text()).toContain('is signed in')

    advance(6_000)
    const token = await poll(code.device_code)
    expect(token.status).toBe(200)
    expect(token.body.token_type).toBe('Bearer')
    const bearer = String(token.body.access_token)
    const ctx = await verifySession(auth, new Headers({ authorization: `Bearer ${bearer}` }))
    expect(ctx?.role).toBe('user')
    expect((ctx?.session as unknown as Record<string, unknown>).signInMethod).toBe('device')
    // The session follows the hub's normal lifetime (better-auth default: 7 days).
    const lifetime = new Date(ctx!.session.expiresAt).getTime() - Date.now()
    expect(Math.round(lifetime / 86_400_000)).toBe(7)

    // One-time: the code is gone once redeemed.
    advance(6_000)
    expect((await poll(code.device_code)).body.error).toBe('invalid_grant')

    expect(events()).toEqual(
      expect.arrayContaining([
        'auth.device.code:success',
        'auth.signin:success',
        'auth.device.approve:success',
        'auth.session.create:success'
      ])
    )
    // The Entra sign-in, the token, and the replay of the spent code.
    const signins = audit.filter((l) => l.event === 'auth.signin')
    expect(signins.map((l) => `${(l.detail as { method: string }).method}:${l.outcome}`)).toEqual([
      'sso:success',
      'device:success',
      'device:failure'
    ])
    // Every line of one request carries the same reference; no code or token anywhere.
    const refs = new Set(
      audit
        .filter((l) => String(l.event).startsWith('auth.device') || l.event === 'auth.signin')
        .map((l) => (l.detail as { requestRef?: string }).requestRef)
        .filter(Boolean)
    )
    expect(refs.size).toBe(1)
    const all = logged.join('\n')
    for (const secret of [code.device_code, code.user_code, bearer]) {
      expect(all).not.toContain(secret)
    }
  })

  it('an admin in Entra gets an admin bearer', async () => {
    const code = await requestCode('slayzone-desktop')
    const browser = new Browser()
    const page = await browser.open(code.user_code, { ...MFA, roles: [ENTRA_ADMIN_ROLE] })
    expect(await page.text()).toContain('SlayZone desktop app')
    await browser.approve(code.user_code)
    const token = await poll(code.device_code, 'slayzone-desktop')
    const ctx = await verifySession(
      auth,
      new Headers({ authorization: `Bearer ${String(token.body.access_token)}` })
    )
    expect(ctx?.role).toBe('admin')
  })

  it('no token without MFA: the Entra sign-in is refused and the page never approves', async () => {
    const code = await requestCode()
    const browser = new Browser()
    const page = await browser.open(code.user_code, { oid: 'ada', amr: ['pwd'] })
    expect(page.status).toBe(401)
    expect(await page.text()).toContain('Sign-in did not complete')
    // No session: a direct approve is sent back to sign in, and the CLI keeps waiting.
    expect((await browser.approve(code.user_code)).status).toBe(401)
    expect((await poll(code.device_code)).body.error).toBe('authorization_pending')
    expect(audit.find((l) => l.event === 'auth.signin')?.detail).toMatchObject({
      reason: 'no_mfa'
    })
  })

  it('denial ends the request with access_denied', async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    const denied = await browser.post('/device/deny', { user_code: code.user_code })
    expect(denied.status).toBe(200)
    expect((await poll(code.device_code)).body.error).toBe('access_denied')
    expect(events()).toContain('auth.device.deny:success')
  })

  it('expiry: the page and the poll both say expired', async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    advance(DEVICE_CODE_TTL_MS + 1_000)
    expect((await browser.get(`/device?user_code=${code.user_code}`)).status).toBe(410)
    expect((await browser.approve(code.user_code)).status).toBe(410)
    expect((await poll(code.device_code)).body.error).toBe('expired_token')
    expect(events().filter((e) => e === 'auth.device.expire:failure').length).toBe(3)
  })

  it('polling faster than the interval answers slow_down', async () => {
    const code = await requestCode()
    expect((await poll(code.device_code)).body.error).toBe('authorization_pending')
    expect((await poll(code.device_code)).body.error).toBe('slow_down')
  })

  it('an Entra session from BEFORE the code is sent through Entra again', async () => {
    const browser = new Browser()
    const first = await requestCode()
    await browser.open(first.user_code, MFA)
    advance(60_000)
    const second = await requestCode()
    const again = await browser.get(`/device?user_code=${second.user_code}`)
    expect(again.status).toBe(302)
    expect(again.headers.get('location')).toContain(entra.authority)
    // …and a form post with that old session approves nothing.
    expect((await browser.approve(second.user_code)).status).toBe(401)
    expect(events()).toContain('auth.device.approve:denied')
  })

  it('a password session (break-glass) cannot approve: it is sent through Entra', async () => {
    const created = await createHubUser(auth, { email: 'ops@normain.test', name: 'Ops' })
    if ('error' in created) throw new Error(`createHubUser: ${created.error}`)
    // With Origin, as a browser sends it: Node's fetch sends Fetch Metadata, and outside
    // better-auth's test mode (vitest sets TEST) that makes the origin check mandatory.
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: created.email, password: created.password })
    })
    expect(signIn.status).toBe(200)
    const browser = new Browser()
    for (const c of signIn.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const eq = pair!.indexOf('=')
      browser.jar.set(pair!.slice(0, eq), pair!.slice(eq + 1))
    }
    const code = await requestCode()
    const page = await browser.get(`/device?user_code=${code.user_code}`)
    expect(page.status).toBe(302)
    expect((await browser.approve(code.user_code)).status).toBe(401)
    expect((await poll(code.device_code)).body.error).toBe('authorization_pending')
  })

  it("a device token cannot approve another code (the plugin's own routes are closed)", async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    await browser.approve(code.user_code)
    const bearer = String((await poll(code.device_code)).body.access_token)

    const next = await requestCode()
    const auth_ = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }
    const claim = await fetch(`${base}/api/auth/device?user_code=${next.user_code}`, {
      headers: auth_
    })
    expect(claim.status).toBe(404)
    for (const path of ['approve', 'deny']) {
      const res = await fetch(`${base}/api/auth/device/${path}`, {
        method: 'POST',
        headers: auth_,
        body: JSON.stringify({ userCode: next.user_code })
      })
      expect(res.status).toBe(404)
    }
    advance(6_000)
    expect((await poll(next.device_code)).body.error).toBe('authorization_pending')
  })

  it('the forms refuse a missing, null or foreign Origin even with the session cookie', async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    for (const origin of [null, 'null', 'https://evil.example']) {
      expect((await browser.approve(code.user_code, origin)).status).toBe(403)
    }
    expect((await poll(code.device_code)).body.error).toBe('authorization_pending')
    expect(events().filter((e) => e === 'authz.denied:denied').length).toBe(3)
  })

  it('a code opened by one account cannot be approved by another', async () => {
    const code = await requestCode()
    await new Browser().open(code.user_code, MFA)
    const other = new Browser()
    const page = await other.open(code.user_code, { oid: 'bob', amr: ['mfa'] })
    expect(page.status).toBe(403)
    expect((await other.approve(code.user_code)).status).toBe(403)
  })

  it(`wrong user codes lock the account out after ${WRONG_CODE_LIMIT}`, async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    for (let i = 1; i < WRONG_CODE_LIMIT; i++) {
      expect((await browser.get('/device?user_code=ZZZZZZZZ')).status).toBe(404)
    }
    // The limit-th miss locks; from then on even the right code is refused.
    expect((await browser.get('/device?user_code=ZZZZZZZZ')).status).toBe(404)
    expect((await browser.get(`/device?user_code=${code.user_code}`)).status).toBe(429)
    expect((await browser.approve(code.user_code)).status).toBe(429)
    expect(events().filter((e) => e === 'auth.device.user_code:failure').length).toBe(
      WRONG_CODE_LIMIT - 1
    )
    expect(events()).toContain('auth.device.user_code:denied')
    // The lockout ends with its window.
    advance(WRONG_CODE_WINDOW_MS + 1_000)
    const fresh = await requestCode()
    expect((await browser.open(fresh.user_code, MFA)).status).toBe(200)
  })

  it('a malformed or missing code shows the entry form; nothing is looked up without a session', async () => {
    const browser = new Browser()
    const blank = await browser.get('/device')
    expect(blank.status).toBe(200)
    expect(await blank.text()).toContain('name="user_code"')
    expect((await browser.get('/device?user_code=not-a-code!')).status).toBe(400)
    // A well-formed unknown code with no session goes to sign-in first: no answer leaks.
    expect((await browser.get('/device?user_code=ABCDEFGH')).status).toBe(302)
    expect(events()).toEqual([])
  })

  it(`at most ${MAX_PENDING_DEVICE_CODES} codes may be outstanding; expired ones are swept`, async () => {
    // From many addresses: one address may ask for only a few (rate-limit.ts).
    for (let i = 0; i < MAX_PENDING_DEVICE_CODES; i++) {
      await requestCode('slayzone-cli', `10.0.0.${i + 1}`)
    }
    const refused = await fetch(`${base}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_ADDRESS_HEADER]: '10.0.1.1' },
      body: JSON.stringify({ client_id: 'slayzone-cli' })
    })
    expect(refused.status).toBe(429)
    advance(DEVICE_CODE_TTL_MS + 1_000)
    await requestCode()
    expect(events()).toContain('auth.device.code:denied')
    expect(audit.find((l) => l.event === 'auth.device.expire')?.detail).toMatchObject({
      swept: MAX_PENDING_DEVICE_CODES
    })
  })

  it('a disabled account gets no token even after approval', async () => {
    const code = await requestCode()
    const browser = new Browser()
    await browser.open(code.user_code, MFA)
    await browser.approve(code.user_code)
    const ctx = await auth.$context
    const account = await ctx.internalAdapter.findAccountByProviderId(
      `ada.${TENANT}`,
      ENTRA_PROVIDER_ID
    )
    await ctx.internalAdapter.updateUser(account!.userId, { disabledAt: new Date() })
    const token = await poll(code.device_code)
    expect(token.status).toBe(403)
    expect(token.body.access_token).toBeUndefined()
  })
})

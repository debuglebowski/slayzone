/**
 * Entra sign-in (T-09) end to end against a REAL better-auth instance and a LOCAL fake
 * Entra: an HTTP server with its own signing key, a JWKS endpoint and a token endpoint
 * that verifies the hub's client assertion and the PKCE verifier exactly as Entra
 * would, then hands back an ID token carrying whatever claims the case needs. Nothing
 * here talks to Microsoft.
 *
 * Covers the done-test of T-09: an assigned user of the right tenant gets a session;
 * another tenant, an unassigned user and a token without MFA are refused; admin only
 * with the `SlayZone.Admin` app role, recomputed at every sign-in; the token request
 * carries a valid signed assertion and no secret; key material never reaches a log.
 * Plus the SSO-hub role rules (users.ts) and the credential loader.
 */
import { createHash, generateKeyPairSync, KeyObject, randomBytes, webcrypto } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { inspect } from 'node:util'
import * as x509 from '@peculiar/x509'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import { symmetricDecrypt } from 'better-auth/crypto'
import { decodeProtectedHeader, exportJWK, importX509, jwtVerify, SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHubAuth, type HubAuth } from './auth'
import {
  ENTRA_ADMIN_ROLE,
  ENTRA_PROVIDER_ID,
  ENTRA_USER_ROLE,
  type EntraClientCredential,
  type EntraSsoConfig,
  entraAccountId,
  loadEntraClientCredential
} from './entra'
import {
  createHubUser,
  disableHubUser,
  ensureFirstAdmin,
  listHubUsers,
  setHubUserRole
} from './users'

const TENANT = '11111111-2222-3333-4444-555555555555'
const OTHER_TENANT = '99999999-8888-7777-6666-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BASE_URL = 'http://127.0.0.1:9999'
const SECRET = 'hub-auth-entra-test-secret-at-least-32-chars'
const REDIRECT_URI = `${BASE_URL}/api/auth/callback/${ENTRA_PROVIDER_ID}`
const crypto = webcrypto as unknown as Crypto

// ---------------------------------------------------------------------------
// The hub's certificate, and a fake Entra
// ---------------------------------------------------------------------------

async function selfSigned(
  algorithm: RsaHashedKeyGenParams | EcKeyGenParams,
  signing: { name: string; hash: string; namedCurve?: string }
): Promise<{ certPem: string; keyPem: string }> {
  const keys = (await crypto.subtle.generateKey(algorithm, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  const cert = await x509.X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomBytes(8).toString('hex').replace(/^./, '1'),
      name: 'CN=SlayZone hub test',
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: signing,
      keys
    },
    crypto
  )
  const keyPem = KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string
  return { certPem: cert.toString('pem'), keyPem }
}

const RSA_GEN: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256'
}
const RSA_SIGN = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }

interface IdClaims {
  tid?: string
  iss?: string
  oid?: string
  roles?: string[]
  amr?: string[]
  email?: string
  preferred_username?: string
  name?: string
}

interface TokenRequestRecord {
  form: Record<string, string>
  assertionHeader: Record<string, unknown>
  assertionClaims: Record<string, unknown>
}

/**
 * Fake Entra for one test run. `/token` refuses anything Entra would: no or bad
 * assertion, a client secret, a wrong PKCE verifier or redirect URI.
 */
class FakeEntra {
  server!: Server
  authority = ''
  readonly requests: TokenRequestRecord[] = []
  /** Every token pair the token endpoint handed out for a code, in order. */
  readonly issued: Array<{ access_token: string; refresh_token: string }> = []
  private readonly codes = new Map<
    string,
    { challenge: string; redirectUri: string; claims: IdClaims; signWith?: KeyObject }
  >()
  private readonly signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private readonly kid = 'fake-entra-key-1'
  /** Override: fail the token request with this Entra error. */
  failNext: { status: number; error: string; description: string } | null = null

  constructor(private readonly hubCertPem: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.authority = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  tokenEndpoint(tenant = TENANT): string {
    return `${this.authority}/${tenant}/oauth2/v2.0/token`
  }

  /** What the authorize step would do: remember the PKCE challenge, return a code. */
  issueCode(authorizeUrl: URL, claims: IdClaims, signWith?: KeyObject): string {
    const code = `code-${randomBytes(8).toString('hex')}`
    this.codes.set(code, {
      challenge: authorizeUrl.searchParams.get('code_challenge') ?? '',
      redirectUri: authorizeUrl.searchParams.get('redirect_uri') ?? '',
      claims,
      ...(signWith ? { signWith } : {})
    })
    return code
  }

  async idToken(claims: IdClaims, signWith?: KeyObject): Promise<string> {
    const tid = claims.tid ?? TENANT
    const now = Math.floor(Date.now() / 1000)
    const payload: Record<string, unknown> = {
      ver: '2.0',
      iss: claims.iss ?? `${this.authority}/${tid}/v2.0`,
      tid,
      sub: `pairwise-${claims.oid ?? 'none'}`,
      aud: CLIENT_ID,
      iat: now,
      nbf: now,
      exp: now + 3600,
      name: claims.name ?? 'Test Person',
      preferred_username: claims.preferred_username ?? claims.email ?? 'person@normain.test'
    }
    for (const key of ['oid', 'roles', 'amr', 'email'] as const) {
      if (claims[key] !== undefined) payload[key] = claims[key]
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.kid })
      .sign(signWith ?? this.signingKey.privateKey)
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', this.authority)
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname === `/${TENANT}/discovery/v2.0/keys`) {
      const jwk = await exportJWK(this.signingKey.publicKey)
      send(200, { keys: [{ ...jwk, kid: this.kid, use: 'sig' }] })
      return
    }
    if (req.method !== 'POST' || url.pathname !== `/${TENANT}/oauth2/v2.0/token`) {
      send(404, { error: 'not_found' })
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const form = Object.fromEntries(new URLSearchParams(raw))
    const invalidClient = (why: string): void =>
      send(401, { error: 'invalid_client', error_description: `AADSTS700027: ${why}` })

    if (form.client_secret !== undefined) return invalidClient('a client secret was sent')
    if (form.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') {
      return invalidClient('wrong client_assertion_type')
    }
    let record: TokenRequestRecord
    try {
      const header = decodeProtectedHeader(form.client_assertion ?? '')
      const { payload } = await jwtVerify(
        form.client_assertion ?? '',
        await importX509(this.hubCertPem, 'PS256'),
        {
          algorithms: ['PS256'],
          audience: this.tokenEndpoint(),
          issuer: CLIENT_ID,
          subject: CLIENT_ID
        }
      )
      record = {
        form,
        assertionHeader: header as Record<string, unknown>,
        assertionClaims: payload
      }
    } catch (err) {
      return invalidClient(`assertion rejected: ${(err as Error).message}`)
    }
    this.requests.push(record)
    if (this.failNext) {
      const f = this.failNext
      this.failNext = null
      send(f.status, { error: f.error, error_description: f.description })
      return
    }

    if (form.grant_type === 'refresh_token') {
      send(200, {
        token_type: 'Bearer',
        access_token: 'at-refreshed',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
        id_token: await this.idToken({ oid: 'refreshed', roles: [ENTRA_USER_ROLE], amr: ['mfa'] })
      })
      return
    }
    const issued = this.codes.get(form.code ?? '')
    this.codes.delete(form.code ?? '')
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url')
    if (
      form.grant_type !== 'authorization_code' ||
      !issued ||
      issued.challenge !== challenge ||
      issued.redirectUri !== form.redirect_uri
    ) {
      send(400, { error: 'invalid_grant', error_description: 'AADSTS70008: bad code' })
      return
    }
    const pair = {
      access_token: `at-${randomBytes(6).toString('hex')}`,
      refresh_token: `rt-${randomBytes(6).toString('hex')}`
    }
    this.issued.push(pair)
    send(200, {
      token_type: 'Bearer',
      scope: 'openid profile email offline_access',
      ...pair,
      expires_in: 3600,
      id_token: await this.idToken(issued.claims, issued.signWith)
    })
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string
let hubCert: { certPem: string; keyPem: string }
let credential: EntraClientCredential
let entra: FakeEntra
let auth: HubAuth
let audit: Array<Record<string, unknown>>
/** Everything written to the console or stdout/stderr during a test. */
let logged: string[]

beforeAll(async () => {
  hubCert = await selfSigned(RSA_GEN, RSA_SIGN)
  tmpDir = mkdtempSync(join(tmpdir(), 'hub-auth-entra-test-'))
  writeFileSync(join(tmpDir, 'cert.pem'), hubCert.certPem)
  writeFileSync(join(tmpDir, 'key.pem'), hubCert.keyPem)
  credential = loadEntraClientCredential({
    certPath: join(tmpDir, 'cert.pem'),
    keyPath: join(tmpDir, 'key.pem')
  })
  entra = new FakeEntra(hubCert.certPem)
  await entra.start()
})

afterAll(async () => {
  await entra.stop()
  rmSync(tmpDir, { recursive: true, force: true })
})

const ssoConfig = (overrides: Partial<EntraSsoConfig> = {}): EntraSsoConfig => ({
  tenantId: TENANT,
  clientId: CLIENT_ID,
  credential,
  requireMfa: true,
  authority: entra.authority,
  ...overrides
})

let dbCounter = 0
const newDbPath = (): string => join(tmpDir, `hub-auth-${++dbCounter}.sqlite`)

async function bootSso(overrides: Partial<EntraSsoConfig> = {}, dbPath = newDbPath()) {
  return createHubAuth({ dbPath, baseURL: BASE_URL, secret: SECRET, sso: ssoConfig(overrides) })
}

let authDbPath: string

beforeEach(async () => {
  authDbPath = newDbPath()
  auth = await bootSso({}, authDbPath)
  entra.requests.length = 0
  audit = []
  logged = []
  setSecurityLogSink((line) => {
    audit.push(JSON.parse(line) as Record<string, unknown>)
    logged.push(line)
  })
  const capture = (...args: unknown[]): void => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 6 }))).join(' '))
  }
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation(capture)
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream)
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk))
      return original(chunk as string, ...(rest as []))
    }) as typeof stream.write)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  setSecurityLogSink()
})

const events = (): string[] => audit.map((l) => `${l.event}:${l.outcome}`)
const reasons = (): unknown[] => audit.map((l) => (l.detail as { reason?: unknown })?.reason)

const setCookies = (res: Response): string[] => res.headers.getSetCookie()
const cookieHeader = (cookies: string[]): string => cookies.map((c) => c.split(';')[0]).join('; ')

/** `POST /api/auth/sign-in/social` — the authorize URL plus the state cookie. */
async function startSignIn(
  target: HubAuth = auth,
  extra: Record<string, unknown> = {}
): Promise<{ url: URL; cookies: string[]; res: Response }> {
  const res = await target.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: ENTRA_PROVIDER_ID, callbackURL: '/', ...extra })
    })
  )
  const body = (await res.clone().json()) as { url?: string }
  return { url: new URL(body.url ?? 'http://invalid'), cookies: setCookies(res), res }
}

interface SignInResult {
  status: number
  location: string
  error: string | null
  cookies: string[]
}

/** The whole browser round trip: start, "authenticate" at the fake Entra, callback. */
async function signIn(
  claims: IdClaims,
  opts: { target?: HubAuth; signWith?: KeyObject } = {}
): Promise<SignInResult> {
  const target = opts.target ?? auth
  const start = await startSignIn(target)
  const code = entra.issueCode(start.url, claims, opts.signWith)
  const state = start.url.searchParams.get('state') ?? ''
  const res = await target.handler(
    new Request(`${BASE_URL}/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${state}`, {
      headers: { cookie: cookieHeader(start.cookies) }
    })
  )
  const location = res.headers.get('location') ?? ''
  return {
    status: res.status,
    location,
    error: new URL(location, BASE_URL).searchParams.get('error'),
    cookies: setCookies(res)
  }
}

/** The account behind a successful sign-in, read through better-auth's own session check. */
async function sessionUser(result: SignInResult, target: HubAuth = auth) {
  const session = await target.api.getSession({
    headers: new Headers({ cookie: cookieHeader(result.cookies) })
  })
  return session?.user as (Record<string, unknown> & { id: string }) | undefined
}

const assigned = (oid: string, extra: IdClaims = {}): IdClaims => ({
  oid,
  roles: [ENTRA_USER_ROLE],
  amr: ['pwd', 'mfa'],
  email: `${oid}@normain.test`,
  ...extra
})

const userCount = async (target: HubAuth = auth): Promise<number> =>
  (await listHubUsers(target)).length

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

describe('Entra sign-in', () => {
  it('the authorize URL is single-tenant, PKCE S256, offline_access, back to the hub callback', async () => {
    const { url } = await startSignIn()
    expect(url.origin + url.pathname).toBe(`${entra.authority}/${TENANT}/oauth2/v2.0/authorize`)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(
      ['email', 'offline_access', 'openid', 'profile'].sort()
    )
  })

  it('a client cannot widen the requested scopes', async () => {
    const { url } = await startSignIn(auth, { scopes: ['https://graph.microsoft.com/Mail.Read'] })
    expect(url.searchParams.get('scope')).not.toContain('Mail.Read')
  })

  it('an assigned user of the right tenant gets a session; the identity is <oid>.<tid> on the account row', async () => {
    const result = await signIn(assigned('alice-oid'))
    expect(result.status).toBe(302)
    expect(result.error).toBeNull()
    const user = await sessionUser(result)
    expect(user?.email).toBe('alice-oid@normain.test')
    expect(user?.role).toBe('user')

    const ctx = await auth.$context
    const accounts = await ctx.internalAdapter.findAccounts(user!.id)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.providerId).toBe(ENTRA_PROVIDER_ID)
    expect(accounts[0]!.accountId).toBe(entraAccountId('alice-oid', TENANT))
    // O-8: the refresh token is kept, and not in plaintext.
    expect(accounts[0]!.refreshToken).toBeTruthy()
    expect(accounts[0]!.refreshToken).not.toMatch(/^rt-/)

    // `auth.session.create` is a database after-hook, queued behind the transaction.
    expect(events().sort()).toEqual([
      'auth.session.create:success',
      'auth.signin:success',
      'user.create:success'
    ])
    expect(audit.find((l) => l.event === 'user.create')!.detail).toEqual({
      method: 'sso',
      role: 'user'
    })
    expect(audit.find((l) => l.event === 'auth.signin')!.actor).toBe(user!.id)
    expect(JSON.stringify(audit)).not.toContain('normain.test')
  })

  it('the same identity signs in again into the same account', async () => {
    const first = await sessionUser(await signIn(assigned('bob-oid')))
    const second = await sessionUser(
      await signIn(assigned('bob-oid', { email: 'renamed@normain.test' }))
    )
    expect(second?.id).toBe(first?.id)
    expect(await userCount()).toBe(1)
  })

  it('the token request carries a valid signed client assertion and no secret', async () => {
    const start = await startSignIn()
    const code = entra.issueCode(start.url, assigned('carol-oid'))
    await auth.handler(
      new Request(
        `${BASE_URL}/api/auth/callback/${ENTRA_PROVIDER_ID}?code=${code}&state=${start.url.searchParams.get('state')}`,
        { headers: { cookie: cookieHeader(start.cookies) } }
      )
    )
    // The fake Entra verified signature, audience, issuer and subject before recording.
    expect(entra.requests).toHaveLength(1)
    const { form, assertionHeader, assertionClaims } = entra.requests[0]!
    expect(form.client_secret).toBeUndefined()
    expect(form.client_id).toBe(CLIENT_ID)
    expect(form.grant_type).toBe('authorization_code')
    expect(form.redirect_uri).toBe(REDIRECT_URI)
    expect(form.code_verifier).toBeTruthy()
    expect(assertionHeader.alg).toBe('PS256')
    expect(assertionHeader.typ).toBe('JWT')
    const der = new x509.X509Certificate(hubCert.certPem).rawData
    expect(assertionHeader['x5t#S256']).toBe(
      createHash('sha256').update(Buffer.from(der)).digest('base64url')
    )
    expect(assertionClaims.aud).toBe(entra.tokenEndpoint())
    expect(typeof assertionClaims.jti).toBe('string')
    const lifetime = (assertionClaims.exp as number) - (assertionClaims.iat as number)
    expect(lifetime).toBeGreaterThan(0)
    expect(lifetime).toBeLessThanOrEqual(600)
  })

  it('a token Entra issued for another tenant is refused (wrong_tenant), no account is created', async () => {
    const result = await signIn(assigned('mallory-oid', { tid: OTHER_TENANT }))
    expect(result.error).toBe('unable_to_get_user_info')
    expect(await userCount()).toBe(0)
    expect(events()).toEqual(['auth.signin:denied'])
    expect(audit[0]!.detail).toMatchObject({ method: 'sso', reason: 'wrong_tenant' })
  })

  it('a right-tenant tid with a foreign issuer is refused too', async () => {
    const result = await signIn(
      assigned('mallory-oid', { iss: `${entra.authority}/${OTHER_TENANT}/v2.0` })
    )
    expect(result.error).toBe('unable_to_get_user_info')
    expect(reasons()).toEqual(['wrong_tenant'])
  })

  it('a user holding no SlayZone app role is refused (unassigned)', async () => {
    for (const roles of [undefined, [], ['Some.Other.Role']]) {
      const claims = assigned('dave-oid')
      if (roles === undefined) delete claims.roles
      else claims.roles = roles
      expect((await signIn(claims)).error).toBe('unable_to_get_user_info')
    }
    expect(await userCount()).toBe(0)
    expect(reasons()).toEqual(['unassigned', 'unassigned', 'unassigned'])
  })

  it('an Entra refusal for an unassigned user (AADSTS50105) is audited as unassigned', async () => {
    const start = await startSignIn()
    const state = start.url.searchParams.get('state')
    const res = await auth.handler(
      new Request(
        `${BASE_URL}/api/auth/callback/${ENTRA_PROVIDER_ID}?error=access_denied&error_description=${encodeURIComponent('AADSTS50105: not assigned')}&state=${state}`,
        { headers: { cookie: cookieHeader(start.cookies) } }
      )
    )
    expect(res.status).toBe(302)
    expect(events()).toEqual(['auth.signin:denied'])
    expect(audit[0]!.detail).toEqual({ method: 'sso', reason: 'unassigned', aadsts: 'AADSTS50105' })
  })

  it('a token without MFA is refused (no_mfa) — amr without mfa, or no amr at all', async () => {
    expect((await signIn(assigned('erin-oid', { amr: ['pwd'] }))).error).toBe(
      'unable_to_get_user_info'
    )
    const noAmr = assigned('erin-oid')
    delete noAmr.amr
    expect((await signIn(noAmr)).error).toBe('unable_to_get_user_info')
    expect(await userCount()).toBe(0)
    expect(reasons()).toEqual(['no_mfa', 'no_mfa'])
  })

  it('with SLAYZONE_HUB_SSO_REQUIRE_MFA=0 a token without MFA signs in', async () => {
    const lenient = await bootSso({ requireMfa: false })
    const result = await signIn(assigned('erin-oid', { amr: ['pwd'] }), { target: lenient })
    expect(result.error).toBeNull()
    expect((await sessionUser(result, lenient))?.role).toBe('user')
  })

  it('a token signed by any other key is refused (invalid_token)', async () => {
    const forger = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const result = await signIn(assigned('frank-oid'), { signWith: forger.privateKey })
    expect(result.error).toBe('unable_to_get_user_info')
    expect(reasons()).toEqual(['invalid_token'])
  })

  it('admin exactly with the SlayZone.Admin role, recomputed at every sign-in', async () => {
    const admin = assigned('kalle-oid', { roles: [ENTRA_ADMIN_ROLE] })
    const first = await signIn(admin)
    expect((await sessionUser(first))?.role).toBe('admin')
    expect(audit[0]).toMatchObject({ event: 'user.create', detail: { role: 'admin' } })

    // App role removed in Entra → the next sign-in demotes.
    audit.length = 0
    const second = await signIn(assigned('kalle-oid'))
    expect((await sessionUser(second))?.role).toBe('user')
    // The old session reads the new role too: it lives on the account, not the session.
    expect((await sessionUser(first))?.role).toBe('user')
    expect(audit.find((l) => l.event === 'user.role_change')).toMatchObject({
      outcome: 'success',
      detail: { reason: 'sso_claim', role: 'user' }
    })

    // And granted back.
    const third = await signIn(admin)
    expect((await sessionUser(third))?.role).toBe('admin')
  })

  it('both app roles → admin; the role claim is not case-folded', async () => {
    const both = await signIn(assigned('gina-oid', { roles: [ENTRA_USER_ROLE, ENTRA_ADMIN_ROLE] }))
    expect((await sessionUser(both))?.role).toBe('admin')
    const wrongCase = await signIn(assigned('hank-oid', { roles: ['slayzone.admin'] }))
    expect(wrongCase.error).toBe('unable_to_get_user_info')
  })

  it('a disabled account is refused, logged once as account_disabled', async () => {
    const ivan = await sessionUser(await signIn(assigned('ivan-oid')))
    await signIn(assigned('judy-oid'))
    expect(await disableHubUser(auth, 'ivan-oid@normain.test')).toBe('ok')
    audit.length = 0
    const result = await signIn(assigned('ivan-oid'))
    expect(result.error).toBe('ACCOUNT_DISABLED')
    expect(events()).toEqual(['auth.signin:denied'])
    expect(audit[0]).toMatchObject({ targetId: ivan!.id, detail: { reason: 'account_disabled' } })
  })

  it('an email already held by another account is refused, never linked', async () => {
    await createHubUser(auth, { email: 'kim-oid@normain.test' })
    audit.length = 0
    const result = await signIn(assigned('kim-oid'))
    expect(result.error).toBe('account_not_linked')
    expect(events()).toEqual(['auth.signin:failure'])
    expect(audit[0]!.detail).toEqual({ method: 'sso', reason: 'account_not_linked' })
    const ctx = await auth.$context
    expect(
      await ctx.internalAdapter.findAccountByKey({
        providerId: ENTRA_PROVIDER_ID,
        accountId: entraAccountId('kim-oid', TENANT)
      })
    ).toBeNull()
  })

  it('the ID-token sign-in route is closed: a token obtained elsewhere signs nobody in', async () => {
    const token = await entra.idToken(assigned('leo-oid'))
    const res = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: ENTRA_PROVIDER_ID, idToken: { token } })
      })
    )
    // Refused before the token is even looked at: the provider declares no ID-token
    // sign-in (`disableIdTokenSignIn`), so better-auth answers 404 ID_TOKEN_NOT_SUPPORTED.
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code?: string }).code).toBe('ID_TOKEN_NOT_SUPPORTED')
    expect(await userCount()).toBe(0)
  })

  it('a code Entra will not redeem fails the sign-in with the AADSTS code only', async () => {
    entra.failNext = {
      status: 400,
      error: 'invalid_grant',
      description: 'AADSTS54005: OAuth2 Authorization code was already redeemed'
    }
    const result = await signIn(assigned('mona-oid'))
    expect(result.error).toBe('invalid_code')
    expect(events()).toEqual(['auth.signin:failure'])
    expect(logged.join('\n')).toContain('AADSTS54005')
  })

  it('refreshing the Entra tokens authenticates with the assertion too', async () => {
    const ctx = await auth.$context
    const provider = ctx.socialProviders.find((p) => p.id === ENTRA_PROVIDER_ID)!
    const tokens = await provider.refreshAccessToken!('rt-old')
    expect(tokens.refreshToken).toBe('rt-rotated')
    expect(entra.requests[0]!.form.grant_type).toBe('refresh_token')
    expect(entra.requests[0]!.form.client_secret).toBeUndefined()
    expect(entra.requests[0]!.assertionHeader.alg).toBe('PS256')
  })

  it('getUserInfo outside a sign-in callback yields nothing (no verdict, no audit)', async () => {
    const ctx = await auth.$context
    const provider = ctx.socialProviders.find((p) => p.id === ENTRA_PROVIDER_ID)!
    const idToken = await entra.idToken(assigned('nina-oid'))
    expect(await provider.getUserInfo({ idToken })).toBeNull()
    expect(audit).toEqual([])
  })

  it('key material, the client assertion and tokens never reach a log line', async () => {
    await signIn(assigned('oscar-oid', { roles: [ENTRA_ADMIN_ROLE] }))
    await signIn(assigned('pat-oid', { amr: ['pwd'] }))
    await signIn(assigned('quinn-oid', { tid: OTHER_TENANT }))
    entra.failNext = { status: 401, error: 'invalid_client', description: 'AADSTS700027: bad' }
    await signIn(assigned('rita-oid'))
    expect(entra.requests.length).toBeGreaterThanOrEqual(4)
    // Something was logged (the failing exchange), so the check below is not vacuous.
    expect(logged.length).toBeGreaterThan(0)
    const text = logged.join('\n')
    const keyBody = hubCert.keyPem.split('\n').slice(1, -2).join('')
    expect(text).not.toContain('PRIVATE KEY')
    for (let i = 0; i + 40 <= keyBody.length; i += 40) {
      expect(text).not.toContain(keyBody.slice(i, i + 40))
    }
    for (const { form } of entra.requests) {
      expect(text).not.toContain(form.client_assertion!.split('.')[2]!)
      if (form.code) expect(text).not.toContain(form.code)
    }
    // The Entra tokens the hub received (T-11): no access or refresh token either.
    expect(entra.issued.length).toBeGreaterThan(0)
    for (const { access_token, refresh_token } of entra.issued) {
      expect(text).not.toContain(access_token)
      expect(text).not.toContain(refresh_token)
    }
    expect(text).not.toMatch(/eyJ[\w-]+\.eyJ[\w-]+\./)
    // The credential itself prints as an opaque object.
    expect(inspect(credential)).not.toContain(keyBody.slice(0, 40))
    expect(JSON.stringify(credential)).not.toContain(keyBody.slice(0, 40))
  })
})

// ---------------------------------------------------------------------------
// At rest (O-8, T-11): what the hub's own database file holds
// ---------------------------------------------------------------------------

describe('Entra tokens at rest', () => {
  /** Every byte better-auth has written for this database: the file and its WAL. */
  const dbBytes = (): Buffer =>
    Buffer.concat(
      [authDbPath, `${authDbPath}-wal`].filter((f) => existsSync(f)).map((f) => readFileSync(f))
    )

  it('O-8: the account row holds the refresh and access tokens encrypted with the auth secret, never in plaintext', async () => {
    const user = await sessionUser(await signIn(assigned('olga-oid')))
    const { access_token, refresh_token } = entra.issued.at(-1)!

    // The raw row, read past better-auth: what is actually on disk.
    const db = new DatabaseSync(authDbPath, { readOnly: true })
    const row = db
      .prepare('SELECT accessToken, refreshToken FROM account WHERE userId = ? AND providerId = ?')
      .get(user!.id, ENTRA_PROVIDER_ID) as { accessToken: string; refreshToken: string }
    db.close()
    for (const [stored, plain] of [
      [row.refreshToken, refresh_token],
      [row.accessToken, access_token]
    ] as const) {
      expect(stored).toBeTruthy()
      expect(stored).not.toContain(plain)
      // The key is the auth secret (SLAYZONE_HUB_AUTH_SECRET on a hub): better-auth's
      // XChaCha20-Poly1305 under SHA-256(secret). Any other key fails.
      expect(await symmetricDecrypt({ key: SECRET, data: stored })).toBe(plain)
      await expect(
        symmetricDecrypt({ key: `${SECRET}-not-the-hub-secret`, data: stored })
      ).rejects.toThrow()
    }
    // Nowhere else in the file either.
    const bytes = dbBytes()
    expect(bytes.includes(refresh_token)).toBe(false)
    expect(bytes.includes(access_token)).toBe(false)
  })

  it("the JWT plugin's private signing key is stored encrypted with the auth secret", async () => {
    const res = await auth.handler(new Request(`${BASE_URL}/api/auth/jwks`))
    expect(res.status).toBe(200)
    const db = new DatabaseSync(authDbPath, { readOnly: true })
    const rows = db.prepare('SELECT privateKey FROM jwks').all() as Array<{ privateKey: string }>
    db.close()
    expect(rows.length).toBeGreaterThan(0)
    for (const { privateKey } of rows) {
      expect(privateKey).not.toMatch(/"d"\s*:|PRIVATE KEY/)
      // Stored as a JSON string of the ciphertext.
      const data = JSON.parse(privateKey) as string
      const jwk = JSON.parse(await symmetricDecrypt({ key: SECRET, data })) as { d?: string }
      expect(jwk.d).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// The role rules of a hub with SSO (users.ts)
// ---------------------------------------------------------------------------

describe('SSO hub role rules', () => {
  it('manual role changes refuse with sso-managed, audited', async () => {
    const alice = await sessionUser(await signIn(assigned('alice-oid')))
    audit.length = 0
    expect(await setHubUserRole(auth, 'alice-oid@normain.test', 'admin')).toBe('sso-managed')
    expect(events()).toEqual(['user.role_change:denied'])
    expect(audit[0]).toMatchObject({ targetId: alice!.id, detail: { reason: 'sso_managed' } })
    expect((await listHubUsers(auth))[0]!.role).toBe('user')
  })

  it('an operator-created account is never admin: default user, --admin refused', async () => {
    const created = await createHubUser(auth, { email: 'first@normain.test' })
    expect('error' in created ? created.error : created.role).toBe('user')
    expect(await createHubUser(auth, { email: 'second@normain.test', role: 'admin' })).toEqual({
      error: 'sso-managed'
    })
  })

  it('no first-admin promotion: the hub has no admin until someone signs in with the role', async () => {
    await signIn(assigned('sam-oid'))
    expect(await ensureFirstAdmin(auth)).toBeNull()
    const reopened = await bootSso({}, authDbPath)
    expect((await listHubUsers(reopened)).some((u) => u.role === 'admin')).toBe(false)
  })

  it('switching a hub to SSO demotes every admin that has no Entra account', async () => {
    const dbPath = newDbPath()
    const plain = await createHubAuth({ dbPath, baseURL: BASE_URL, secret: SECRET })
    const owner = await createHubUser(plain, { email: 'owner@hub.test' })
    expect('error' in owner ? null : owner.role).toBe('admin')
    audit.length = 0

    const sso = await bootSso({}, dbPath)
    expect((await listHubUsers(sso))[0]!.role).toBe('user')
    expect(audit).toEqual([
      expect.objectContaining({
        event: 'user.role_change',
        outcome: 'success',
        detail: { reason: 'not_entra', role: 'user' }
      })
    ])

    // An admin that came from Entra keeps it across a reboot.
    const signedIn = await signIn(assigned('kalle-oid', { roles: [ENTRA_ADMIN_ROLE] }), {
      target: sso
    })
    const kalle = await sessionUser(signedIn, sso)
    const rebooted = await bootSso({}, dbPath)
    expect((await listHubUsers(rebooted)).find((u) => u.id === kalle!.id)?.role).toBe('admin')
  })
})

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

describe('loadEntraClientCredential', () => {
  const write = (name: string, content: string): string => {
    const path = join(tmpDir, name)
    writeFileSync(path, content)
    return path
  }

  it('reads a certificate and its key from one combined PEM', () => {
    const both = write('both.pem', `${hubCert.certPem}\n${hubCert.keyPem}`)
    const loaded = loadEntraClientCredential({ certPath: both, keyPath: both })
    expect(loaded.thumbprintS256).toBe(credential.thumbprintS256)
  })

  it('refuses a key that does not belong to the certificate', async () => {
    const other = await selfSigned(RSA_GEN, RSA_SIGN)
    const keyPath = write('other-key.pem', other.keyPem)
    expect(() =>
      loadEntraClientCredential({ certPath: join(tmpDir, 'cert.pem'), keyPath })
    ).toThrow(/does not belong to the certificate/)
  })

  it('refuses a non-RSA key (assertions are PS256)', async () => {
    const ec = await selfSigned(
      { name: 'ECDSA', namedCurve: 'P-256' },
      { name: 'ECDSA', hash: 'SHA-256', namedCurve: 'P-256' }
    )
    const certPath = write('ec-cert.pem', ec.certPem)
    const keyPath = write('ec-key.pem', ec.keyPem)
    expect(() => loadEntraClientCredential({ certPath, keyPath })).toThrow(/needs an RSA key/)
  })

  it('refuses an encrypted key', () => {
    const keyPath = write(
      'enc-key.pem',
      generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: 'x'
      }) as string
    )
    expect(() =>
      loadEntraClientCredential({ certPath: join(tmpDir, 'cert.pem'), keyPath })
    ).toThrow(/encrypted/)
  })

  it('names the missing file and never echoes file contents', () => {
    const missing = join(tmpDir, 'nope.pem')
    expect(() =>
      loadEntraClientCredential({ certPath: join(tmpDir, 'cert.pem'), keyPath: missing })
    ).toThrow(`cannot read the private key at ${missing} (ENOENT)`)
    const garbage = write(
      'garbage.pem',
      '-----BEGIN PRIVATE KEY-----\nnot-base64-SECRETBYTES\n-----END PRIVATE KEY-----\n'
    )
    let message = ''
    try {
      loadEntraClientCredential({ certPath: join(tmpDir, 'cert.pem'), keyPath: garbage })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('does not parse')
    expect(message).not.toContain('SECRETBYTES')
  })
})

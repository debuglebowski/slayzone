/**
 * Test support, not a test: a LOCAL generic OpenID issuer for the suites that drive a
 * real better-auth instance through generic OIDC sign-in (idp-roles.test.ts,
 * oidc.test.ts). Discovery, its own signing key + JWKS, an authorization-code token
 * endpoint that checks PKCE and the client's authentication (HTTP Basic secret, or a
 * `private_key_jwt` assertion against the hub's certificate), and a refresh-token grant
 * whose answers a test scripts. Everything over real HTTP on 127.0.0.1.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, importX509, jwtVerify, SignJWT } from 'jose'

export const OIDC_CLIENT_ID = 'slayzone-hub-test'
export const OIDC_CLIENT_SECRET = 'test-client-secret-not-real'

/** What one issued ID token says. `iatOffset`: seconds added to now (negative = older). */
export interface IssuedClaims {
  sub: string
  email?: string
  /** Any extra claims (`roles`, `groups`, `realm_access`, …). `undefined` values drop the key. */
  extra?: Record<string, unknown>
  iatOffset?: number
  /** Exact `iat` (overrides iatOffset); `null` omits it. */
  iat?: number | null
}

/** How the next refresh is answered. The last entry repeats. */
export type RefreshAnswer =
  | {
      kind: 'tokens'
      claims?: Partial<IssuedClaims>
      /** No ID token in the response (access-token-only refresh). */
      omitIdToken?: boolean
      /** `undefined`: rotate to a fresh token. `null`: no `refresh_token` in the answer. */
      rotate?: string | null
      /** Hold the answer until this resolves (concurrency tests). */
      hold?: Promise<void>
    }
  | { kind: 'error'; status: number; error: string; hold?: Promise<void> }

export class FakeOidcIssuer {
  server!: Server
  origin = ''
  /** `<origin>/realms/test` — exactly the `iss` of every token. */
  issuer = ''
  readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  refreshAnswers: RefreshAnswer[] = [{ kind: 'tokens' }]
  /** Refresh requests seen, with the refresh token presented. */
  readonly refreshes: string[] = []
  /** The token-endpoint client authentication seen: `basic` or `assertion:<alg>:<kid>`. */
  readonly clientAuth: string[] = []
  private readonly codes = new Map<
    string,
    { challenge: string; redirect: string; claims: IssuedClaims }
  >()
  /** Refresh token → the claims of the sign-in it descends from. */
  private readonly families = new Map<string, IssuedClaims>()

  constructor(private readonly opts: { hubCertPem?: string; assertionAlgs?: string[] } = {}) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    this.issuer = `${this.origin}/realms/test`
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()))
  }

  /** The authorize leg: the user "signs in" with these claims. */
  issueCode(authorize: URL, claims: IssuedClaims): string {
    const code = `code-${randomBytes(8).toString('hex')}`
    this.codes.set(code, {
      challenge: authorize.searchParams.get('code_challenge') ?? '',
      redirect: authorize.searchParams.get('redirect_uri') ?? '',
      claims
    })
    return code
  }

  async idToken(c: IssuedClaims, signWith = this.key.privateKey): Promise<string> {
    const now = Math.floor(Date.now() / 1000)
    const payload: Record<string, unknown> = {
      sub: c.sub,
      email: c.email ?? `${c.sub}@example.test`,
      name: c.sub
    }
    for (const [k, v] of Object.entries(c.extra ?? {})) if (v !== undefined) payload[k] = v
    const jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(this.issuer)
      .setAudience(OIDC_CLIENT_ID)
      .setExpirationTime(now + 3600)
    const iat = c.iat === undefined ? now + (c.iatOffset ?? 0) : c.iat
    if (iat !== null) jwt.setIssuedAt(iat)
    return jwt.sign(signWith)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/realms/test/.well-known/openid-configuration') {
      send(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/keys`,
        ...(this.opts.assertionAlgs
          ? { token_endpoint_auth_signing_alg_values_supported: this.opts.assertionAlgs }
          : {})
      })
      return
    }
    if (url.pathname === '/realms/test/keys') {
      send(200, { keys: [{ ...(await exportJWK(this.key.publicKey)), kid: 'k1', use: 'sig' }] })
      return
    }
    if (url.pathname !== '/realms/test/token' || req.method !== 'POST') {
      send(404, { error: 'not_found' })
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const form = Object.fromEntries(new URLSearchParams(raw))
    if (!(await this.clientOk(req, form))) {
      send(401, { error: 'invalid_client' })
      return
    }
    if (form.grant_type === 'authorization_code') {
      const issued = this.codes.get(form.code ?? '')
      this.codes.delete(form.code ?? '')
      const challenge = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url')
      if (!issued || issued.challenge !== challenge || issued.redirect !== form.redirect_uri) {
        send(400, { error: 'invalid_grant' })
        return
      }
      const rt = `rt-${randomBytes(6).toString('hex')}`
      this.families.set(rt, issued.claims)
      send(200, {
        token_type: 'Bearer',
        access_token: 'at',
        expires_in: 3600,
        refresh_token: rt,
        id_token: await this.idToken(issued.claims)
      })
      return
    }
    if (form.grant_type === 'refresh_token') {
      const presented = form.refresh_token ?? ''
      this.refreshes.push(presented)
      const answer =
        this.refreshAnswers.length > 1 ? this.refreshAnswers.shift()! : this.refreshAnswers[0]!
      if (answer.kind === 'error') {
        await answer.hold
        send(answer.status, { error: answer.error })
        return
      }
      await answer.hold
      const family = this.families.get(presented)
      if (!family) {
        send(400, { error: 'invalid_grant' })
        return
      }
      const claims: IssuedClaims = {
        ...family,
        ...answer.claims,
        extra: { ...family.extra, ...answer.claims?.extra }
      }
      const rotate =
        answer.rotate === undefined ? `rt-${randomBytes(6).toString('hex')}` : answer.rotate
      if (rotate) this.families.set(rotate, family)
      send(200, {
        token_type: 'Bearer',
        access_token: 'at2',
        expires_in: 3600,
        ...(rotate ? { refresh_token: rotate } : {}),
        ...(answer.omitIdToken ? {} : { id_token: await this.idToken(claims) })
      })
      return
    }
    send(400, { error: 'unsupported_grant_type' })
  }

  private async clientOk(req: IncomingMessage, form: Record<string, string>): Promise<boolean> {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (basic) {
      this.clientAuth.push('basic')
      const [id, secret] = Buffer.from(basic, 'base64').toString().split(':')
      return (
        decodeURIComponent(id ?? '') === OIDC_CLIENT_ID &&
        decodeURIComponent(secret ?? '') === OIDC_CLIENT_SECRET
      )
    }
    if (form.client_assertion && this.opts.hubCertPem) {
      try {
        const [h] = form.client_assertion.split('.')
        const header = JSON.parse(Buffer.from(h ?? '', 'base64url').toString()) as {
          alg: string
          kid?: string
        }
        this.clientAuth.push(`assertion:${header.alg}:${header.kid ? 'kid' : 'nokid'}`)
        await jwtVerify(form.client_assertion, await importX509(this.opts.hubCertPem, header.alg), {
          audience: `${this.issuer}/token`,
          issuer: OIDC_CLIENT_ID,
          subject: OIDC_CLIENT_ID
        })
        return true
      } catch {
        return false
      }
    }
    return false
  }
}

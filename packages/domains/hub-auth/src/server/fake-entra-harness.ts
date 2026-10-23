/**
 * Test support, not a test: a LOCAL fake Entra for the suites that drive a real
 * better-auth instance with Entra sign-in through the browser flow (device.test.ts,
 * web-sign-in.test.ts) — its own signing key + JWKS, and a token endpoint that checks
 * the hub's client assertion and PKCE, as in entra.test.ts. Plus the hub's certificate.
 */
import { createHash, generateKeyPairSync, KeyObject, randomBytes, webcrypto } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { exportJWK, importX509, jwtVerify, SignJWT } from 'jose'
import { ENTRA_USER_ROLE } from './entra'

export const TENANT = '11111111-2222-3333-4444-555555555555'
export const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const crypto = webcrypto as unknown as Crypto

// Fake Entra (compact twin of entra.test.ts's)

export interface Claims {
  oid: string
  roles?: string[]
  amr?: string[]
}

export class FakeEntra {
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

/** A self-signed certificate + key for the hub, written to `dir` (PEM). */
export async function writeHubCredential(
  dir: string
): Promise<{ certPem: string; certPath: string; keyPath: string }> {
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
      name: 'CN=SlayZone hub test',
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000),
      signingAlgorithm: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      keys
    },
    crypto
  )
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  writeFileSync(certPath, cert.toString('pem'))
  writeFileSync(
    keyPath,
    KeyObject.from(keys.privateKey).export({ type: 'pkcs8', format: 'pem' }) as string
  )
  return { certPem: cert.toString('pem'), certPath, keyPath }
}

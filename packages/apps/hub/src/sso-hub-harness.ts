/**
 * Test support, not a test: a REAL built hub with Entra sign-in on, against a LOCAL fake
 * Entra, plus a browser (cookie jar, manual redirects) — for the suites that drive the
 * hub's Entra flows end to end (hub-device-sign-in.test.ts, hub-app-sign-in.test.ts).
 *
 * Entra is a LOCAL fake (own signing key, JWKS, a token endpoint that verifies the hub's
 * PS256 client assertion and the PKCE verifier). The hub has no setting that points it
 * anywhere but Microsoft (T-09, deliberately), so the hub process is started with a
 * test-only `--import` preload that sends its outbound `fetch` for
 * `https://login.microsoftonline.com/…` to the fake instead. Nothing reaches Microsoft;
 * no product code knows about the preload.
 */
import { expect } from 'vitest'
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import {
  constants,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate
} from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const HUB_DIR = join(__dirname, '..')
export const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')

export const TENANT = '11111111-2222-3333-4444-555555555555'
export const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
export const MICROSOFT = 'https://login.microsoftonline.com'
export const PUBLIC = 'hub.example.com'
export const PUBLIC_ORIGIN = `https://${PUBLIC}`

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** Run a command to its end (async: never blocks the test's own event loop). */
export function runToEnd(command: string, args: string[], opts: SpawnOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'ignore', ...opts })
    proc.once('error', reject)
    proc.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    )
  })
}

/** Build `pkgDir` (its `build.mjs`) when `bin` is missing or older than its sources. */
export async function ensureBuilt(pkgDir: string, bin: string): Promise<void> {
  if (existsSync(bin) && newestMtime(join(pkgDir, 'src')) <= statSync(bin).mtimeMs) return
  await runToEnd('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`build did not produce ${bin}`)
}

// vitest injects these into the test process (TEST=true flips better-auth's isTest()
// → its origin/CSRF check off); a spawned bin must not inherit them.
const VITEST_INJECTED = /^(VITEST(_.*)?|TEST|MODE|DEV|PROD|SSR|BASE_URL)$/

export function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (VITEST_INJECTED.test(k)) continue
    if (v == null || /^(SLAYZONE_|ELECTRON_|SSH_)/.test(k) || k === 'DISPLAY') continue
    out[k] = v
  }
  return out
}

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')

// ---------------------------------------------------------------------------
// Fake Entra, answering as https://login.microsoftonline.com
// ---------------------------------------------------------------------------

export interface Claims {
  oid: string
  amr: string[]
}

export class FakeEntra {
  server!: Server
  origin = ''
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private readonly codes = new Map<
    string,
    { challenge: string; redirect: string; claims: Claims }
  >()
  constructor(private readonly hubCert: X509Certificate) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
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

  private idToken(c: Claims): string {
    const now = Math.floor(Date.now() / 1000)
    const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${b64url({
      ver: '2.0',
      iss: `${MICROSOFT}/${TENANT}/v2.0`,
      tid: TENANT,
      oid: c.oid,
      sub: `pairwise-${c.oid}`,
      aud: CLIENT_ID,
      iat: now,
      nbf: now,
      exp: now + 3600,
      name: c.oid,
      email: `${c.oid}@normain.test`,
      roles: ['SlayZone.User'],
      amr: c.amr
    })}`
    return `${input}.${sign('sha256', Buffer.from(input), this.key.privateKey).toString('base64url')}`
  }

  /** The hub's client assertion: PS256 by the hub's certificate, for this token endpoint. */
  private assertionOk(jwt: string): boolean {
    const [h, p, s] = jwt.split('.')
    if (!h || !p || !s) return false
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      {
        key: this.hubCert.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST
      },
      Buffer.from(s, 'base64url')
    )
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>
    return (
      ok && claims.aud === `${MICROSOFT}/${TENANT}/oauth2/v2.0/token` && claims.iss === CLIENT_ID
    )
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const path = new URL(req.url ?? '/', this.origin).pathname
    if (path === `/${TENANT}/discovery/v2.0/keys`) {
      const jwk = this.key.publicKey.export({ format: 'jwk' })
      send(200, { keys: [{ ...jwk, kid: 'k1', use: 'sig', alg: 'RS256' }] })
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const form = Object.fromEntries(new URLSearchParams(raw))
    if (path !== `/${TENANT}/oauth2/v2.0/token` || !this.assertionOk(form.client_assertion ?? '')) {
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
    send(200, {
      token_type: 'Bearer',
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      id_token: this.idToken(issued.claims)
    })
  }
}

/** Test-only preload for the hub process: Microsoft's origin → the fake. */
export const PRELOAD = `
const target = process.env.SLZ_TEST_ENTRA_ORIGIN
const original = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (target && url.startsWith('${MICROSOFT}/')) {
    return original(target + url.slice(${MICROSOFT.length}), init)
  }
  return original(input, init)
}
`

// ---------------------------------------------------------------------------
// Hub and browser
// ---------------------------------------------------------------------------

export interface Hub {
  proc: ChildProcess
  logs: string[]
  base: string
  stop: () => Promise<void>
}

/**
 * Start the built hub under Electron's node (`electronBin`: the test resolves it — the
 * hub's sources, this file included, never import electron).
 */
export async function startHub(
  electronBin: string,
  root: string,
  env: Record<string, string>,
  preload?: string
): Promise<Hub> {
  const logs: string[] = []
  const args = preload ? ['--import', pathToFileURL(preload).href, HUB_BIN] : [HUB_BIN]
  const proc = spawn(electronBin, args, {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  const started = Date.now()
  for (;;) {
    const line = logs.find((l) => l.includes('listening on http://'))
    const port = line?.match(/http:\/\/[^:]+:(\d+)/)?.[1]
    if (port) {
      const base = `http://127.0.0.1:${port}`
      if ((await fetch(`${base}/health`).catch(() => null))?.ok) return { proc, logs, base, stop }
    }
    if (proc.exitCode !== null || Date.now() - started > 40_000) {
      await stop()
      throw new Error(`hub did not come up:\n${logs.join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function waitFor<T>(
  fn: () => T | null | undefined,
  label: string,
  ms = 30_000
): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

export class Browser {
  private readonly jar = new Map<string, string>()
  constructor(
    private readonly hub: Hub,
    private readonly entra: FakeEntra
  ) {}

  private store(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (/max-age=0/i.test(c)) this.jar.delete(pair.slice(0, eq))
      else this.jar.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
  }

  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** A path on the hub, reached through its loopback listener (the "front end"). */
  async get(pathAndQuery: string): Promise<Response> {
    const res = await fetch(`${this.hub.base}${pathAndQuery}`, {
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
    const res = await fetch(`${this.hub.base}${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual'
    })
    this.store(res)
    return res
  }

  /** Open a hub page; sign in at "Entra" when sent there; land back on the hub. */
  async open(page: URL | string, claims: Claims): Promise<Response> {
    const first = await this.get(typeof page === 'string' ? page : page.pathname + page.search)
    if (first.status !== 302) return first
    const authorize = new URL(first.headers.get('location') ?? '')
    expect(
      authorize.origin,
      `the page sends the browser to Microsoft, got ${authorize.origin}`
    ).toBe(MICROSOFT)
    const code = this.entra.issueCode(authorize, claims)
    const state = authorize.searchParams.get('state') ?? ''
    const callback = await this.get(`/api/auth/callback/microsoft?code=${code}&state=${state}`)
    expect(callback.status, `callback redirects, got ${callback.status}`).toBe(302)
    const back = new URL(callback.headers.get('location') ?? '/', PUBLIC_ORIGIN)
    return this.get(back.pathname + back.search)
  }
}

export const MFA: Claims = { oid: 'ada', amr: ['pwd', 'mfa'] }

/**
 * The fake Entra and a hub with Entra sign-in on and password sign-in off, its root in
 * `<tmp>/sso-hub`. The hub's certificate and the preload are written to `tmp`.
 */
export async function startSsoHub(
  electronBin: string,
  tmp: string,
  env: Record<string, string> = {}
): Promise<{ hub: Hub; entra: FakeEntra }> {
  const certPath = join(tmp, 'sso-cert.pem')
  const keyPath = join(tmp, 'sso-key.pem')
  await runToEnd('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=slz-sso-hub-test',
    '-keyout',
    keyPath,
    '-out',
    certPath
  ])
  const preload = join(tmp, 'entra-fetch-preload.mjs')
  writeFileSync(preload, PRELOAD)
  const entra = new FakeEntra(new X509Certificate(readFileSync(certPath)))
  await entra.start()
  const root = join(tmp, 'sso-hub')
  mkdirSync(root)
  const hub = await startHub(
    electronBin,
    root,
    {
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_PUBLIC_ADDRESS: PUBLIC,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_AUTH_SECRET: 'sso-hub-test-only-signing-secret-0123456789abcdef',
      SLAYZONE_HUB_ENABLE_SSO: '1',
      SLAYZONE_HUB_ENABLE_PASSWORD: '0',
      SLAYZONE_HUB_SSO_TENANT_ID: TENANT,
      SLAYZONE_HUB_SSO_CLIENT_ID: CLIENT_ID,
      SLAYZONE_HUB_SSO_CERT_PATH: certPath,
      SLAYZONE_HUB_SSO_KEY_PATH: keyPath,
      SLZ_TEST_ENTRA_ORIGIN: entra.origin,
      ...env
    },
    preload
  )
  return { hub, entra }
}

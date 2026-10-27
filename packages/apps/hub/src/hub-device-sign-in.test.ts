/**
 * Device sign-in (T-14) through the REAL built hub and the REAL built CLI: a hub with
 * Entra sign-in on and password sign-in off, `slay hub login` run as a child process,
 * and the browser leg driven over HTTP the way a browser would (cookie jar, Origin).
 *
 * Entra is a LOCAL fake (own signing key, JWKS, a token endpoint that verifies the hub's
 * PS256 client assertion and the PKCE verifier). The hub has no setting that points it
 * anywhere but Microsoft (T-09, deliberately), so the hub process is started with a
 * test-only `--import` preload that sends its outbound `fetch` for
 * `https://login.microsoftonline.com/…` to the fake instead. Nothing reaches Microsoft;
 * no product code knows about the preload.
 *
 * Proves: the CLI's device sign-in completes after browser approval with MFA and its
 * bearer works on the REST API; denial is a clean CLI error; no token without MFA;
 * `slay hub login --email` is refused on a hub with password sign-in off; the audit
 * lines name the flow and carry no code or token; `MISSING_OR_NULL_ORIGIN` no longer
 * hits `slay hub login` (password sign-in on a password hub) while a cookie request with
 * no Origin is still refused.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  constants,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const CLI_DIR = join(__dirname, '..', '..', 'cli')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const ELECTRON_BIN = require('electron') as unknown as string
const NODE_BIN = process.env.SLZ_TEST_NODE ?? 'node'

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const MICROSOFT = 'https://login.microsoftonline.com'
const PUBLIC = 'hub.example.com'
const PUBLIC_ORIGIN = `https://${PUBLIC}`

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(pkgDir: string, bin: string): void {
  if (existsSync(bin) && newestMtime(join(pkgDir, 'src')) <= statSync(bin).mtimeMs) return
  execFileSync('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`build did not produce ${bin}`)
}

// vitest injects these into the test process (TEST=true flips better-auth's isTest()
// → its origin/CSRF check off); a spawned bin must not inherit them.
const VITEST_INJECTED = /^(VITEST(_.*)?|TEST|MODE|DEV|PROD|SSR|BASE_URL)$/

function scrubbedEnv(): Record<string, string> {
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

interface Claims {
  oid: string
  amr: string[]
}

class FakeEntra {
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
const PRELOAD = `
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
// Hub, CLI and browser
// ---------------------------------------------------------------------------

interface Hub {
  proc: ChildProcess
  logs: string[]
  base: string
  stop: () => Promise<void>
}

async function startHub(root: string, env: Record<string, string>, preload?: string): Promise<Hub> {
  const logs: string[] = []
  const args = preload ? ['--import', pathToFileURL(preload).href, HUB_BIN] : [HUB_BIN]
  const proc = spawn(ELECTRON_BIN, args, {
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

interface Cli {
  out: () => string
  exit: Promise<number | null>
  kill: () => void
}

function runCli(home: string, args: string[]): Cli {
  let out = ''
  const proc = spawn(NODE_BIN, [CLI_BIN, ...args], {
    env: { ...scrubbedEnv(), HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  proc.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  return {
    out: () => out,
    exit: new Promise((r) => proc.once('exit', (code) => r(code))),
    kill: () => proc.kill('SIGKILL')
  }
}

async function waitFor<T>(fn: () => T | null | undefined, label: string, ms = 30_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** The page + code `slay hub login` printed. The page is on the public address. */
async function printedCode(cli: Cli): Promise<{ page: URL; code: string }> {
  const code = await waitFor(
    () => /shows this code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.out())?.[1],
    `the CLI to print a code:\n${cli.out()}`
  )
  const page = /^\s+(https:\/\/\S+)$/m.exec(cli.out())?.[1]
  expect(page, `the CLI printed the page: ${cli.out()}`).toBeTruthy()
  return { page: new URL(page!), code }
}

class Browser {
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

  /** Open the printed page; sign in at "Entra" when sent there; land on the page. */
  async open(page: URL, claims: Claims): Promise<Response> {
    const first = await this.get(page.pathname + page.search)
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

const MFA: Claims = { oid: 'ada', amr: ['pwd', 'mfa'] }

// ---------------------------------------------------------------------------

let tmp = ''
let entra: FakeEntra
let hub: Awaited<ReturnType<typeof startHub>>
const secrets: string[] = []

beforeAll(async () => {
  ensureBuilt(HUB_DIR, HUB_BIN)
  ensureBuilt(CLI_DIR, CLI_BIN)
  tmp = mkdtempSync(join(tmpdir(), 'slz-hub-device-'))
  const certPath = join(tmp, 'sso-cert.pem')
  const keyPath = join(tmp, 'sso-key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=slz-device-test'
    ].concat(['-keyout', keyPath, '-out', certPath]),
    { stdio: 'ignore' }
  )
  const preload = join(tmp, 'entra-fetch-preload.mjs')
  writeFileSync(preload, PRELOAD)
  entra = new FakeEntra(new X509Certificate(readFileSync(certPath)))
  await entra.start()
  const ssoRoot = join(tmp, 'sso-hub')
  mkdirSync(ssoRoot)
  hub = await startHub(
    ssoRoot,
    {
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_PUBLIC_ADDRESS: PUBLIC,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_AUTH_SECRET: 'device-test-only-signing-secret-0123456789abcdef',
      SLAYZONE_HUB_ENABLE_SSO: '1',
      SLAYZONE_HUB_ENABLE_PASSWORD: '0',
      SLAYZONE_HUB_SSO_TENANT_ID: TENANT,
      SLAYZONE_HUB_SSO_CLIENT_ID: CLIENT_ID,
      SLAYZONE_HUB_SSO_CERT_PATH: certPath,
      SLAYZONE_HUB_SSO_KEY_PATH: keyPath,
      SLZ_TEST_ENTRA_ORIGIN: entra.origin
    },
    preload
  )
})

afterAll(async () => {
  await entra?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('a hub with Entra sign-in on and password sign-in off', () => {
  afterAll(async () => {
    await hub?.stop()
  })

  test('the hub reports SSO on and password off', async () => {
    const health = (await (await fetch(`${hub.base}/health`)).json()) as {
      switches?: Record<string, boolean>
    }
    expect(health.switches?.enableSso, 'enableSso').toBe(true)
    expect(health.switches?.enablePassword, 'enablePassword off').toBe(false)
  })

  test('slay hub login: device sign-in, browser approval with MFA, bearer works on REST', async () => {
    const home = join(tmp, 'home-ok')
    const cli = runCli(home, ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      expect(page.origin, `page on the public address, got ${page.origin}`).toBe(PUBLIC_ORIGIN)
      expect(page.pathname, `page path, got ${page.pathname}`).toBe('/device')
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      const view = await browser.open(page, MFA)
      const html = await view.text()
      expect(view.status, `approval page, got ${view.status}: ${html.slice(0, 300)}`).toBe(200)
      expect(html, 'the page shows the same code').toContain(code)
      expect(html, 'the page names the client').toContain('SlayZone CLI (slay)')
      expect(html, 'the page names the hub').toContain(PUBLIC)
      expect(!/<script/i.test(html), 'no script on the page').toBe(true)
      // A cookie-authenticated POST without an Origin is refused.
      const noOrigin = await browser.post('/device/approve', { user_code: code }, null)
      expect(noOrigin.status, `no Origin → 403, got ${noOrigin.status}`).toBe(403)
      const ok = await browser.post('/device/approve', { user_code: code }, PUBLIC_ORIGIN)
      expect(ok.status, `approve → 200, got ${ok.status}`).toBe(200)
      const exit = await Promise.race([
        cli.exit,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))
      ])
      expect(exit, `CLI exit 0, got ${String(exit)}:\n${cli.out()}`).toBe(0)
      expect(cli.out(), `signed-in line:\n${cli.out()}`).toContain('as ada@normain.test')
      const stored = JSON.parse(
        readFileSync(join(home, '.slayzone', 'cli', 'hub-target.json'), 'utf8')
      ) as { url: string; token: string }
      secrets.push(stored.token)
      const tasks = await fetch(`${hub.base}/api/tasks`, {
        headers: { authorization: `Bearer ${stored.token}` }
      })
      expect(tasks.status, `GET /api/tasks with the bearer → 200, got ${tasks.status}`).toBe(200)
      const none = await fetch(`${hub.base}/api/tasks`)
      expect(none.status, `without it → 401, got ${none.status}`).toBe(401)

      // The browser's session cookie without an Origin is still refused by better-auth.
      const signOut = await fetch(`${hub.base}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: browser.cookie, 'content-type': 'application/json' },
        body: '{}'
      })
      const body = await signOut.text()
      expect(
        signOut.status,
        `cookie + no Origin → 403 MISSING_OR_NULL_ORIGIN, got ${signOut.status} ${body}`
      ).toBe(403)
      expect(
        body,
        `cookie + no Origin → 403 MISSING_OR_NULL_ORIGIN, got ${signOut.status} ${body}`
      ).toContain('MISSING_OR_NULL_ORIGIN')
    } finally {
      cli.kill()
    }
  })

  test('denial in the browser ends slay hub login with a clean error', async () => {
    const cli = runCli(join(tmp, 'home-deny'), ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      expect((await browser.open(page, MFA)).status, 'approval page').toBe(200)
      const denied = await browser.post('/device/deny', { user_code: code }, PUBLIC_ORIGIN)
      expect(denied.status, `deny → 200, got ${denied.status}`).toBe(200)
      const exit = await cli.exit
      expect(exit, `CLI exit 1, got ${String(exit)}`).toBe(1)
      expect(cli.out(), `denied message:\n${cli.out()}`).toContain('denied in the browser')
    } finally {
      cli.kill()
    }
  })

  test('no token without MFA: the sign-in is refused, the CLI keeps waiting', async () => {
    const cli = runCli(join(tmp, 'home-nomfa'), ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      const view = await browser.open(page, { oid: 'bob', amr: ['pwd'] })
      expect(view.status, `refused sign-in page, got ${view.status}`).toBe(401)
      const approve = await browser.post('/device/approve', { user_code: code }, PUBLIC_ORIGIN)
      expect(approve.status, `no session → approve refused, got ${approve.status}`).toBe(401)
      await new Promise((r) => setTimeout(r, 6_000))
      expect(cli.out(), 'still waiting').toContain('Waiting for approval')
      expect(cli.out(), `no token:\n${cli.out()}`).not.toContain('Signed in')
      expect(
        hub.logs.some((l) => l.includes('"event":"auth.signin"') && l.includes('"no_mfa"')),
        'auth.signin denied no_mfa audited'
      ).toBeTruthy()
    } finally {
      cli.kill()
    }
  })

  test('slay hub login --email is refused on a hub with password sign-in off', async () => {
    const cli = runCli(join(tmp, 'home-pw'), [
      'hub',
      'login',
      hub.base,
      '--email',
      'ada@normain.test',
      '--password',
      'x'
    ])
    const exit = await cli.exit
    expect(exit, `exit 1, got ${String(exit)}`).toBe(1)
    expect(cli.out(), `message:\n${cli.out()}`).toContain('Password sign-in is off')
  })

  test('audit: the flow is on the record, no code or token in any line', async () => {
    const security = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
    const events = security.map((l) => {
      const e = JSON.parse(l) as { event: string; outcome: string; detail: { method?: string } }
      return `${e.event}:${e.outcome}${e.detail.method ? `:${e.detail.method}` : ''}`
    })
    for (const want of [
      'auth.device.code:success',
      'auth.device.approve:success',
      'auth.device.deny:success',
      'auth.signin:success:sso',
      'auth.signin:success:device'
    ]) {
      expect(events, `${want} audited (got ${events.join(', ')})`).toContain(want)
    }
    const all = hub.logs.join('\n')
    for (const s of secrets) expect(all, 'no code or token in the hub output').not.toContain(s)
  })
})

// A hub with password sign-in (no SSO): the CLI's password path. `fetch` sent
// `Sec-Fetch-Mode: cors`, which better-auth answered MISSING_OR_NULL_ORIGIN.
test('MISSING_OR_NULL_ORIGIN no longer hits slay hub login (password hub)', async () => {
  const root = join(tmp, 'pw-hub')
  mkdirSync(root)
  const pwHub = await startHub(root, {
    SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1'
  })
  try {
    const owner = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(root, 'hub.owner.json'), 'utf8')) as {
          email: string
          password: string
        }
      } catch {
        return null
      }
    }, 'hub.owner.json')
    const cli = runCli(join(tmp, 'home-pwhub'), [
      'hub',
      'login',
      pwHub.base,
      '--email',
      owner.email,
      '--password',
      owner.password
    ])
    const exit = await cli.exit
    expect(exit, `exit 0, got ${String(exit)}:\n${cli.out()}`).toBe(0)
    expect(cli.out(), 'no 403').not.toContain('403')
  } finally {
    await pwHub.stop()
  }
})

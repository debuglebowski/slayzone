/**
 * The boot rules against the REAL built hub (dist/bin.cjs): each refusal exits
 * non-zero with a message naming the variable and — the point of "refuses to start" —
 * before the hub has opened its database, written a state file or listened on a port.
 * `boot-rules.test.ts` pins every rule as a pure function; this proves the bin actually
 * runs them, in order, ahead of anything else, and that the hub which DOES boot behaves
 * as the switches say.
 *
 * What boots:
 *   - the defaults, on loopback: login off, password on, SSO off, processes +
 *     integrations on — reported by `/health`, with no `mode`;
 *   - a hub on loopback behind a public address (a same-box reverse proxy) with login
 *     and the secret in env: it serves plain http (no TLS of its own), needs a bearer,
 *     mints a `wss://<public address>/computers` join token with NO pin, creates no
 *     `identity/` directory and writes no `hub.state.json` or `hub.owner.json` (its
 *     owner's password derives from the secret, T-11);
 *   - a leftover `SLAYZONE_MODE` changes nothing;
 *   - a hub with Entra sign-in: its two sign-in routes pass the gate, its redirect URI
 *     is on the public address, and it provisions no bootstrap owner.
 *   - password sign-in off (T-10): every password route 403s with the switch code and
 *     an audit line, no owner file and no password in the logs, a password account
 *     from before cannot sign in.
 *   - break-glass v2 (O-9, O-23): the operator command on the box opens a grant over
 *     the hub's local socket, the verifier redeems it once for an admin session that
 *     revokes a computer and reads no content, the operator's end command closes it; a
 *     crash mid-session is closed at the next boot, v1's file is removed, nothing secret
 *     lands on disk. The desktop app's (login-off) hub has none of it. The end AT THE TTL
 *     is break-glass.test.ts's, on a fake clock: the shortest TTL is 1m, and waiting it
 *     out here made this the slowest file of the unit run.
 *
 * Isolation: every hub runs in its own throwaway SLAYZONE_ROOT with every inherited
 * SLAYZONE_ and ELECTRON_ prefixed env var scrubbed (a task terminal leaks the dial-side
 * SLAYZONE_HUB_ADDRESS, which the hub itself would — correctly — refuse), on a loopback
 * port the OS picks (`:0`).
 *
 * Native ABI: better-sqlite3 needs Electron's node, so this runs under vitest on
 * `ELECTRON_RUN_AS_NODE=1 electron`.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, expect, test } from 'vitest'
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(): void {
  let needs = !existsSync(HUB_BIN)
  if (!needs) needs = newestMtime(join(HUB_DIR, 'src')) > statSync(HUB_BIN).mtimeMs
  if (!needs) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

/** Inherited env minus every SLAYZONE_/ELECTRON_ key. */
// vitest injects these into the test process (TEST=true flips better-auth's isTest()
// → its origin/CSRF check off); a spawned bin must not inherit them.
const VITEST_INJECTED = /^(VITEST(_.*)?|TEST|MODE|DEV|PROD|SSR|BASE_URL)$/

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (VITEST_INJECTED.test(k)) continue
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  return out
}

interface Proc {
  proc: ChildProcess
  logs: string[]
  exit: Promise<number | null>
  stop: () => Promise<void>
}

function spawnHub(root: string, env: Record<string, string>): Proc {
  const logs: string[] = []
  // stdin is a real PIPE held open: a hub started by the desktop app treats stdin EOF
  // as "my parent died" and exits.
  const proc = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
  return {
    proc,
    logs,
    exit,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        proc.kill('SIGTERM')
      })
  }
}

/** Run the built bin with `args` (an operator command, not a hub): exit code + output. */
function runBin(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(ELECTRON_BIN, [HUB_BIN, ...args], {
    env: { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000
  })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'slz-hub-boot-'))
  roots.push(root)
  return root
}

/** Files a hub that got as far as opening its store would leave in its ROOT. */
function bootArtifacts(root: string): string[] {
  const names = readdirSync(root)
  return names.filter(
    (n) => n.endsWith('.sqlite') || n === 'hub.state.json' || n === 'identity' || n === 'logs'
  )
}

/** Boot must be REFUSED: non-zero exit, the message names `needles`, and nothing was opened. */
function assertRefused(
  label: string,
  env: Record<string, string>,
  needles: string[],
  files?: Record<string, unknown>
): void {
  test(label, async () => {
    const root = newRoot()
    for (const [name, content] of Object.entries(files ?? {})) {
      writeFileSync(join(root, name), JSON.stringify(content))
    }
    const hub = spawnHub(root, env)
    try {
      const code = await Promise.race([
        hub.exit,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 40_000))
      ])
      expect(code, `hub did not exit (should have refused):\n${hub.logs.join('\n')}`).not.toBe(
        'timeout'
      )
      expect(code, `exit code should be non-zero, got ${String(code)}`).not.toBe(0)
      const out = hub.logs.join('\n')
      expect(out, `a refused hub must not listen:\n${out}`).not.toContain('listening on http')
      for (const n of needles) expect(out, `message should mention '${n}'`).toContain(n)
      // One audit line on stdout before exit (T-03), naming the rule.
      const audit = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
      expect(audit.length, `one security line, got ${audit.length}:\n${out}`).toBe(1)
      const event = JSON.parse(audit[0]!) as {
        event: string
        outcome: string
        detail: { rule?: unknown }
      }
      expect(event.event, `hub.boot denied: ${audit[0]}`).toBe('hub.boot')
      expect(event.outcome, `hub.boot denied: ${audit[0]}`).toBe('denied')
      expect(typeof event.detail.rule, `rule named: ${audit[0]}`).toBe('string')
      expect(event.detail.rule, `rule named: ${audit[0]}`).toBeTruthy()
      // Refused BEFORE the data directory was touched: no database, no generated
      // state, no certificate identity, no log directory.
      const artifacts = bootArtifacts(root)
      expect(artifacts.length, `refusal must precede any boot work, found: ${artifacts}`).toBe(0)
    } finally {
      await hub.stop()
    }
  })
}

async function bootAndGetPort(hub: Proc): Promise<number> {
  const line = await poll(
    async () => hub.logs.find((l) => l.includes('listening on http://')) ?? null,
    30_000,
    `hub listening line (logs:\n${hub.logs.join('\n')})`
  )
  const m = line.match(/http:\/\/([^:]+):(\d+)/)
  expect(m, `listening line parseable: ${line}`).toBeTruthy()
  const port = Number(m![2])
  await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      })
      return r.ok ? true : null
    },
    15_000,
    'hub /health ok'
  )
  return port
}

/** The audit lines (T-03) a hub wrote to stdout. */
function securityLines(
  hub: Proc
): Array<Record<string, unknown> & { detail: Record<string, unknown> }> {
  return hub.logs
    .filter((l) => l.startsWith('{"type":"security"'))
    .map((l) => JSON.parse(l) as Record<string, unknown> & { detail: Record<string, unknown> })
}

/** An RSA certificate + key for the hub's Entra client assertion (openssl: CI + macOS). */
function writeSsoCert(root: string): { certPath: string; keyPath: string } {
  const certPath = join(root, 'sso-cert.pem')
  const keyPath = join(root, 'sso-key.pem')
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
      '/CN=slayzone-hub-boot-test',
      '-keyout',
      keyPath,
      '-out',
      certPath
    ],
    { stdio: 'ignore' }
  )
  return { certPath, keyPath }
}

/** Everything under `<root>/logs`, concatenated. */
function readLogs(root: string): string {
  const dir = join(root, 'logs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .map((n) => readFileSync(join(dir, n), 'utf8'))
    .join('\n')
}

/** The shape of a generated password (hub-auth users.ts: 16 random bytes, base64url). */
const GENERATED_PASSWORD = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown>; token: string | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json, token: res.headers.get('set-auth-token') }
}

beforeAll(() => ensureBuilt())

const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }
const REACHABLE_PUBLIC = {
  SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0',
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
}
const TENANT = '11111111-2222-3333-4444-555555555555'
/** The Normain shape: loopback behind a TLS front end, login, Entra sign-in only. */
const SSO_HUB = {
  ...LOOP,
  SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
  SLAYZONE_HUB_REQUIRE_LOGIN: '1',
  SLAYZONE_HUB_AUTH_SECRET: 'c-test-only-signing-secret-0123456789abcdef',
  SLAYZONE_HUB_ENABLE_PASSWORD: '0',
  SLAYZONE_HUB_ENABLE_SSO: '1',
  SLAYZONE_HUB_SSO_TENANT_ID: TENANT,
  SLAYZONE_HUB_SSO_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
}

afterAll(async () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

// --- refusals ----------------------------------------------------------
assertRefused(
  'B4: a switch that is not 0|1 refuses boot',
  { ...LOOP, SLAYZONE_HUB_REQUIRE_LOGIN: 'true' },
  ['SLAYZONE_HUB_REQUIRE_LOGIN', 'must be 0 or 1']
)
assertRefused(
  'B5: the old SLAYZONE_HUB_ADDRESS on the hub refuses boot',
  { SLAYZONE_HUB_ADDRESS: '127.0.0.1:0' },
  ['SLAYZONE_HUB_ADDRESS was renamed to SLAYZONE_HUB_LISTEN_ADDRESS']
)
assertRefused(
  'B5: the old `address` key in hub.config.json refuses boot',
  {},
  ["'address' was renamed to 'listenAddress'", 'hub.config.json'],
  { 'hub.config.json': { address: '127.0.0.1:0' } }
)
assertRefused(
  'B5: the old `port` key in hub.config.json refuses boot',
  {},
  ["'port' was renamed to 'listenAddress"],
  { 'hub.config.json': { port: 8080 } }
)
assertRefused(
  'B5: the old `publicUrl` key in hub.config.json refuses boot',
  {},
  ["'publicUrl' was renamed to 'publicAddress"],
  { 'hub.config.json': { publicUrl: 'https://hub.example.com' } }
)
assertRefused(
  'B4: a non-boolean switch in hub.config.json refuses boot',
  {},
  ["'requireLogin' must be true or false"],
  { 'hub.config.json': { requireLogin: 'yes' } }
)
assertRefused(
  'B8: a public address carrying a scheme refuses boot',
  { ...LOOP, SLAYZONE_HUB_PUBLIC_ADDRESS: 'https://hub.example.com' },
  ['SLAYZONE_HUB_PUBLIC_ADDRESS', 'no scheme']
)
assertRefused(
  'B9: a hub started by the desktop app must listen on loopback',
  { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0' },
  ['SLAYZONE_SUPERVISED', 'loopback']
)
assertRefused(
  'B1: reachable (non-loopback listen address) with login off refuses boot',
  REACHABLE_PUBLIC,
  ['SLAYZONE_HUB_REQUIRE_LOGIN=1']
)
assertRefused(
  'B1: reachable (loopback + public address) with login off refuses boot',
  { ...LOOP, SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' },
  ['SLAYZONE_HUB_REQUIRE_LOGIN=1', 'SLAYZONE_HUB_PUBLIC_ADDRESS is set']
)
assertRefused(
  'B3: reachable with no public address refuses boot',
  { SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0', SLAYZONE_HUB_REQUIRE_LOGIN: '1' },
  ['SLAYZONE_HUB_PUBLIC_ADDRESS is required']
)
assertRefused(
  'B10: the raw-SQL dev endpoint on a reachable hub refuses boot',
  {
    ...REACHABLE_PUBLIC,
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_AUTH_SECRET: 'x'.repeat(40),
    PLAYWRIGHT: '1'
  },
  ['PLAYWRIGHT=1', 'raw-SQL']
)
assertRefused(
  'B14: reachable with no SLAYZONE_HUB_AUTH_SECRET in env refuses boot and generates nothing',
  { ...REACHABLE_PUBLIC, SLAYZONE_HUB_REQUIRE_LOGIN: '1' },
  ['SLAYZONE_HUB_AUTH_SECRET is required in the environment']
)
assertRefused(
  'B2: login with password and SSO both off refuses boot',
  {
    ...LOOP,
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_ENABLE_PASSWORD: '0'
  },
  ['SLAYZONE_HUB_ENABLE_PASSWORD=0', 'SLAYZONE_HUB_ENABLE_SSO=0']
)
assertRefused(
  'B7: SSO on without its settings refuses boot, listing what is missing',
  {
    ...LOOP,
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_SSO_TENANT_ID: TENANT
  },
  [
    'SLAYZONE_HUB_SSO_CLIENT_ID',
    'SLAYZONE_HUB_SSO_CERT_PATH',
    'SLAYZONE_HUB_SSO_KEY_PATH',
    'SLAYZONE_HUB_PUBLIC_ADDRESS'
  ]
)
assertRefused(
  'B7: an SSO certificate that cannot be read refuses boot before any boot work',
  {
    ...SSO_HUB,
    SLAYZONE_HUB_SSO_CERT_PATH: join(tmpdir(), 'slz-hub-boot-no-such-cert.pem'),
    SLAYZONE_HUB_SSO_KEY_PATH: join(tmpdir(), 'slz-hub-boot-no-such-key.pem')
  },
  ['SLAYZONE_HUB_SSO_CERT_PATH / SLAYZONE_HUB_SSO_KEY_PATH', 'ENOENT']
)
assertRefused(
  'B16: a session retention period that is not a whole number of days refuses boot',
  { ...LOOP, SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90 days' },
  ['SLAYZONE_HUB_SESSION_RETENTION_DAYS', "'90 days'", '"rule":"B16"']
)

// --- the defaults, on loopback -----------------------------------------
test('defaults boot on loopback: login off, password on, SSO off, processes + integrations on', async () => {
  const root = newRoot()
  // A leftover SLAYZONE_MODE is ignored: it must neither refuse boot nor change a thing.
  const hub = spawnHub(root, { ...LOOP, SLAYZONE_MODE: 'remote' })
  try {
    const port = await bootAndGetPort(hub)
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      authRequired?: boolean
      switches?: Record<string, boolean>
      mode?: unknown
    }
    expect(health.authRequired, 'login is not required by default').toBe(false)
    expect(health.switches?.requireLogin, 'requireLogin default off').toBe(false)
    expect(health.switches?.enablePassword, 'enablePassword default on').toBe(true)
    expect(health.switches?.enableSso, 'enableSso default off').toBe(false)
    expect(health.switches?.enableProcesses, 'enableProcesses default on').toBe(true)
    expect(health.switches?.enableIntegrations, 'enableIntegrations default on').toBe(true)
    expect('mode' in health, '/health reports no mode').toBeFalsy()
    // Login off ⇒ no bootstrap owner, and an open REST surface (loopback only).
    const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`)
    expect(tasks.status, `no bearer wanted with login off, got ${tasks.status}`).not.toBe(401)
    expect(existsSync(join(root, 'hub.owner.json')), 'no bootstrap owner without login').toBeFalsy()
    // A hub that only this machine reaches still generates its own secret.
    expect(
      existsSync(join(root, 'hub.state.json')),
      'loopback hub may generate its secret'
    ).toBeTruthy()
    // No break-glass on a login-off hub: no socket, the route is not ours, and the
    // operator command refuses (exit 1, saying why).
    expect(existsSync(join(root, 'run', 'hub-admin.sock')), 'no break-glass socket').toBeFalsy()
    const redeem = await postJson(`http://127.0.0.1:${port}/api/auth/break-glass`, {
      verifier: 'x'.repeat(43)
    })
    expect(redeem.status, `no break-glass route, got ${redeem.status}`).toBe(404)
    const cmd = runBin(['break-glass', 'status', '--root', root])
    expect(cmd.code, cmd.out).toBe(1)
    expect(cmd.out, cmd.out).toContain('does not require login')
  } finally {
    await hub.stop()
  }
})

// --- reachable, behind a front end ---------------------------------------
test('reachable hub (loopback + public address) boots with login + secret, serves plain http, no pin', async () => {
  const root = newRoot()
  const secret = 'a-test-only-signing-secret-0123456789abcdef'
  const hub = spawnHub(root, {
    ...LOOP,
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_AUTH_SECRET: secret
  })
  try {
    const port = await bootAndGetPort(hub)
    // Plain http: the hub does not terminate TLS, the front end does.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      authRequired?: boolean
      switches?: Record<string, boolean>
    }
    expect(health.authRequired, 'login required').toBe(true)
    expect(health.switches?.requireLogin, 'requireLogin reported').toBe(true)

    // A guarded route wants a bearer.
    const noBearer = await fetch(`http://127.0.0.1:${port}/api/tasks`)
    expect(noBearer.status, `no bearer → 401, got ${noBearer.status}`).toBe(401)

    // The bootstrap owner exists, with no file (T-11): its password derives from
    // the auth secret, and it signs in like any client.
    expect(
      existsSync(join(root, 'hub.owner.json')),
      'no hub.owner.json on a reachable hub'
    ).toBeFalsy()
    const signIn = await postJson(
      `http://127.0.0.1:${port}/api/auth/sign-in/email`,
      { email: BOOTSTRAP_OWNER_EMAIL, password: deriveBootstrapOwnerPassword(secret) },
      { origin: 'https://hub.example.com' }
    )
    expect(signIn.status, `owner sign-in, got ${signIn.status}`).toBe(200)
    expect(signIn.token, `owner sign-in, got ${signIn.status}`).toBeTruthy()
    const owner = { token: signIn.token }
    const minted = await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${port}/api/computers/join-token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${owner.token}`
          },
          // T-20: minted FOR a named user.
          body: JSON.stringify({ label: 'hub-boot-test', forUser: BOOTSTRAP_OWNER_EMAIL })
        })
        return r.status === 200 ? ((await r.json()) as { token: string; hubUrl: string }) : null
      },
      20_000,
      'join token mint'
    )
    // A2: the token carries the public address; A1: a public host is wss://.
    expect(minted.hubUrl, `join token url follows the public address, got ${minted.hubUrl}`).toBe(
      'wss://hub.example.com/computers'
    )
    const payload = JSON.parse(
      Buffer.from(minted.token.slice('szjt1.'.length), 'base64url').toString('utf8')
    ) as Record<string, unknown>
    expect('certFingerprint' in payload, 'the token carries no certificate pin').toBeFalsy()

    // No TLS identity, and the signing secret was never written to disk.
    expect(
      existsSync(join(root, 'identity')),
      'no identity/ directory: the hub has no cert'
    ).toBeFalsy()
    expect(
      existsSync(join(root, 'hub.state.json')),
      'no hub.state.json: a reachable hub does not generate its secret to disk'
    ).toBeFalsy()
    const stateless = readdirSync(root)
      .filter((n) => statSync(join(root, n)).isFile())
      .some((n) => readFileSync(join(root, n)).includes(secret))
    expect(stateless, 'the secret appears in no file under ROOT').toBeFalsy()
  } finally {
    await hub.stop()
  }
})

// --- Entra sign-in (T-09) -------------------------------------------------
// Nothing here reaches Microsoft: starting a sign-in only BUILDS the authorize URL,
// and the callback is driven with an error, which never redeems a code.
test('a hub with Entra sign-in boots: start + callback open, redirect URI on the public address, no owner', async () => {
  const root = newRoot()
  // An RSA certificate for the hub's client assertion. openssl ships on the CI
  // runner (ubuntu) and macOS; node:crypto cannot issue a certificate.
  const { certPath, keyPath } = writeSsoCert(root)
  const keyBody = readFileSync(keyPath, 'utf8').split('\n').slice(1, -2).join('')
  const hub = spawnHub(root, {
    ...SSO_HUB,
    SLAYZONE_HUB_SSO_CERT_PATH: certPath,
    SLAYZONE_HUB_SSO_KEY_PATH: keyPath
  })
  try {
    const port = await bootAndGetPort(hub)
    const base = `http://127.0.0.1:${port}`
    const health = (await (await fetch(`${base}/health`)).json()) as {
      switches?: Record<string, boolean>
    }
    expect(health.switches?.enableSso, 'enableSso reported').toBe(true)

    // Start: open with no bearer, answers Entra's authorize URL for THIS tenant,
    // PKCE, offline_access, and Entra sends the browser back to the PUBLIC address.
    const start = await fetch(`${base}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://hub.example.com' },
      body: JSON.stringify({ provider: 'microsoft', callbackURL: '/', disableRedirect: true })
    })
    expect(
      start.status,
      `sign-in/social open, got ${start.status}: ${await start.clone().text()}`
    ).toBe(200)
    const url = new URL(((await start.json()) as { url: string }).url)
    expect(
      url.origin + url.pathname,
      `single-tenant authorize endpoint, got ${url.origin + url.pathname}`
    ).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`)
    expect(
      url.searchParams.get('redirect_uri'),
      `redirect URI on the public address, got ${url.searchParams.get('redirect_uri')}`
    ).toBe('https://hub.example.com/api/auth/callback/microsoft')
    expect(url.searchParams.get('code_challenge_method'), 'PKCE').toBe('S256')
    expect(url.searchParams.get('scope'), 'offline_access').toContain('offline_access')

    // Callback: reachable with no bearer (it 302s to the error page here, since the
    // state is unknown) — the gate does not answer 401.
    const callback = await fetch(
      `${base}/api/auth/callback/microsoft?error=access_denied&state=nope`,
      { redirect: 'manual' }
    )
    expect(callback.status, `callback reachable, got ${callback.status}`).toBe(302)
    // Every other better-auth OAuth route stays behind the bearer.
    for (const path of ['/api/auth/link-social', '/api/auth/callback/google']) {
      const r = await fetch(`${base}${path}`, { method: 'POST' })
      expect(r.status, `${path} gated, got ${r.status}`).toBe(401)
    }

    // No bootstrap owner: admin comes from the Entra app role only.
    expect(existsSync(join(root, 'hub.owner.json')), 'no bootstrap owner on an SSO hub').toBeFalsy()
    const out = hub.logs.join('\n')
    expect(out, 'no owner credentials printed').not.toContain('A first user was created')
    expect(out, 'the private key never reaches the log').not.toContain(keyBody.slice(0, 40))
  } finally {
    await hub.stop()
  }
})

// --- password sign-in off (T-10) ------------------------------------------
test('password off beside Entra: password routes 403 + audited, no owner file, no password in logs, an old credential cannot sign in', async () => {
  const root = newRoot()
  const { certPath, keyPath } = writeSsoCert(root)
  const secret = SSO_HUB.SLAYZONE_HUB_AUTH_SECRET

  // Before: the same ROOT as a password hub. Its bootstrap owner signs in with a
  // password, as today — that credential is what must stop working below.
  const before = spawnHub(root, {
    ...LOOP,
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_AUTH_SECRET: secret
  })
  // A reachable hub: the owner's password derives from the secret (T-11).
  const owner = { email: BOOTSTRAP_OWNER_EMAIL, password: deriveBootstrapOwnerPassword(secret) }
  try {
    const port = await bootAndGetPort(before)
    // The public origin: better-auth's form-CSRF check wants an Origin from a fetch
    // client (node's fetch sends Sec-Fetch-Mode).
    const signIn = await postJson(
      `http://127.0.0.1:${port}/api/auth/sign-in/email`,
      { email: owner.email, password: owner.password },
      { origin: 'https://hub.example.com' }
    )
    expect(
      signIn.status,
      `password hub: sign-in works, got ${signIn.status} ${JSON.stringify(signIn.json)}`
    ).toBe(200)
    expect(
      signIn.token,
      `password hub: sign-in works, got ${signIn.status} ${JSON.stringify(signIn.json)}`
    ).toBeTruthy()
  } finally {
    await before.stop()
  }

  const hub = spawnHub(root, {
    ...SSO_HUB,
    SLAYZONE_HUB_SSO_CERT_PATH: certPath,
    SLAYZONE_HUB_SSO_KEY_PATH: keyPath
  })
  try {
    const port = await bootAndGetPort(hub)
    const base = `http://127.0.0.1:${port}`
    const health = (await (await fetch(`${base}/health`)).json()) as {
      switches?: Record<string, boolean>
    }
    expect(health.switches?.enablePassword, 'enablePassword reported off').toBe(false)

    const refused: Array<[string, unknown, string]> = [
      ['/api/auth/sign-in/email', { email: owner.email, password: owner.password }, 'auth.signin'],
      [
        '/api/auth/sign-up/email',
        { email: 'x@example.com', password: 'p'.repeat(16), name: 'x' },
        'user.create'
      ],
      ['/api/auth/web-login', { email: owner.email, password: owner.password }, 'auth.signin'],
      [
        '/api/auth/change-password',
        { currentPassword: 'a'.repeat(16), newPassword: 'b'.repeat(16) },
        'auth.password.change'
      ],
      ['/api/auth/request-password-reset', { email: owner.email }, 'auth.password.change']
    ]
    for (const [path, body] of refused) {
      // With the public origin, so a 403 can only be the switch's.
      const r = await postJson(`${base}${path}`, body, { origin: 'https://hub.example.com' })
      expect(r.status, `${path} → 403, got ${r.status} ${JSON.stringify(r.json)}`).toBe(403)
      expect(r.json.code, `${path} stable code: ${JSON.stringify(r.json)}`).toBe(
        'HUB_PASSWORD_DISABLED'
      )
      expect(r.token, `${path} issued no token`).toBeFalsy()
    }
    const lines = securityLines(hub)
    for (const [path, , event] of refused) {
      const op = path.slice('/api/auth/'.length)
      expect(
        lines.some(
          (l) =>
            l.event === event &&
            l.outcome === 'denied' &&
            l.detail.op === op &&
            l.detail.code === 'HUB_PASSWORD_DISABLED'
        ),
        `audit line for ${path}`
      ).toBeTruthy()
    }
    // Entra sign-in is untouched.
    const start = await postJson(
      `${base}/api/auth/sign-in/social`,
      { provider: 'microsoft', callbackURL: '/', disableRedirect: true },
      { origin: 'https://hub.example.com' }
    )
    expect(start.status, `sign-in/social still open, got ${start.status}`).toBe(200)

    // The credential is still in the database — kept, just unusable.
    const authDb = new DatabaseSync(join(root, 'slayzone.auth.sqlite'))
    try {
      const { n } = authDb
        .prepare("SELECT count(*) AS n FROM account WHERE providerId = 'credential'")
        .get() as { n: number }
      expect(n, 'the password credential row is kept').toBeGreaterThanOrEqual(1)
    } finally {
      authDb.close()
    }

    // The boot line: Entra only.
    const boot = lines.find((l) => l.event === 'hub.boot' && l.outcome === 'success')
    expect(boot, 'hub.boot success line').toBeTruthy()
    expect(JSON.stringify(boot?.detail.methods), `methods: ${JSON.stringify(boot?.detail)}`).toBe(
      '["sso"]'
    )
    expect(existsSync(join(root, 'hub.break-glass.json')), 'no break-glass file').toBeFalsy()
  } finally {
    await hub.stop()
  }
})

test('password off, fresh ROOT: no owner file, no generated password in any log', async () => {
  const root = newRoot()
  const { certPath, keyPath } = writeSsoCert(root)
  const hub = spawnHub(root, {
    ...SSO_HUB,
    SLAYZONE_HUB_SSO_CERT_PATH: certPath,
    SLAYZONE_HUB_SSO_KEY_PATH: keyPath
  })
  try {
    await bootAndGetPort(hub)
    expect(existsSync(join(root, 'hub.owner.json')), 'no hub.owner.json').toBeFalsy()
    expect(existsSync(join(root, 'hub.break-glass.json')), 'no hub.break-glass.json').toBeFalsy()
    const all = `${readLogs(root)}\n${hub.logs.join('\n')}`
    expect(all, 'no "password:" line').not.toMatch(/password:/i)
    const shaped = all.match(GENERATED_PASSWORD)
    expect(shaped, `no generated-password-shaped string, found '${shaped?.[0]}'`).toBeFalsy()
  } finally {
    await hub.stop()
  }
})

test('password off on a login-off hub: `slay hub users add` (POST /api/hub/users) 403s with the code + audit', async () => {
  const root = newRoot()
  const hub = spawnHub(root, { ...LOOP, SLAYZONE_HUB_ENABLE_PASSWORD: '0' })
  try {
    const port = await bootAndGetPort(hub)
    const r = await postJson(`http://127.0.0.1:${port}/api/hub/users`, {
      email: 'new@example.com'
    })
    expect(r.status, `403, got ${r.status} ${JSON.stringify(r.json)}`).toBe(403)
    expect(r.json.code, `code: ${JSON.stringify(r.json)}`).toBe('HUB_PASSWORD_DISABLED')
    const signIn = await postJson(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
      email: 'new@example.com',
      password: 'p'.repeat(16)
    })
    expect(signIn.status, `sign-in 403 on a login-off hub too, got ${signIn.status}`).toBe(403)
    const line = securityLines(hub).find((l) => l.event === 'user.create' && l.outcome === 'denied')
    expect(line?.detail.code, 'user.create denied line').toBe('HUB_PASSWORD_DISABLED')
    expect(
      securityLines(hub).some((l) => l.event === 'hub.boot'),
      'no boot line with login off'
    ).toBeFalsy()
  } finally {
    await hub.stop()
  }
})

test('break-glass v2 (O-9/O-23): granted on the box, redeemed once, revokes a computer, ended on the box; a crash closes at the next boot', async () => {
  const root = newRoot()
  const { certPath, keyPath } = writeSsoCert(root)
  const sso = {
    ...SSO_HUB,
    SLAYZONE_HUB_SSO_CERT_PATH: certPath,
    SLAYZONE_HUB_SSO_KEY_PATH: keyPath
  }
  const BREAK_GLASS = 'break-glass@hub.slayzone.local'
  const accountRow = (): { role: string; disabledAt: unknown } | undefined => {
    const authDb = new DatabaseSync(join(root, 'slayzone.auth.sqlite'))
    try {
      return authDb.prepare('SELECT role, disabledAt FROM user WHERE email = ?').get(BREAK_GLASS) as
        | { role: string; disabledAt: unknown }
        | undefined
    } finally {
      authDb.close()
    }
  }
  const newVerifier = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
  }
  const secrets: string[] = []
  // Break-glass v1 left its credentials file behind: boot removes it, unread.
  const v1File = join(root, 'hub.break-glass.json')
  writeFileSync(v1File, JSON.stringify({ password: 'v1-left-this-behind' }), { mode: 0o600 })

  const hub = spawnHub(root, sso)
  let crashedToken = ''
  try {
    const port = await bootAndGetPort(hub)
    const base = `http://127.0.0.1:${port}`
    expect(existsSync(v1File), 'v1 file removed at boot').toBeFalsy()
    const socket = join(root, 'run', 'hub-admin.sock')
    expect(statSync(socket).mode & 0o777, 'the channel is a 0600 socket').toBe(0o600)
    // An enrolled computer, as the store holds one.
    const appDb = new DatabaseSync(join(root, 'slayzone.data.sqlite'))
    try {
      appDb
        .prepare(
          `INSERT INTO computers (id, name, platform, version, capabilities_json, auth_key_id,
             last_seen_at, created_at, revoked_at) VALUES ('c-stolen', 'stolen', 'p', '0', '{}', NULL, ?, ?, NULL)`
        )
        .run(Date.now(), Date.now())
    } finally {
      appDb.close()
    }

    // 1. The laptop holds the verifier; the operator opens a grant on the box.
    const first = newVerifier()
    secrets.push(first.verifier)
    const open = runBin([
      'break-glass',
      'open',
      '--challenge',
      first.challenge,
      '--ttl',
      '30m',
      '--root',
      root
    ])
    expect(open.code, `open: ${open.out}`).toBe(0)
    expect(open.out, open.out).toContain('is open')
    expect(open.out, 'the command output holds no secret').not.toContain(first.verifier)

    // 2. Redeemed once.
    const redeemed = await postJson(`${base}/api/auth/break-glass`, {
      verifier: first.verifier
    })
    expect(redeemed.status, `redeem: ${redeemed.status} ${JSON.stringify(redeemed.json)}`).toBe(200)
    expect(
      typeof redeemed.json.token,
      `redeem: ${redeemed.status} ${JSON.stringify(redeemed.json)}`
    ).toBe('string')
    const token = redeemed.json.token as string
    secrets.push(token)
    const again = await postJson(`${base}/api/auth/break-glass`, { verifier: first.verifier })
    expect(again.status, `second use refused, got ${again.status}`).toBe(403)
    const bearer = { authorization: `Bearer ${token}` }

    // 3. An admin action; listed as the break-glass admin; no content.
    const revoke = await fetch(`${base}/api/hub/computers`, {
      method: 'PATCH',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'c-stolen', revoked: true })
    })
    expect(revoke.status, `revoke: ${revoke.status} ${await revoke.text()}`).toBe(200)
    const users = (await (await fetch(`${base}/api/hub/users`, { headers: bearer })).json()) as {
      data: Array<{ email: string; role: string; disabledAt: string | null }>
    }
    expect(
      users.data.some((u) => u.email === BREAK_GLASS && u.role === 'admin' && !u.disabledAt),
      `listed as the open break-glass admin: ${JSON.stringify(users.data)}`
    ).toBeTruthy()
    const tasks = await fetch(`${base}/api/tasks`, { headers: bearer })
    expect(tasks.status, `no content, got ${tasks.status}`).toBe(403)

    // 4. The operator's end command ends it: token refused, account closed, audited.
    const end = runBin(['break-glass', 'end', '--root', root])
    expect(end.code, `end: ${end.out}`).toBe(0)
    expect(end.out, end.out).toContain('session ended')
    expect(
      (await fetch(`${base}/api/hub/users`, { headers: bearer })).status,
      'the ended session is refused'
    ).toBe(401)
    expect(accountRow()?.disabledAt, 'the account is closed').toBeTruthy()
    expect(accountRow()?.role, 'back to user').toBe('user')
    const lines = securityLines(hub)
    const id = lines.find(
      (l) => l.event === 'auth.break_glass.redeem' && l.outcome === 'success'
    )?.actor
    expect(typeof id, 'redeem line names the account').toBe('string')
    for (const [event, check] of [
      ['auth.break_glass.grant', (l: { level?: unknown }) => l.level === 'warn'],
      ['auth.break_glass.use', (l: { actor?: unknown }) => l.actor === id],
      ['computer.revoke', (l: { actor?: unknown }) => l.actor === id],
      [
        'auth.break_glass.end',
        (l: { detail: Record<string, unknown> }) => l.detail.reason === 'ended'
      ],
      [
        'auth.break_glass.end',
        (l: { detail: Record<string, unknown> }) => l.detail.legacyFile === true
      ]
    ] as const) {
      expect(
        lines.some((l) => l.event === event && (check as (x: typeof l) => boolean)(l)),
        `audit: ${event}`
      ).toBeTruthy()
    }

    // 5. A crash mid-session: open and redeem again, then kill the hub.
    const second = newVerifier()
    secrets.push(second.verifier)
    expect(
      runBin(['break-glass', 'open', '--challenge', second.challenge, '--root', root]).code,
      'second grant'
    ).toBe(0)
    const r2 = await postJson(`${base}/api/auth/break-glass`, { verifier: second.verifier })
    expect(r2.status, `second redeem ${r2.status}`).toBe(200)
    crashedToken = r2.json.token as string
    secrets.push(crashedToken)
    expect(accountRow()?.disabledAt, 'open again').toBeFalsy()
    hub.proc.kill('SIGKILL')
    await hub.exit
  } finally {
    await hub.stop()
  }

  const after = spawnHub(root, sso)
  try {
    const port = await bootAndGetPort(after)
    const res = await fetch(`http://127.0.0.1:${port}/api/hub/users`, {
      headers: { authorization: `Bearer ${crashedToken}` }
    })
    expect(res.status, `the crashed session is gone, got ${res.status}`).toBe(401)
    expect(accountRow()?.disabledAt, 'closed at boot').toBeTruthy()
    expect(
      securityLines(after).some(
        (l) =>
          l.event === 'auth.break_glass.end' && l.detail.stage === 'boot' && l.detail.accounts === 1
      ),
      'boot end line'
    ).toBeTruthy()
    // Nothing secret on disk: no verifier or token in any file under ROOT.
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) files.push(p)
      }
    }
    walk(root)
    for (const f of files) {
      const text = readFileSync(f).toString('latin1')
      for (const s of secrets) expect(text, `${f} holds a break-glass secret`).not.toContain(s)
    }
  } finally {
    await after.stop()
  }
})

test('the SAME hub config in hub.config.json boots, env still wins over it', async () => {
  const root = newRoot()
  writeFileSync(
    join(root, 'hub.config.json'),
    JSON.stringify({
      listenAddress: '127.0.0.1:0',
      publicAddress: 'hub.example.com',
      requireLogin: true,
      enableProcesses: false,
      enableIntegrations: false,
      enableTelemetry: false
    })
  )
  // The secret is env only; a switch in env beats the file (enableProcesses 1 vs false).
  const hub = spawnHub(root, {
    SLAYZONE_HUB_AUTH_SECRET: 'b-test-only-signing-secret-0123456789abcdef',
    SLAYZONE_HUB_ENABLE_PROCESSES: '1'
  })
  try {
    const port = await bootAndGetPort(hub)
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      authRequired?: boolean
      switches?: Record<string, boolean>
    }
    expect(health.authRequired, 'requireLogin came from the file').toBe(true)
    expect(health.switches?.enableIntegrations, 'enableIntegrations came from the file').toBe(false)
    expect(health.switches?.enableTelemetry, 'enableTelemetry came from the file').toBe(false)
    expect(health.switches?.enableProcesses, 'env wins over the file for enableProcesses').toBe(
      true
    )
  } finally {
    await hub.stop()
  }
})

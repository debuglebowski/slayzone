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
 *     `identity/` directory and writes no `hub.state.json`;
 *   - a leftover `SLAYZONE_MODE` changes nothing;
 *   - a hub with Entra sign-in: its two sign-in routes pass the gate, its redirect URI
 *     is on the public address, and it provisions no bootstrap owner.
 *
 * Isolation: every hub runs in its own throwaway SLAYZONE_ROOT with every inherited
 * SLAYZONE_ and ELECTRON_ prefixed env var scrubbed (a task terminal leaks the dial-side
 * SLAYZONE_HUB_ADDRESS, which the hub itself would — correctly — refuse), on a loopback
 * port the OS picks (`:0`).
 *
 * Native ABI: better-sqlite3 needs Electron's node, so this runs under
 * `ELECTRON_RUN_AS_NODE=1 electron` (run_test_electron_strict_loader).
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/hub/src/hub-boot.test.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
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
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
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
async function assertRefused(
  label: string,
  env: Record<string, string>,
  needles: string[],
  files?: Record<string, unknown>
): Promise<void> {
  await test(label, async () => {
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
      assert(code !== 'timeout', `hub did not exit (should have refused):\n${hub.logs.join('\n')}`)
      assert(code !== 0, `exit code should be non-zero, got ${String(code)}`)
      const out = hub.logs.join('\n')
      assert(!out.includes('listening on http'), `a refused hub must not listen:\n${out}`)
      for (const n of needles) assert(out.includes(n), `message should mention '${n}':\n${out}`)
      // One audit line on stdout before exit (T-03), naming the rule.
      const audit = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
      assert(audit.length === 1, `one security line, got ${audit.length}:\n${out}`)
      const event = JSON.parse(audit[0]!) as {
        event: string
        outcome: string
        detail: { rule?: unknown }
      }
      assert(
        event.event === 'hub.boot' && event.outcome === 'denied',
        `hub.boot denied: ${audit[0]}`
      )
      assert(typeof event.detail.rule === 'string' && event.detail.rule, `rule named: ${audit[0]}`)
      // Refused BEFORE the data directory was touched: no database, no generated
      // state, no certificate identity, no log directory.
      const artifacts = bootArtifacts(root)
      assert(artifacts.length === 0, `refusal must precede any boot work, found: ${artifacts}`)
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
  assert(m, `listening line parseable: ${line}`)
  const port = Number(m[2])
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

async function main(): Promise<void> {
  console.log('\nhub boot rules, driven through the real built hub\n')
  ensureBuilt()

  const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }
  const REACHABLE_PUBLIC = {
    SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0',
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com'
  }
  const TENANT = '11111111-2222-3333-4444-555555555555'
  /** The Normain shape: loopback behind a TLS front end, login, Entra sign-in. */
  const SSO_HUB = {
    ...LOOP,
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1',
    SLAYZONE_HUB_AUTH_SECRET: 'c-test-only-signing-secret-0123456789abcdef',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_SSO_TENANT_ID: TENANT,
    SLAYZONE_HUB_SSO_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  }

  try {
    // --- refusals ----------------------------------------------------------
    await assertRefused(
      'B4: a switch that is not 0|1 refuses boot',
      { ...LOOP, SLAYZONE_HUB_REQUIRE_LOGIN: 'true' },
      ['SLAYZONE_HUB_REQUIRE_LOGIN', 'must be 0 or 1']
    )
    await assertRefused(
      'B5: the old SLAYZONE_HUB_ADDRESS on the hub refuses boot',
      { SLAYZONE_HUB_ADDRESS: '127.0.0.1:0' },
      ['SLAYZONE_HUB_ADDRESS was renamed to SLAYZONE_HUB_LISTEN_ADDRESS']
    )
    await assertRefused(
      'B5: the old `address` key in hub.config.json refuses boot',
      {},
      ["'address' was renamed to 'listenAddress'", 'hub.config.json'],
      { 'hub.config.json': { address: '127.0.0.1:0' } }
    )
    await assertRefused(
      'B5: the old `port` key in hub.config.json refuses boot',
      {},
      ["'port' was renamed to 'listenAddress"],
      { 'hub.config.json': { port: 8080 } }
    )
    await assertRefused(
      'B5: the old `publicUrl` key in hub.config.json refuses boot',
      {},
      ["'publicUrl' was renamed to 'publicAddress"],
      { 'hub.config.json': { publicUrl: 'https://hub.example.com' } }
    )
    await assertRefused(
      'B4: a non-boolean switch in hub.config.json refuses boot',
      {},
      ["'requireLogin' must be true or false"],
      { 'hub.config.json': { requireLogin: 'yes' } }
    )
    await assertRefused(
      'B8: a public address carrying a scheme refuses boot',
      { ...LOOP, SLAYZONE_HUB_PUBLIC_ADDRESS: 'https://hub.example.com' },
      ['SLAYZONE_HUB_PUBLIC_ADDRESS', 'no scheme']
    )
    await assertRefused(
      'B9: a hub started by the desktop app must listen on loopback',
      { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0' },
      ['SLAYZONE_SUPERVISED', 'loopback']
    )
    await assertRefused(
      'B1: reachable (non-loopback listen address) with login off refuses boot',
      REACHABLE_PUBLIC,
      ['SLAYZONE_HUB_REQUIRE_LOGIN=1']
    )
    await assertRefused(
      'B1: reachable (loopback + public address) with login off refuses boot',
      { ...LOOP, SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com' },
      ['SLAYZONE_HUB_REQUIRE_LOGIN=1', 'SLAYZONE_HUB_PUBLIC_ADDRESS is set']
    )
    await assertRefused(
      'B3: reachable with no public address refuses boot',
      { SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:0', SLAYZONE_HUB_REQUIRE_LOGIN: '1' },
      ['SLAYZONE_HUB_PUBLIC_ADDRESS is required']
    )
    await assertRefused(
      'B10: the raw-SQL dev endpoint on a reachable hub refuses boot',
      {
        ...REACHABLE_PUBLIC,
        SLAYZONE_HUB_REQUIRE_LOGIN: '1',
        SLAYZONE_HUB_AUTH_SECRET: 'x'.repeat(40),
        PLAYWRIGHT: '1'
      },
      ['PLAYWRIGHT=1', 'raw-SQL']
    )
    await assertRefused(
      'B14: reachable with no SLAYZONE_HUB_AUTH_SECRET in env refuses boot and generates nothing',
      { ...REACHABLE_PUBLIC, SLAYZONE_HUB_REQUIRE_LOGIN: '1' },
      ['SLAYZONE_HUB_AUTH_SECRET is required in the environment']
    )
    await assertRefused(
      'B2: login with password and SSO both off refuses boot',
      {
        ...LOOP,
        SLAYZONE_HUB_REQUIRE_LOGIN: '1',
        SLAYZONE_HUB_ENABLE_PASSWORD: '0'
      },
      ['SLAYZONE_HUB_ENABLE_PASSWORD=0', 'SLAYZONE_HUB_ENABLE_SSO=0']
    )
    await assertRefused(
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
    await assertRefused(
      'B7: an SSO certificate that cannot be read refuses boot before any boot work',
      {
        ...SSO_HUB,
        SLAYZONE_HUB_SSO_CERT_PATH: join(tmpdir(), 'slz-hub-boot-no-such-cert.pem'),
        SLAYZONE_HUB_SSO_KEY_PATH: join(tmpdir(), 'slz-hub-boot-no-such-key.pem')
      },
      ['SLAYZONE_HUB_SSO_CERT_PATH / SLAYZONE_HUB_SSO_KEY_PATH', 'ENOENT']
    )

    // --- the defaults, on loopback -----------------------------------------
    await test('defaults boot on loopback: login off, password on, SSO off, processes + integrations on', async () => {
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
        assert(health.authRequired === false, 'login is not required by default')
        assert(health.switches?.requireLogin === false, 'requireLogin default off')
        assert(health.switches?.enablePassword === true, 'enablePassword default on')
        assert(health.switches?.enableSso === false, 'enableSso default off')
        assert(health.switches?.enableProcesses === true, 'enableProcesses default on')
        assert(health.switches?.enableIntegrations === true, 'enableIntegrations default on')
        assert(!('mode' in health), '/health reports no mode')
        // Login off ⇒ no bootstrap owner, and an open REST surface (loopback only).
        const tasks = await fetch(`http://127.0.0.1:${port}/api/tasks`)
        assert(tasks.status !== 401, `no bearer wanted with login off, got ${tasks.status}`)
        assert(!existsSync(join(root, 'hub.owner.json')), 'no bootstrap owner without login')
        // A hub that only this machine reaches still generates its own secret.
        assert(existsSync(join(root, 'hub.state.json')), 'loopback hub may generate its secret')
      } finally {
        await hub.stop()
      }
    })

    // --- reachable, behind a front end ---------------------------------------
    await test('reachable hub (loopback + public address) boots with login + secret, serves plain http, no pin', async () => {
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
        assert(health.authRequired === true, 'login required')
        assert(health.switches?.requireLogin === true, 'requireLogin reported')

        // A guarded route wants a bearer.
        const noBearer = await fetch(`http://127.0.0.1:${port}/api/tasks`)
        assert(noBearer.status === 401, `no bearer → 401, got ${noBearer.status}`)

        // The bootstrap owner exists for the operator on this box.
        const owner = JSON.parse(readFileSync(join(root, 'hub.owner.json'), 'utf8')) as {
          token: string
        }
        const minted = await poll(
          async () => {
            const r = await fetch(`http://127.0.0.1:${port}/api/computers/join-token`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${owner.token}`
              },
              body: JSON.stringify({ label: 'hub-boot-test' })
            })
            return r.status === 200 ? ((await r.json()) as { token: string; hubUrl: string }) : null
          },
          20_000,
          'join token mint'
        )
        // A2: the token carries the public address; A1: a public host is wss://.
        assert(
          minted.hubUrl === 'wss://hub.example.com/computers',
          `join token url follows the public address, got ${minted.hubUrl}`
        )
        const payload = JSON.parse(
          Buffer.from(minted.token.slice('szjt1.'.length), 'base64url').toString('utf8')
        ) as Record<string, unknown>
        assert(!('certFingerprint' in payload), 'the token carries no certificate pin')

        // No TLS identity, and the signing secret was never written to disk.
        assert(!existsSync(join(root, 'identity')), 'no identity/ directory: the hub has no cert')
        assert(
          !existsSync(join(root, 'hub.state.json')),
          'no hub.state.json: a reachable hub does not generate its secret to disk'
        )
        const stateless = readdirSync(root)
          .filter((n) => statSync(join(root, n)).isFile())
          .some((n) => readFileSync(join(root, n)).includes(secret))
        assert(!stateless, 'the secret appears in no file under ROOT')
      } finally {
        await hub.stop()
      }
    })

    // --- Entra sign-in (T-09) -------------------------------------------------
    // Nothing here reaches Microsoft: starting a sign-in only BUILDS the authorize URL,
    // and the callback is driven with an error, which never redeems a code.
    await test('a hub with Entra sign-in boots: start + callback open, redirect URI on the public address, no owner', async () => {
      const root = newRoot()
      // An RSA certificate for the hub's client assertion. openssl ships on the CI
      // runner (ubuntu) and macOS; node:crypto cannot issue a certificate.
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
        assert(health.switches?.enableSso === true, 'enableSso reported')

        // Start: open with no bearer, answers Entra's authorize URL for THIS tenant,
        // PKCE, offline_access, and Entra sends the browser back to the PUBLIC address.
        const start = await fetch(`${base}/api/auth/sign-in/social`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'https://hub.example.com' },
          body: JSON.stringify({ provider: 'microsoft', callbackURL: '/', disableRedirect: true })
        })
        assert(
          start.status === 200,
          `sign-in/social open, got ${start.status}: ${await start.clone().text()}`
        )
        const url = new URL(((await start.json()) as { url: string }).url)
        assert(
          url.origin + url.pathname ===
            `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
          `single-tenant authorize endpoint, got ${url.origin + url.pathname}`
        )
        assert(
          url.searchParams.get('redirect_uri') ===
            'https://hub.example.com/api/auth/callback/microsoft',
          `redirect URI on the public address, got ${url.searchParams.get('redirect_uri')}`
        )
        assert(url.searchParams.get('code_challenge_method') === 'S256', 'PKCE')
        assert(url.searchParams.get('scope')?.includes('offline_access'), 'offline_access')

        // Callback: reachable with no bearer (it 302s to the error page here, since the
        // state is unknown) — the gate does not answer 401.
        const callback = await fetch(
          `${base}/api/auth/callback/microsoft?error=access_denied&state=nope`,
          { redirect: 'manual' }
        )
        assert(callback.status === 302, `callback reachable, got ${callback.status}`)
        // Every other better-auth OAuth route stays behind the bearer.
        for (const path of ['/api/auth/link-social', '/api/auth/callback/google']) {
          const r = await fetch(`${base}${path}`, { method: 'POST' })
          assert(r.status === 401, `${path} gated, got ${r.status}`)
        }

        // No bootstrap owner: admin comes from the Entra app role only.
        assert(!existsSync(join(root, 'hub.owner.json')), 'no bootstrap owner on an SSO hub')
        const out = hub.logs.join('\n')
        assert(!out.includes('A first user was created'), 'no owner credentials printed')
        assert(!out.includes(keyBody.slice(0, 40)), 'the private key never reaches the log')
      } finally {
        await hub.stop()
      }
    })

    await test('the SAME hub config in hub.config.json boots, env still wins over it', async () => {
      const root = newRoot()
      writeFileSync(
        join(root, 'hub.config.json'),
        JSON.stringify({
          listenAddress: '127.0.0.1:0',
          publicAddress: 'hub.example.com',
          requireLogin: true,
          enableProcesses: false,
          enableIntegrations: false
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
        assert(health.authRequired === true, 'requireLogin came from the file')
        assert(
          health.switches?.enableIntegrations === false,
          'enableIntegrations came from the file'
        )
        assert(
          health.switches?.enableProcesses === true,
          'env wins over the file for enableProcesses'
        )
      } finally {
        await hub.stop()
      }
    })
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()

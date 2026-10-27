/**
 * Hub↔computer install-handshake — the fast, dev-tree tier of deploy coverage.
 *
 * Boots the built hub bin (dist/bin.cjs) as a STANDALONE process against a fully
 * isolated tmp home + store + OS-assigned ports, mints a join token over the
 * loopback REST channel (`POST /api/computers/join-token`), spawns the built computer
 * bin pointed at that token, and asserts the computer ENROLLS end-to-end (shows
 * `connected: true` in `computers.list`). This is the deploy path the desktop app's
 * local-computer-supervisor + the published npm packages both exercise — here over
 * the dev-tree bundles under Electron's node ABI (no native rebuild; Tier 1 in
 * scripts/publish-npm.sh covers the `npm install` ABI-rebuild path).
 *
 * ISOLATION (must never touch the real dev/prod stores):
 *   - The child env is SCRUBBED of every `SLAYZONE_*` / `ELECTRON_*` var (a
 *     supervised parent leaks SLAYZONE_SUPERVISED=1 + SLAYZONE_ROOT → real dev
 *     store, and ELECTRON_RUN_AS_NODE), mirroring e2e/fixtures/electron.ts. Only the
 *     explicit isolation vars below are re-added.
 *   - SLAYZONE_ROOT (hub + computer, separate dirs) points under one throwaway
 *     mkdtemp dir (the computer's creds derive at <ROOT>/computers); ports are 0
 *     (OS-assigned) so nothing collides with a running app's claimed port.
 *   - The test records the real dev+prod primary DBs' mtime+size before/after and
 *     asserts byte-identical, and asserts the hub's OWN resolved db path (parsed
 *     from its boot line + /health) sits under the tmp dir.
 *
 * Native ABI: better-sqlite3 (hub) + node-pty (computer) are built for Electron's
 * ABI, so both bins run under `ELECTRON_RUN_AS_NODE=1 electron`, and this test
 * runs under the same (vitest on Electron's node). Bundles are (re)built on demand
 * below.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..') // packages/apps/hub
const COMPUTER_DIR = join(HUB_DIR, '..', 'computer') // packages/apps/computer
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const COMPUTER_BIN = join(COMPUTER_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

/** Newest mtime under a dir tree (for stale-build detection). */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** Build a bundle on demand: (re)build when the bin is missing or older than any src file. */
function ensureBuilt(pkgDir: string, bin: string, label: string): void {
  let needs = !existsSync(bin)
  if (!needs) needs = newestMtime(join(pkgDir, 'src')) > statSync(bin).mtimeMs
  if (!needs) return
  console.log(`  … building ${label} bundle (bin missing or stale)`)
  execFileSync('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`${label} build did not produce ${bin}`)
}

/**
 * Inherited env with every `SLAYZONE_`- and `ELECTRON_`-prefixed key stripped —
 * the dogfooding parent leaks vars that would redirect a child at the REAL dev
 * store. Callers re-add only the explicit isolation vars they need.
 */
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
  stop: () => Promise<void>
}

function spawnChild(bin: string, env: Record<string, string>): Proc {
  const logs: string[] = []
  const proc = spawn(ELECTRON_BIN, [bin], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  return {
    proc,
    logs,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* gone */
          }
        }, 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        try {
          proc.kill('SIGTERM')
        } catch {
          clearTimeout(t)
          resolve()
        }
      })
  }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Real dev + prod primary DBs — must be byte-unchanged across this test. */
const STATE_DIR = join(homedir(), 'Library', 'Application Support', 'slayzone')
const GUARDED = [
  'slayzone.dev.sqlite',
  'slayzone.sqlite',
  'slayzone.dev.data.sqlite',
  'slayzone.data.sqlite'
].map((f) => join(STATE_DIR, f))
function fingerprint(p: string): string {
  try {
    const s = statSync(p)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'absent'
  }
}

// Lazy import of the WS tRPC client bits (present in the hub package's deps).
const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
const superjson = (await import('superjson')).default

const secret = require('node:crypto').randomBytes(32).toString('hex') as string
let before: string[] = []
let root = ''
let hubRootDir = ''
let computerRootDir = ''
let workDir = ''
// DB + state derive directly at <ROOT> (flat, no storage/ wrapper); assert the
// hub landed there, not the real DB.
let hubStorageDir = ''
let hub: Proc | null = null
let computer: Proc | null = null
let wsClient: { close: () => void } | null = null
let hubPort = 0
let hubDbPath = ''
let owner: { token?: string; userId?: string } = {}
let ownerToken: string | undefined
let tok: { token: string; hubUrl: string }
let trpc: {
  computers: { list: { query: () => Promise<Array<{ name: string; connected: boolean }>> } }
}

beforeAll(() => {
  ensureBuilt(HUB_DIR, HUB_BIN, 'hub')
  ensureBuilt(COMPUTER_DIR, COMPUTER_BIN, 'computer')

  // Snapshot the guarded real DBs BEFORE anything spawns.
  before = GUARDED.map(fingerprint)

  root = mkdtempSync(join(tmpdir(), 'slz-install-handshake-'))
  hubRootDir = join(root, 'hub-root')
  computerRootDir = join(root, 'computer-root')
  workDir = join(root, 'work')
  for (const d of [hubRootDir, computerRootDir, workDir]) mkdirSync(d, { recursive: true })
  hubStorageDir = hubRootDir
})

afterAll(async () => {
  wsClient?.close()
  if (computer) await computer.stop()
  if (hub) await hub.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('the hub, booted standalone', () => {
  beforeAll(async () => {
    // --- boot the hub, standalone + fully isolated ---------------------------
    hub = spawnChild(HUB_BIN, {
      ...scrubbedEnv(),
      SLAYZONE_ROOT: hubRootDir,
      // Where the hub LISTENS. `:0` = let the OS assign the port.
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      // Login on, so the bootstrap owner file and the bearer paths below are real.
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_AUTH_SECRET: secret
    })

    // Parse the hub's listening line: "listening on http://127.0.0.1:PORT (data=… db=…)".
    const listen = await poll(
      async () => hub!.logs.find((l) => l.includes('listening on http://')) ?? null,
      30_000,
      'hub listening line'
    )
    const m = listen.match(/http:\/\/(127\.0\.0\.1):(\d+).*db=([^)\s]+)/)
    expect(m, `hub listening line parseable: ${listen}`).not.toBeNull()
    hubPort = Number(m![2])
    hubDbPath = m![3]!
  })

  test('hub boots against the ISOLATED tmp store (not the real dev/prod DB)', async () => {
    expect(
      hubDbPath.startsWith(hubStorageDir),
      `hub db path under tmp store: ${hubDbPath}`
    ).toBeTruthy()
    // /health confirms readiness + echoes the same isolated db path.
    const health = await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${hubPort}/health`)
        if (r.status !== 200) return null
        return (await r.json()) as { ok: boolean; dbPath: string }
      },
      15_000,
      'hub /health ok'
    )
    expect(health.ok, 'health ok').toBe(true)
    expect(
      health.dbPath.startsWith(hubStorageDir),
      `health db path under tmp: ${health.dbPath}`
    ).toBeTruthy()
  })
})

// This hub runs with SLAYZONE_HUB_REQUIRE_LOGIN=1, so it requires client auth
// on EVERY route — including `/api/computers/join-token`, which used to trust
// any loopback peer unconditionally regardless of that. The bootstrap owner
// file is exactly the affordance that keeps `slay computer mint` usable on a
// clean root with no operator action; read it here too, matching the real
// `resolveHubRequestTarget` fallback (api.ts / hub-request.ts) rather than
// simulating an authenticated caller some other way.
describe('a join token minted with the bootstrap owner token', () => {
  beforeAll(async () => {
    const ownerRaw = readFileSync(join(hubRootDir, 'hub.owner.json'), 'utf-8')
    owner = JSON.parse(ownerRaw) as { token?: string; userId?: string }
    ownerToken = owner.token
    expect(Boolean(ownerToken), 'bootstrap owner file carries a bearer token').toBe(true)

    // --- mint a join token over the loopback REST channel --------------------
    // Poll: the route 503s until the /computers listener has bound (computer mode on).
    tok = await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${hubPort}/api/computers/join-token`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ownerToken}`
          },
          // T-20: minted FOR a named user — the owner, by account id.
          body: JSON.stringify({ label: 'install-handshake', forUser: owner.userId })
        })
        if (r.status !== 200) return null
        return (await r.json()) as { token: string; hubUrl: string }
      },
      20_000,
      'join-token mint (listener bound)'
    )
  })

  // This hub sets no SLAYZONE_HUB_PUBLIC_ADDRESS, so the computer url written into
  // the token is `ws://` loopback on the hub's own port (deriveComputerHubUrl). The
  // `wss://`-from-public-address derivation is unit-covered in
  // computer-tls-listener.test.ts; asserting wss here would contradict the boot.
  test('POST /api/computers/join-token mints a pin-less szjt1 token + local ws computer url', async () => {
    expect(typeof tok.token, 'szjt1 token').toBe('string')
    expect(tok.token.startsWith('szjt1.'), 'szjt1 token').toBeTruthy()
    expect(tok.hubUrl, `local computer url is ws:// on the hub port, got: ${tok.hubUrl}`).toBe(
      `ws://127.0.0.1:${hubPort}/computers`
    )
    // The hub presents no certificate of its own, so the token carries NO pin:
    // no certFingerprint field at all.
    const payload = JSON.parse(
      Buffer.from(tok.token.slice('szjt1.'.length), 'base64url').toString('utf8')
    ) as { hubUrl: string; certFingerprint?: unknown }
    expect(
      'certFingerprint' in payload,
      `pin-less token, got: ${JSON.stringify(payload)}`
    ).toBeFalsy()
    expect(payload.hubUrl, 'the token embeds the same url').toBe(tok.hubUrl)
  })

  test('the hub created no identity/ directory (it holds no certificate)', async () => {
    expect(existsSync(join(hubRootDir, 'identity')), 'no <ROOT>/identity').toBeFalsy()
  })

  test('/health reports every switch and authRequired, and no mode', async () => {
    const body = (await (await fetch(`http://127.0.0.1:${hubPort}/health`)).json()) as {
      authRequired?: boolean
      switches?: Record<string, boolean>
      mode?: unknown
    }
    expect(body.authRequired, 'login is required on this hub').toBe(true)
    expect(body.switches?.requireLogin, 'requireLogin reported').toBe(true)
    expect(body.switches?.enablePassword, 'enablePassword default reported').toBe(true)
    expect(body.switches?.enableSso, 'enableSso default reported').toBe(false)
    expect(body.switches?.enableProcesses, 'enableProcesses default reported').toBe(true)
    expect(body.switches?.enableIntegrations, 'enableIntegrations default reported').toBe(true)
    expect('mode' in body, 'no mode in /health').toBeFalsy()
  })
})

describe('the computer, enrolled with that token', () => {
  beforeAll(async () => {
    // --- spawn the computer, isolated, pointed at the minted token -------------
    // The computer display name + FS path-jail now come from <ROOT>/computer.config.json
    // (the SLAYZONE_COMPUTER_NAME / SLAYZONE_COMPUTER_ALLOWED_ROOTS env channels are gone).
    // Write them before spawn so the standalone computer reads them.
    writeFileSync(
      join(computerRootDir, 'computer.config.json'),
      JSON.stringify({ computerName: 'install-handshake-computer', allowedRoots: [workDir] })
    )
    computer = spawnChild(COMPUTER_BIN, {
      ...scrubbedEnv(),
      SLAYZONE_ROOT: computerRootDir,
      // Authority only — the computer composes ws(s)://<addr>/computers, the scheme
      // coming from the host (loopback → ws).
      SLAYZONE_HUB_ADDRESS: new URL(tok.hubUrl).host,
      SLAYZONE_HUB_JOIN_TOKEN: tok.token
    })

    // --- assert enrollment via computers.list over tRPC-WS ---------------------
    // Same owner token read above, reused for the tRPC-WS connection — one
    // bootstrap credential, two transports, exactly as a real operator's `slay`
    // would present it.
    const built = createWSClient({
      url: `ws://127.0.0.1:${hubPort}/trpc`,
      connectionParams: () => ({ token: ownerToken as string })
    })
    wsClient = built
    trpc = createTRPCClient({
      links: [wsLink({ client: built, transformer: superjson })]
    }) as unknown as typeof trpc
  })

  test('the computer enrolls with the PIN-LESS token and reports connected in computers.list', async () => {
    const row = await poll(
      async () => {
        const rows = await trpc.computers.list.query()
        const r = rows.find((x) => x.name === 'install-handshake-computer')
        return r && r.connected ? r : null
      },
      25_000,
      'computer connected'
    )
    expect(row.connected, 'computer connected').toBe(true)
  })

  test('the computer logged a successful hub connection', async () => {
    const connected = await poll(
      async () => (computer!.logs.some((l) => l.includes('connected to hub')) ? true : null),
      5_000,
      'computer connected log'
    )
    expect(connected, 'computer logged connected').toBeTruthy()
  })

  // --- ISOLATION: the real dev/prod DBs are byte-unchanged -----------------
  test('real dev + prod primary DBs are byte-unchanged (isolation proof)', async () => {
    const after = GUARDED.map(fingerprint)
    for (let i = 0; i < GUARDED.length; i++) {
      expect(before[i], `${GUARDED[i]} unchanged (was ${before[i]}, now ${after[i]})`).toBe(
        after[i]
      )
    }
  })
})

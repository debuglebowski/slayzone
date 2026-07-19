/**
 * Hub↔runner install-handshake — the fast, dev-tree tier of deploy coverage.
 *
 * Boots the built hub bin (dist/bin.cjs) as a STANDALONE process against a fully
 * isolated tmp home + store + OS-assigned ports, mints a join token over the
 * loopback REST channel (`POST /api/runners/join-token`), spawns the built runner
 * bin pointed at that token, and asserts the runner ENROLLS end-to-end (shows
 * `connected: true` in `runners.list`). This is the deploy path the desktop app's
 * local-runner-supervisor + the published npm packages both exercise — here over
 * the dev-tree bundles under Electron's node ABI (no native rebuild; Tier 1 in
 * scripts/publish-hub-runner.sh covers the `npm install` ABI-rebuild path).
 *
 * ISOLATION (must never touch the real dev/prod stores):
 *   - The child env is SCRUBBED of every `SLAYZONE_*` / `ELECTRON_*` var (the
 *     dogfooding parent leaks SLAYZONE_SUPERVISED=1 + SLAYZONE_DB_PATH → real dev
 *     DB, and ELECTRON_RUN_AS_NODE), mirroring e2e/fixtures/electron.ts. Only the
 *     explicit isolation vars below are re-added.
 *   - SLAYZONE_HOME_DIR + SLAYZONE_STORE_DIR + SLAYZONE_RUNNER_CREDENTIALS_DIR all
 *     point under one throwaway mkdtemp dir; ports are 0 (OS-assigned) so nothing
 *     collides with a running app's claimed port.
 *   - The test records the real dev+prod primary DBs' mtime+size before/after and
 *     asserts byte-identical, and asserts the hub's OWN resolved db path (parsed
 *     from its boot line + /health) sits under the tmp dir.
 *
 * Native ABI: better-sqlite3 (hub) + node-pty (runner) are built for Electron's
 * ABI, so both bins run under `ELECTRON_RUN_AS_NODE=1 electron`, and this test
 * runs under the same (run_test_electron_strict_loader in run-all.sh). Bundles
 * are (re)built on demand below. Hand-rolled harness (no vitest import).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..') // packages/apps/hub
const RUNNER_DIR = join(HUB_DIR, '..', 'runner') // packages/apps/runner
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const RUNNER_BIN = join(RUNNER_DIR, 'dist', 'bin.cjs')
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
const GUARDED = ['slayzone.dev.sqlite', 'slayzone.sqlite'].map((f) => join(STATE_DIR, f))
function fingerprint(p: string): string {
  try {
    const s = statSync(p)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return 'absent'
  }
}

async function main(): Promise<void> {
  console.log('\nhub↔runner install handshake (isolated dev-tree bins)')
  console.log('─'.repeat(52))

  ensureBuilt(HUB_DIR, HUB_BIN, 'hub')
  ensureBuilt(RUNNER_DIR, RUNNER_BIN, 'runner')

  // Snapshot the guarded real DBs BEFORE anything spawns.
  const before = GUARDED.map(fingerprint)

  const root = mkdtempSync(join(tmpdir(), 'slz-install-handshake-'))
  const homeDir = join(root, 'home')
  const storeDir = join(root, 'hub-store')
  const credsDir = join(root, 'runner-creds')
  const workDir = join(root, 'work')
  for (const d of [homeDir, storeDir, credsDir, workDir]) mkdirSync(d, { recursive: true })

  const secret = require('node:crypto').randomBytes(32).toString('hex') as string
  let hub: Proc | null = null
  let runner: Proc | null = null
  // Lazy import of the WS tRPC client bits (present in the hub package's deps).
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  let wsClient: { close: () => void } | null = null

  try {
    // --- boot the hub, standalone + fully isolated ---------------------------
    hub = spawnChild(HUB_BIN, {
      ...scrubbedEnv(),
      SLAYZONE_HOME_DIR: homeDir,
      SLAYZONE_STORE_DIR: storeDir,
      SLAYZONE_PORT: '0',
      SLAYZONE_RUNNER_TRANSPORT_PORT: '0',
      SLAYZONE_RUNNER_TRANSPORT_SECRET: secret
    })

    // Parse the hub's listening line: "listening on http://127.0.0.1:PORT (data=… db=…)".
    const listen = await poll(
      async () => hub!.logs.find((l) => l.includes('listening on http://')) ?? null,
      30_000,
      'hub listening line'
    )
    const m = listen.match(/http:\/\/(127\.0\.0\.1):(\d+).*db=([^)\s]+)/)
    assert(m, `hub listening line parseable: ${listen}`)
    const hubPort = Number(m![2])
    const hubDbPath = m![3]

    await test('hub boots against the ISOLATED tmp store (not the real dev/prod DB)', async () => {
      assert(hubDbPath.startsWith(storeDir), `hub db path under tmp store: ${hubDbPath}`)
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
      assert(health.ok === true, 'health ok')
      assert(health.dbPath.startsWith(storeDir), `health db path under tmp: ${health.dbPath}`)
    })

    // --- mint a join token over the loopback REST channel --------------------
    // Poll: the route 503s until the /runners listener has bound (runner mode on).
    const tok = await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${hubPort}/api/runners/join-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'install-handshake' })
        })
        if (r.status !== 200) return null
        return (await r.json()) as { token: string; hubUrl: string }
      },
      20_000,
      'join-token mint (listener bound)'
    )
    await test('POST /api/runners/join-token mints a pinned szjt1 token + wss runner url', async () => {
      assert(typeof tok.token === 'string' && tok.token.startsWith('szjt1.'), 'szjt1 token')
      assert(tok.hubUrl.startsWith('wss://') && tok.hubUrl.endsWith('/runners'), 'wss runner url')
    })

    // --- spawn the runner, isolated, pointed at the minted token -------------
    runner = spawnChild(RUNNER_BIN, {
      ...scrubbedEnv(),
      SLAYZONE_HOME_DIR: homeDir,
      SLAYZONE_HUB_URL: tok.hubUrl,
      SLAYZONE_JOIN_TOKEN: tok.token,
      SLAYZONE_RUNNER_NAME: 'install-handshake-runner',
      SLAYZONE_RUNNER_CREDENTIALS_DIR: credsDir,
      SLAYZONE_RUNNER_ALLOWED_ROOTS: workDir
    })

    // --- assert enrollment via runners.list over tRPC-WS ---------------------
    const built = createWSClient({ url: `ws://127.0.0.1:${hubPort}/trpc` })
    wsClient = built
    const trpc = createTRPCClient({
      links: [wsLink({ client: built, transformer: superjson })]
    }) as unknown as {
      runners: { list: { query: () => Promise<Array<{ name: string; connected: boolean }>> } }
    }

    await test('the runner enrolls and reports connected in runners.list', async () => {
      const row = await poll(
        async () => {
          const rows = await trpc.runners.list.query()
          const r = rows.find((x) => x.name === 'install-handshake-runner')
          return r && r.connected ? r : null
        },
        25_000,
        'runner connected'
      )
      assert(row.connected === true, 'runner connected')
    })

    await test('the runner logged a successful hub connection', async () => {
      const connected = await poll(
        async () => (runner!.logs.some((l) => l.includes('connected to hub')) ? true : null),
        5_000,
        'runner connected log'
      )
      assert(connected, 'runner logged connected')
    })

    // --- ISOLATION: the real dev/prod DBs are byte-unchanged -----------------
    await test('real dev + prod primary DBs are byte-unchanged (isolation proof)', async () => {
      const after = GUARDED.map(fingerprint)
      for (let i = 0; i < GUARDED.length; i++) {
        assert(
          before[i] === after[i],
          `${GUARDED[i]} unchanged (was ${before[i]}, now ${after[i]})`
        )
      }
    })
  } finally {
    wsClient?.close()
    if (runner) await runner.stop()
    if (hub) await hub.stop()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()

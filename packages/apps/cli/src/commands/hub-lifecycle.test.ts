/**
 * `slay hub` end-to-end against REAL hubs
 * (plans/hub-lifecycle-and-discovery.md, Phase 6).
 *
 * Drives the BUILT `slay` bundle against actual hub processes: two hubs in two
 * throwaway roots, then `hub ls` → `--hub` targeting → `hub stop`. The library
 * pieces are unit-tested elsewhere (platform/src/hub-discovery + service-unit);
 * what only an end-to-end run can catch is the wiring — whether the CLI resolves,
 * prints and signals the right hub, and whether it works on a machine that has no
 * SlayZone database at all (the hub-only deployment, which is the primary one).
 *
 * DELIBERATELY NEVER RUNS A SUCCEEDING `hub create`: that registers a
 * launchd/systemd unit on whatever machine runs the suite, which must never be a
 * side effect of a test. `create` appears only in cases that must FAIL (duplicate
 * name, occupied root, missing argument), which are all decided before anything is
 * registered. Hubs here are spawned directly instead, so `hub stop` exercises its
 * SIGTERM fallback path. Unit-file CONTENT is covered by
 * platform/src/service-unit.test.ts; the register-and-start path is a documented
 * manual check (see the plan).
 *
 * ISOLATION — must never touch the real dev/prod stores:
 *   - every `SLAYZONE_*` / `ELECTRON_*` var is scrubbed from child envs (a
 *     supervised parent leaks SLAYZONE_ROOT → the real dev store);
 *   - each hub gets `SLAYZONE_ROOT` under one throwaway mkdtemp dir;
 *   - each hub is pinned to an explicit high port outside the hub block, so a
 *     developer's or CI's real hubs cannot be discovered, listed, or stopped by
 *     this test. The block sweep is exercised with a narrowed range instead.
 *
 * Native ABI: the hub bundle needs better-sqlite3 built for Electron's ABI, so
 * hubs run under `ELECTRON_RUN_AS_NODE=1 electron` (as does this suite, under
 * vitest.harness.config.ts). The CLI bundle is plain node.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
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
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { detectBackend } from '@slayzone/platform/service-unit'

// Package roots are derived from the REPO root rather than this file's own URL:
// the CLI package typechecks as CommonJS (see its tsconfig `module`), where
// `import.meta` is a compile error, even though the suite is executed as ESM.
// Anchored on cwd, which run-all.sh (and vitest, root = repo) invokes from the repo root.
const REPO_ROOT = process.env.SLZ_REPO_ROOT ?? process.cwd()
const CLI_DIR = resolve(REPO_ROOT, 'packages/apps/cli')
const HUB_DIR = resolve(REPO_ROOT, 'packages/apps/hub')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
/**
 * The REAL Electron executable, not `node_modules/.bin/electron` — that is a Node
 * shim which spawns the binary as a CHILD, so the pid we hold would be the shim's
 * while `/health` reports the hub's own, and they would never match.
 *
 * `electron/path.txt` holds the platform-correct relative path (a .app bundle on
 * macOS, a bare executable elsewhere), which is how electron's own `index.js`
 * resolves it — so this stays right on Linux and Windows too.
 */
const ELECTRON_BIN = resolve(
  REPO_ROOT,
  'node_modules/electron/dist',
  readFileSync(resolve(REPO_ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
)

/**
 * A real `node` for running the CLI. This suite itself runs under Electron, so
 * `process.execPath` points at the Electron binary — see the note on `slay()`.
 * `process.env.NODE` is set by some computers; otherwise fall back to PATH lookup,
 * which is how a user invokes the published bin anyway.
 */
const NODE_BIN = process.env.SLZ_TEST_NODE ?? 'node'

/**
 * Hubs here bind INSIDE the hub block (no explicit port → the block walk picks
 * one), because that is the only way to exercise the sweep and therefore
 * name-based lookup: `findHub('name')` has no port to probe directly, so it must
 * discover the hub. An out-of-block hub is unreachable by name BY DESIGN.
 *
 * The safety that would otherwise come from an out-of-block port comes from
 * process-unique NAMES instead: every assertion filters on this prefix, and
 * `hub stop` is only ever called with one of these names or a port this test
 * recorded — so a developer's or CI's real hub can never be listed as ours, and
 * can never be stopped by us.
 */
const NAME_PREFIX = `slztest-${process.pid}-`
const NAME_A = `${NAME_PREFIX}a`
const NAME_B = `${NAME_PREFIX}b`

/** Newest mtime under a dir tree (stale-build detection). */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** (Re)build a bundle when its output is missing or older than any source file. */
function ensureBuilt(pkgDir: string, bin: string, label: string): void {
  let needs = !existsSync(bin)
  if (!needs) needs = newestMtime(join(pkgDir, 'src')) > statSync(bin).mtimeMs
  if (!needs) return
  console.log(`  … building ${label} bundle (missing or stale)`)
  execFileSync('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`${label} build did not produce ${bin}`)
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

interface Hub {
  proc: ChildProcess
  logs: string[]
  root: string
  port: number
  stop: () => Promise<void>
}

const hubs: Hub[] = []
let TMP = ''

/**
 * Boot a real hub in its own root, letting it pick a port from the hub block (no
 * SLAYZONE_HUB_LISTEN_ADDRESS) — that is the path `hub start` uses and the only one
 * the discovery sweep can find. The chosen port is read back from its boot line.
 *
 * Login is required (SLAYZONE_HUB_REQUIRE_LOGIN=1): the `hub users` and `--hub`
 * cases below depend on a hub that provisions a bootstrap owner and demands a
 * bearer. A hub with no setting would be the desktop app's shape — login off.
 */
async function startHub(name: string): Promise<Hub> {
  const root = join(TMP, name)
  mkdirSync(root, { recursive: true })
  const logs: string[] = []
  const proc = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_NAME: name,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)

  // The hub announces its bound port on stdout; that is the only place the
  // block-walk's choice is visible from out here.
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(
      () =>
        reject(new Error(`hub "${name}" printed no listening line in 40s:\n${logs.join('\n')}`)),
      40_000
    )
    const poll = setInterval(() => {
      if (proc.exitCode !== null) {
        clearInterval(poll)
        clearTimeout(deadline)
        reject(new Error(`hub "${name}" exited during boot:\n${logs.slice(-15).join('\n')}`))
        return
      }
      const line = logs.find((l) => l.includes('listening on http://'))
      const match = line?.match(/listening on http:\/\/[^:]+:(\d+)/)
      if (match) {
        clearInterval(poll)
        clearTimeout(deadline)
        resolve(Number(match[1]))
      }
    }, 200)
  })

  const hub: Hub = {
    proc,
    logs,
    root,
    port,
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
        proc.kill('SIGTERM')
      })
  }
  hubs.push(hub)

  // Wait for /health rather than the boot line: the CLI reaches hubs the same way,
  // so this asserts the state the CLI actually depends on.
  const deadline = Date.now() + 30_000
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`hub "${name}" exited during boot:\n${logs.slice(-15).join('\n')}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      })
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`hub "${name}" did not answer /health in 30s:\n${logs.slice(-15).join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return hub
}

/**
 * Run the built `slay` with a scrubbed env. `root` sets SLAYZONE_ROOT, which also
 * decides where the CLI looks for a database — pointing it at a hub root (which
 * has no app DB) is exactly the hub-only-machine case.
 *
 * Uses PLAIN NODE, not `process.execPath`: this suite runs under Electron (the hub
 * bundle needs its native ABI), so execPath is the Electron binary — and since the
 * scrubbed env drops `ELECTRON_RUN_AS_NODE`, running the CLI through it would
 * launch a GUI app that never exits and hang the suite. The CLI has no native deps,
 * so plain node is also what a user actually runs.
 */
function slay(
  args: string[],
  opts: { root?: string; env?: Record<string, string> } = {}
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(NODE_BIN, [CLI_BIN, ...args], {
    encoding: 'utf8',
    // Never hang the suite: a wedged CLI call fails the case instead.
    timeout: 60_000,
    env: {
      ...scrubbedEnv(),
      ...(opts.root ? { SLAYZONE_ROOT: opts.root } : {}),
      ...(opts.env ?? {})
    }
  })
  if (res.error) throw new Error(`slay ${args.join(' ')} failed to run: ${res.error.message}`)
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * POST JSON to a hub's better-auth endpoint, the way a REAL client does.
 *
 * MUST be `node:http`, NOT `fetch`. Node's fetch (undici) attaches `Sec-Fetch-*`
 * headers, and better-auth's CSRF middleware treats their presence as a browser
 * form post — it then demands an `Origin` matching its own `baseURL` (a fixed
 * `http://127.0.0.1:8788` loopback constant; computers authenticate by api-key, so
 * nothing else depends on it). A plain fetch therefore 403s
 * `MISSING_OR_NULL_ORIGIN` before the route ever runs, which looks exactly like a
 * broken auth config while actually testing nothing.
 *
 * `http.request` sends no `Sec-Fetch-*`, so the CSRF path is skipped — matching the
 * desktop app's `hubLogin`, which is also `http(s).request` for its own reasons
 * (CSP + cert pinning). So this helper exercises the real login path, not an
 * artefact of the test client.
 */
// `agent: false` on both helpers: a fresh connection per request. Node's global
// agent keeps sockets alive, and the synchronous `slay()` spawns between requests
// block this event loop for seconds under load — the hub's keep-alive timeout
// closes the idle socket unseen, the next request reuses it, and reads ECONNRESET.
function postJson(
  port: number,
  path: string,
  body: unknown
): Promise<{
  status: number
  body: string
  headers: Record<string, string | string[] | undefined>
}> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'POST',
        timeout: 10_000,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? -1, body: text, headers: res.headers })
        )
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`POST ${path} timed out`))
    })
    req.end(payload)
  })
}

/**
 * `hub ls --json`, narrowed to THIS test's hubs by name prefix. The sweep also
 * finds a developer's or CI's real hubs — filtering keeps them out of every
 * assertion (and out of anything this test would ever stop).
 */
/** GET with a bearer; the status is all the callers need. */
function getStatus(port: number, path: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${port}${path}`,
      {
        method: 'GET',
        timeout: 10_000,
        agent: false,
        headers: { authorization: `Bearer ${token}` }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? -1))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function lsJson(root: string): Array<Record<string, unknown>> {
  const res = slay(['hub', 'ls', '--json'], { root })
  expect(res.status, `hub ls exited 0 (stderr: ${res.stderr})`).toBe(0)
  const parsed = JSON.parse(res.stdout) as Array<Record<string, unknown>>
  return parsed.filter((h) => typeof h.name === 'string' && h.name.startsWith(NAME_PREFIX))
}

/**
 * A stub `/health` reporting `supervised: true`, in its OWN process.
 *
 * Must not be an in-process server: `slay()` uses spawnSync, which blocks this
 * process's event loop, so an in-process stub could never answer the CLI's probe
 * (it would look like "no hub there" — a false pass for a refusal test).
 */
async function startSupervisedStub(): Promise<{
  port: number
  proc: ChildProcess
  stop: () => void
}> {
  const script = `
    const http = require('node:http');
    const srv = http.createServer((req, res) => {
      if (req.url !== '/health') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true, port: 0, name: ${JSON.stringify(`${NAME_PREFIX}app`)},
        root: '/tmp/fake-app-root', dbPath: '/tmp/fake-app-root/storage/slayzone.sqlite',
        // A pid that must NOT be signalled: this stub's own. If the supervised
        // refusal is broken, the CLI kills the stub and the assertion below
        // (stub still answering) fails loudly.
        pid: process.pid, mode: 'local', supervised: true, computersConnected: 1,
        uptimeMs: 1000, commit: 'x', builtAt: 'x', buildId: 'x'
      }));
    });
    srv.listen(0, '127.0.0.1', () => console.log('PORT=' + srv.address().port));
  `
  const proc = spawn(NODE_BIN, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  proc.stdout?.on('data', (b: Buffer) => {
    out += b.toString()
  })
  // Awaited (not a sync spin) so the child's stdout is actually delivered — the
  // port only becomes known once the event loop can read the pipe. The subsequent
  // spawnSync blocking the loop is fine; by then we already have the port.
  const started = Date.now()
  for (;;) {
    const m = out.match(/PORT=(\d+)/)
    if (m) return { port: Number(m[1]), proc, stop: () => proc.kill('SIGKILL') }
    if (Date.now() - started > 15_000 || proc.exitCode !== null) {
      proc.kill('SIGKILL')
      throw new Error(`supervised stub did not start: ${out}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('slay hub — end-to-end against real hubs', () => {
  // Every `slay` call below runs with SLAYZONE_ROOT pointed at a hub root, which
  // contains NO app database — so any command that hard-requires one fails here.
  // That is the hub-only-machine condition, held for the whole suite rather than
  // checked once.
  let rootA = ''

  beforeAll(() => {
    // Fail with a clear reason rather than a confusing spawn error if the anchor is
    // wrong (this test must be run from the repo root, as run-all.sh does).
    if (!existsSync(CLI_DIR) || !existsSync(HUB_DIR)) {
      throw new Error(
        `cannot locate packages under ${REPO_ROOT} — run from the repo root, ` +
          `or set SLZ_REPO_ROOT`
      )
    }
    ensureBuilt(HUB_DIR, HUB_BIN, 'hub')
    ensureBuilt(CLI_DIR, CLI_BIN, 'cli')
    TMP = mkdtempSync(join(tmpdir(), 'slz-hubctl-'))
    rootA = join(TMP, NAME_A)
  })

  // Backstop for a run that failed before the last case: the last case stops the
  // hubs itself (it must, to observe strays), and stop() is idempotent.
  afterAll(async () => {
    for (const h of hubs) await h.stop()
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  })

  test('hub ls works with NO SlayZone database (hub-only machine)', async () => {
    const empty = join(TMP, 'no-db-at-all')
    mkdirSync(empty, { recursive: true })
    const res = slay(['hub', 'ls'], { root: empty })
    // This used to pin a file-probe guard: `hub ls` reached the app's port
    // through `getServerPort()` → `openDb()`, which `process.exit(1)`s when the
    // DB file is absent — uncatchable, so the probe had to come first. The CLI
    // opens no database at all now, so the property is structural rather than
    // guarded; the assertion stays as the regression fence that keeps it so.
    expect(res.status, `exited 0 (stdout: ${res.stdout} stderr: ${res.stderr})`).toBe(0)
    expect(
      res.stderr + res.stdout,
      `did not demand a database: ${res.stderr}${res.stdout}`
    ).not.toMatch(/Database not found/i)
  })

  test('two hubs boot in separate roots, each taking a free hub-block port', async () => {
    const a = await startHub(NAME_A)
    const b = await startHub(NAME_B)
    expect(a.port, `distinct ports (${a.port} vs ${b.port})`).not.toBe(b.port)
    for (const h of [a, b]) {
      expect(
        h.port,
        `port ${h.port} inside the dynamic hub range (discovery only sweeps the block)`
      ).toBeGreaterThanOrEqual(51110)
      expect(
        h.port,
        `port ${h.port} inside the dynamic hub range (discovery only sweeps the block)`
      ).toBeLessThanOrEqual(51199)
    }
  })

  test('ls finds both hubs and reports name, root, pid and port', async () => {
    const listed = lsJson(rootA)
    expect(listed.length, `both listed (got ${JSON.stringify(listed.map((h) => h.name))})`).toBe(2)
    for (const h of listed) {
      const live = hubs.find((x) => x.port === h.port)
      expect(live, `row ${String(h.name)} matches a spawned hub`).toBeDefined()
      expect(h.name, 'name follows SLAYZONE_HUB_NAME').toBe(basename(live!.root))
      expect(h.root, 'root matches').toBe(live!.root)
      expect(h.pid, 'pid is the real hub process').toBe(live!.proc.pid)
      expect(h.supervised, 'a standalone hub is not flagged supervised').toBe(false)
    }
  })

  test('ls prints a table naming both hubs', async () => {
    const res = slay(['hub', 'ls'], { root: rootA })
    expect(res.status, 'exited 0').toBe(0)
    expect(res.stdout, `has a header: ${res.stdout}`).toMatch(/NAME\s+PORT\s+PID/)
    expect(res.stdout, 'lists hub A').toContain(NAME_A)
    expect(res.stdout, 'lists hub B').toContain(NAME_B)
  })

  test('--hub <port> routes to that hub', async () => {
    const b = hubs.find((h) => basename(h.root) === NAME_B)!
    // `hub current` echoes the resolved target, so it proves WHICH hub was hit.
    const res = slay(['--hub', String(b.port), 'hub', 'current'], { root: rootA })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    expect(res.stdout, `targeted hub B: ${res.stdout}`).toContain(String(b.port))
    expect(res.stdout, `probed healthy: ${res.stdout}`).toMatch(/Health: ok/)
  })

  test('--hub <name> resolves through the sweep to the right port', async () => {
    const b = hubs.find((h) => basename(h.root) === NAME_B)!
    const res = slay(['--hub', NAME_B, 'hub', 'current'], { root: rootA })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    expect(res.stdout, `name → hub B's port: ${res.stdout}`).toContain(String(b.port))
  })

  test('--hub with an unknown name fails loudly and lists what IS running', async () => {
    const res = slay(['--hub', `${NAME_PREFIX}nope`, 'hub', 'current'], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `named the problem: ${res.stderr}`).toMatch(/No hub named or listening on/)
    expect(res.stderr, `listed the alternatives: ${res.stderr}`).toMatch(/Running hubs:/)
  })

  // ── accounts (`hub users`) ────────────────────────────────────────────────
  // The only end-to-end coverage of the composition wiring: the `hubUsers` REST
  // capability is closed over a LATE-BOUND hub-auth ref (built async, after
  // restDeps), so a wiring mistake there is invisible to every unit test and shows
  // up only against a really-booted hub.
  test('hub users: add prints a one-time password, ls lists the account', async () => {
    const email = `op-${process.pid}@example.com`
    const add = slay(['--hub', NAME_A, 'hub', 'users', 'add', email, '--json'], { root: rootA })
    expect(add.status, `add exited 0 (stderr: ${add.stderr})`).toBe(0)
    const created = JSON.parse(add.stdout) as { email: string; password: string }
    expect(created.email, 'echoed the created email').toBe(email)
    expect(created.password.length, 'returned a generated password').toBeGreaterThan(0)

    const ls = slay(['--hub', NAME_A, 'hub', 'users', 'ls'], { root: rootA })
    expect(ls.status, `ls exited 0 (stderr: ${ls.stderr})`).toBe(0)
    expect(ls.stdout, `lists the account: ${ls.stdout}`).toContain(email)
    // The internal computer-key owner is a user row, but not an operator account.
    expect(ls.stdout, 'hides the service identity').not.toContain('computers@slayzone.internal')
  })

  test('hub users: the created password actually authenticates', async () => {
    // The point of the whole feature — a created account must be able to SIGN IN.
    // A user row without its linked `credential` account would pass `ls` and fail
    // here, which is the failure mode this asserts against.
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const email = `signin-${process.pid}@example.com`
    const add = slay(['--hub', NAME_A, 'hub', 'users', 'add', email, '--json'], { root: rootA })
    expect(add.status, `add exited 0 (stderr: ${add.stderr})`).toBe(0)
    const { password } = JSON.parse(add.stdout) as { password: string }

    const res = await postJson(a.port, '/api/auth/sign-in/email', { email, password })
    expect(res.status, `sign-in succeeded with the generated password: ${res.body}`).toBe(200)
    const token = res.headers['set-auth-token']
    expect(typeof token, 'got a bearer token back').toBe('string')
    expect((token as string).length, 'got a bearer token back').toBeGreaterThan(0)
  })

  test('hub users: public sign-up is refused on a real booted hub', async () => {
    // The security half of this feature, asserted against the actual HTTP surface
    // rather than the auth config.
    //
    // NOW REFUSED TWICE, and this asserts the OUTER layer. The bearer gate's
    // `/api/auth/` exemption used to be a prefix, which made every route
    // better-auth or any plugin mounts under it reachable unauthenticated — the
    // computer-impersonation escalation came in through exactly that door. It is
    // now an exact allowlist (`sign-in/email`, `sign-out`, `get-session`), so
    // sign-up is rejected by the gate before better-auth ever sees it: 401, not
    // the previous 400.
    //
    // The INNER layer — `emailAndPassword.disableSignUp` making the route refuse
    // at the source even for a caller who passes the gate — is asserted
    // in-process in hub-auth.test.ts ('refuses public sign-up'). Both matter:
    // the gate could be widened by a future exemption, and the flag could be
    // dropped; either alone still closes signup.
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const res = await postJson(a.port, '/api/auth/sign-up/email', {
      email: `intruder-${process.pid}@example.com`,
      password: 'a-perfectly-valid-password',
      name: 'Intruder'
    })
    expect(res.status, `sign-up rejected by the gate: ${res.body}`).toBe(401)
    // Assert the REASON, not just the status — a 401 that came from anywhere
    // else would pass a status-only check while signup was in fact reachable.
    expect(res.body, `refused by the bearer gate: ${res.body}`).toContain('Unauthorized')
    // And the allowlisted sign-in route is genuinely still open on the same hub,
    // so this is proof of a narrowed exemption rather than a sealed prefix.
    const openRoute = await postJson(a.port, '/api/auth/sign-in/email', {
      email: 'nobody@example.com',
      password: 'wrong'
    })
    expect(
      openRoute.status !== 401 || !openRoute.body.includes('Unauthorized'),
      `sign-in still reaches better-auth (got ${openRoute.status}: ${openRoute.body})`
    ).toBe(true)
  })

  // Accounts are disabled, never deleted (T-08). Hub A's bootstrap owner is the
  // account THIS CLI authenticates with (read from `hub.owner.json`), so it is the
  // one account these cases never disable.
  const usersLs = () => {
    const res = slay(['--hub', NAME_A, 'hub', 'users', 'ls', '--json'], { root: rootA })
    expect(res.status, `ls --json exited 0 (stderr: ${res.stderr})`).toBe(0)
    return JSON.parse(res.stdout) as Array<{
      email: string
      role: string
      disabledAt: string | null
    }>
  }

  test('hub users: the bootstrap owner is admin; add --admin makes an admin', async () => {
    // `ls` orders by createdAt and the owner is provisioned first, at hub boot.
    const owner = usersLs()[0]!
    expect(owner.role, 'the bootstrap owner is the admin').toBe('admin')
    expect(owner.disabledAt, 'and enabled').toBe(null)
    const email = `admin-${process.pid}@example.com`
    const add = slay(['--hub', NAME_A, 'hub', 'users', 'add', email, '--admin', '--json'], {
      root: rootA
    })
    expect(add.status, `add --admin exited 0 (stderr: ${add.stderr})`).toBe(0)
    expect((JSON.parse(add.stdout) as { role: string }).role, 'created as admin').toBe('admin')
    const ls = slay(['--hub', NAME_A, 'hub', 'users', 'ls'], { root: rootA })
    expect(ls.stdout, `ls shows ROLE and DISABLED: ${ls.stdout}`).toMatch(/ROLE\s+DISABLED/)
  })

  test('hub users: disable keeps the account and blocks it; enable restores it', async () => {
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const email = `leaver-${process.pid}@example.com`
    const add = slay(['--hub', NAME_A, 'hub', 'users', 'add', email, '--json'], { root: rootA })
    expect(add.status, `add exited 0 (stderr: ${add.stderr})`).toBe(0)
    const { password } = JSON.parse(add.stdout) as { password: string }
    const signIn = await postJson(a.port, '/api/auth/sign-in/email', { email, password })
    expect(signIn.status, `signed in while enabled: ${signIn.body}`).toBe(200)
    const token = String(signIn.headers['set-auth-token'])
    // Any full session may list tasks (a `user` may not use /api/hub/users).
    expect(await getStatus(a.port, '/api/tasks', token), 'its bearer works').toBe(200)

    const disable = slay(['--hub', NAME_A, 'hub', 'users', 'disable', email], { root: rootA })
    expect(disable.status, `disable exited 0 (stderr: ${disable.stderr})`).toBe(0)
    expect(disable.stdout, `confirmed: ${disable.stdout}`).toMatch(/Disabled account/)
    const row = usersLs().find((u) => u.email === email)
    expect(row, 'the account is still listed').toBeDefined()
    expect(row!.disabledAt, 'and marked disabled').not.toBe(null)
    expect(await getStatus(a.port, '/api/tasks', token), 'its bearer is revoked').toBe(401)
    const refused = await postJson(a.port, '/api/auth/sign-in/email', { email, password })
    expect(refused.status, `sign-in refused: ${refused.body}`).toBe(403)
    expect(refused.body, `names why: ${refused.body}`).toContain('ACCOUNT_DISABLED')

    const enable = slay(['--hub', NAME_A, 'hub', 'users', 'enable', email], { root: rootA })
    expect(enable.status, `enable exited 0 (stderr: ${enable.stderr})`).toBe(0)
    expect(usersLs().find((u) => u.email === email)!.disabledAt, 'enabled again').toBe(null)
    const again = await postJson(a.port, '/api/auth/sign-in/email', { email, password })
    expect(again.status, `signs in again: ${again.body}`).toBe(200)
  })

  test('hub users: a user account’s bearer gets 403 and cannot promote itself', async () => {
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const email = `plain-${process.pid}@example.com`
    const add = slay(['--hub', NAME_A, 'hub', 'users', 'add', email, '--json'], { root: rootA })
    expect(add.status, `add exited 0 (stderr: ${add.stderr})`).toBe(0)
    const { password, role } = JSON.parse(add.stdout) as { password: string; role: string }
    expect(role, 'a plain account').toBe('user')
    const signIn = await postJson(a.port, '/api/auth/sign-in/email', { email, password })
    expect(signIn.status, `signed in: ${signIn.body}`).toBe(200)
    const asUser = { SLAYZONE_HUB_TOKEN: String(signIn.headers['set-auth-token']) }
    for (const args of [
      ['ls'],
      ['add', `sneaky-${process.pid}@example.com`],
      ['disable', usersLs()[0]!.email],
      ['role', email, 'admin']
    ]) {
      const res = slay(['--hub', NAME_A, 'hub', 'users', ...args], { root: rootA, env: asUser })
      expect(res.status, `${args[0]} refused with a non-zero exit`).not.toBe(0)
      expect(res.stderr, `explained why: ${res.stderr}`).toMatch(/needs an admin account/)
    }
    const after = usersLs()
    expect(after.find((u) => u.email === email)!.role, 'still a user').toBe('user')
    expect(
      after.some((u) => u.email.startsWith('sneaky-')),
      'nothing was created'
    ).toBe(false)
    expect(after[0]!.disabledAt, 'the owner was not disabled').toBe(null)
  })

  test('hub users: role sets the role; the last enabled admin is never demoted or disabled', async () => {
    const owner = usersLs()[0]!.email
    // Demote every other admin, so the owner is the last one.
    for (const u of usersLs().filter((u) => u.role === 'admin' && u.email !== owner)) {
      const res = slay(['--hub', NAME_A, 'hub', 'users', 'role', u.email, 'user'], {
        root: rootA
      })
      expect(res.status, `demoted ${u.email} (stderr: ${res.stderr})`).toBe(0)
      expect(res.stdout, `confirmed: ${res.stdout}`).toMatch(/is now user/)
    }
    expect(usersLs().filter((u) => u.role === 'admin').length, 'one admin left').toBe(1)
    for (const args of [
      ['role', owner, 'user'],
      ['disable', owner]
    ]) {
      const res = slay(['--hub', NAME_A, 'hub', 'users', ...args], { root: rootA })
      expect(res.status, `${args[0]} refused with a non-zero exit`).not.toBe(0)
      expect(res.stderr, `explained why: ${res.stderr}`).toMatch(/last enabled admin/)
    }
    expect(usersLs()[0]!.role, 'the owner is still admin').toBe('admin')
    const bad = slay(['--hub', NAME_A, 'hub', 'users', 'role', owner, 'owner'], { root: rootA })
    expect(bad.status, 'an unknown role is refused').not.toBe(0)
  })

  test('hub users: rm was renamed to disable and changes nothing', async () => {
    const before = usersLs()
    const target = before[before.length - 1]!.email
    const rm = slay(['--hub', NAME_A, 'hub', 'users', 'rm', target], { root: rootA })
    expect(rm.status, 'non-zero exit').not.toBe(0)
    expect(rm.stderr, `names the new command: ${rm.stderr}`).toMatch(
      /renamed to `slay hub users disable <email>`/
    )
    expect(JSON.stringify(usersLs()), 'no account changed').toBe(JSON.stringify(before))
  })

  test('hub users: disable of an unknown account fails loudly', async () => {
    const res = slay(['--hub', NAME_A, 'hub', 'users', 'disable', 'nobody@example.com'], {
      root: rootA
    })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `named the problem: ${res.stderr}`).toMatch(/no user with email/)
  })

  test('hub users: several hubs running and no --hub is a refusal, not a guess', async () => {
    // Creating an account on the wrong hub is invisible until someone cannot sign
    // in, so ambiguity must fail rather than pick.
    const res = slay(['hub', 'users', 'ls'], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `explained the ambiguity: ${res.stderr}`).toMatch(/ambiguous/)
  })

  test('hub stop terminates an unregistered hub via SIGTERM, and discloses it', async () => {
    const b = hubs.find((h) => basename(h.root) === NAME_B)!
    const res = slay(['hub', 'stop', NAME_B], { root: rootA })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    // The hub was spawned directly, so there is no service unit — the CLI must
    // fall back to signalling the pid AND say that is what it did.
    expect(res.stdout, `disclosed the fallback: ${res.stdout}`).toMatch(/not registered by slay/i)
    const deadline = Date.now() + 15_000
    while (b.proc.exitCode === null && b.proc.signalCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(
      b.proc.exitCode !== null || b.proc.signalCode !== null,
      'hub process actually ended'
    ).toBe(true)
    const listed = lsJson(rootA)
    expect(listed.length, 'only hub A remains listed').toBe(1)
    expect(listed[0]?.name, 'and it is the one we did not stop').toBe(NAME_A)
  })

  test('hub stop on an already-gone hub fails loudly', async () => {
    const res = slay(['hub', 'stop', NAME_B], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `clear message: ${res.stderr}`).toMatch(/No hub named or listening on/)
  })

  test('hub stop REFUSES the desktop app’s supervised hub', async () => {
    // The app owns its sidecar's lifecycle: stopping it from here breaks a running
    // app while leaving it convinced its backend is alive. Booting a real
    // supervised hub needs the Electron host, so the refusal is driven through a
    // stub /health reporting supervised:true — the same field discovery reads.
    const stub = await startSupervisedStub()
    try {
      const res = slay(['hub', 'stop', String(stub.port)], { root: rootA })
      expect(res.status, `refused with a non-zero exit (stdout: ${res.stdout})`).not.toBe(0)
      expect(res.stderr, `explained who owns it: ${res.stderr}`).toMatch(/desktop app/i)
      // Still answering ⇒ the refusal happened BEFORE any signal. If the guard
      // regressed, the CLI would have killed the stub and this fails.
      expect(stub.proc.exitCode, 'stub process was never signalled').toBe(null)
      const health = await fetch(`http://127.0.0.1:${stub.port}/health`, {
        signal: AbortSignal.timeout(3000)
      })
      expect(health.ok, 'stub still serving /health').toBe(true)
    } finally {
      stub.stop()
    }
  })

  test('hub restart REFUSES the supervised hub too', async () => {
    const stub = await startSupervisedStub()
    try {
      const res = slay(['hub', 'restart', String(stub.port)], { root: rootA })
      expect(res.status, `refused with a non-zero exit (stdout: ${res.stdout})`).not.toBe(0)
      expect(res.stderr, `same refusal as stop: ${res.stderr}`).toMatch(/desktop app/i)
      expect(stub.proc.exitCode, 'stub never signalled').toBe(null)
    } finally {
      stub.stop()
    }
  })

  test('hub restart declines a hub slay does not manage', async () => {
    // Hub A was spawned directly: there is no unit to restart, so the CLI must
    // decline rather than pretend it restarted something.
    const res = slay(['hub', 'restart', NAME_A], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `explained why: ${res.stderr}`).toMatch(/not managed by slay/i)
  })

  test('hub start resolves the hub bin locally, without a network fetch', async () => {
    // REGRESSION: `hub start` used to shell out to `npx --package @slayzone/hub
    // node -p require.resolve(...)`, which ALWAYS failed — npx puts the package's
    // BIN on PATH but does not add its cache to Node's module resolution paths.
    // In the monorepo the plain resolver misses too (the CLI does not depend on
    // the hub package), so `hub start` was broken everywhere with
    // `Cannot find module '@slayzone/hub/package.json'`.
    //
    // Cannot assert by actually starting a hub — that registers a launchd/systemd
    // unit, which a test must never do. Instead invoke the resolver directly via
    // the built bundle, so a resolution regression fails here regardless of the
    // command's other pre-flight checks (which run BEFORE resolution and would
    // otherwise mask it).
    const probe = `
      const { execFileSync } = require('node:child_process');
      const { existsSync, readFileSync } = require('node:fs');
      const { dirname, join } = require('node:path');
      // Mirror resolveHubBin's local branches (1) and (2).
      const self = ${JSON.stringify(CLI_BIN)};
      let found = null;
      try { found = require.resolve('@slayzone/hub/package.json'); } catch {}
      if (!found) {
        const sib = join(dirname(self), '..', '..', 'hub', 'package.json');
        if (existsSync(sib)) found = sib;
      }
      if (!found) { console.log('UNRESOLVED'); process.exit(0); }
      const pkg = JSON.parse(readFileSync(found, 'utf8'));
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['slayzone-hub'];
      const bin = join(dirname(found), rel);
      console.log(existsSync(bin) ? 'RESOLVED ' + pkg.version : 'BIN_MISSING ' + bin);
    `
    const res = spawnSync(NODE_BIN, ['-e', probe], {
      encoding: 'utf8',
      cwd: CLI_DIR,
      timeout: 30_000
    })
    expect(res.status, `probe ran (stderr: ${res.stderr})`).toBe(0)
    expect(
      res.stdout.startsWith('RESOLVED'),
      `hub bin resolved from the local tree, no fetch needed: ${res.stdout.trim()}`
    ).toBe(true)
    // And the command itself must not blow up on the resolver: an occupied root
    // is refused AFTER resolution succeeds, so no module error may appear.
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const create = slay(['hub', 'create', `${NAME_PREFIX}dup`, '--root', a.root], {
      root: rootA
    })
    const combined = create.stdout + create.stderr
    expect(create.status, 'refused — that root already has a hub').not.toBe(0)
    expect(combined, `no resolver failure surfaced: ${combined}`).not.toMatch(
      /Cannot find module|Could not (fetch|install|locate)/i
    )
  })

  test('create refuses a name that already exists, running or not', async () => {
    // The point of a REQUIRED, unique name: it is how every other command
    // addresses a hub. Two hubs sharing one would make `stop`/`logs`/`--hub`
    // ambiguous. The running case is checked here; the registered-but-STOPPED
    // case is what the unit-file probe in `create` adds (a running-only check
    // would silently overwrite a stopped hub's unit).
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const otherRoot = join(TMP, 'another-root')
    mkdirSync(otherRoot, { recursive: true })
    const res = slay(['hub', 'create', basename(a.root), '--root', otherRoot], { root: rootA })
    expect(res.status, 'refused a duplicate name').not.toBe(0)
    expect(res.stderr, `explained the clash: ${res.stderr}`).toMatch(/already (exists|running)/i)
  })

  test('create requires a name — no silent dirname default', async () => {
    const res = slay(['hub', 'create'], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `commander demanded the name: ${res.stderr}`).toMatch(
      /missing required argument/i
    )
  })

  // --- reachable hub setup ------------------------------------------------
  //
  // A hub with no public address mints `ws://127.0.0.1:<port>/computers` tokens, which
  // no other machine can use — and mint SUCCEEDS, so the failure is silent.
  // `--public-address` is what makes a reachable deployment. A hub other machines can
  // reach is refused at boot without login and without SLAYZONE_HUB_AUTH_SECRET in its
  // environment, so `create` writes the shape to hub.config.json and demands the
  // secret from the caller.
  //
  // None of these cases may leave a REAL reachable hub running: the hub they launch is
  // a stub that exits at once (EXITING_HUB), so `create` gives up as soon as it is
  // gone and nothing ever listens. hub.config.json is written BEFORE launch, so the
  // boot outcome is irrelevant to what is asserted.
  const SECRET = { SLAYZONE_HUB_AUTH_SECRET: 'test-only-secret-not-used-anywhere-else' }
  const EXITING_HUB = (): Record<string, string> => {
    const bin = join(TMP, 'exiting-hub-bin.js')
    if (!existsSync(bin)) writeFileSync(bin, 'process.exit(1)\n')
    return { SLZ_FORCE_NO_SERVICE: '1', SLZ_HUB_BIN: bin }
  }

  test('create --public-address persists the reachable shape to hub.config.json', async () => {
    const remoteRoot = join(TMP, 'remote-cfg')
    mkdirSync(remoteRoot, { recursive: true })
    const created = slay(
      [
        'hub',
        'create',
        `${NAME_PREFIX}remote`,
        '--root',
        remoteRoot,
        '--public-address',
        'hub.example.com:8443',
        '--bind',
        '127.0.0.1:51989'
      ],
      { root: remoteRoot, env: { ...EXITING_HUB(), ...SECRET } }
    )
    const cfg = JSON.parse(readFileSync(join(remoteRoot, 'hub.config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    // login is the lever: a hub other machines can reach is refused at boot without it.
    expect(cfg.requireLogin, 'login required persisted').toBe(true)
    expect(cfg.publicAddress, 'public address persisted').toBe('hub.example.com:8443')
    expect(cfg.listenAddress, 'explicit --bind persisted verbatim').toBe('127.0.0.1:51989')
    for (const retired of ['mode', 'address', 'port', 'publicUrl']) {
      expect(cfg, `no retired key '${retired}' written`).not.toHaveProperty([retired])
    }
    // The secret is env only: it is never written into the config file.
    expect(JSON.stringify(cfg), 'the auth secret is not in hub.config.json').not.toContain(
      SECRET.SLAYZONE_HUB_AUTH_SECRET
    )
    // A reachable hub keeps no owner file (T-11): the way in is the derived password.
    expect(created.stdout, `says how to sign in as the first admin: ${created.stdout}`).toContain(
      `slay hub owner-password ${NAME_PREFIX}remote | slay hub login`
    )
  })

  test('owner-password prints the derived owner password, and only it, on stdout', async () => {
    const res = slay(['hub', 'owner-password'], { env: SECRET })
    expect(res.status, `exit (${res.stderr})`).toBe(0)
    expect(res.stdout, 'stdout is the password alone, ready to pipe into `slay hub login`').toBe(
      `${deriveBootstrapOwnerPassword(SECRET.SLAYZONE_HUB_AUTH_SECRET)}\n`
    )
    const none = slay(['hub', 'owner-password'], { env: { SLZ_FORCE_NO_SERVICE: '1' } })
    expect(none.status, 'no secret → refused').not.toBe(0)
    expect(none.stderr, `names the variable: ${none.stderr}`).toMatch(/SLAYZONE_HUB_AUTH_SECRET/)
    expect(none.stdout, 'prints nothing to pipe').toBe('')
  })

  test('create --public-address REFUSES without SLAYZONE_HUB_AUTH_SECRET, writing nothing', async () => {
    const noSecretRoot = join(TMP, 'remote-nosecret')
    mkdirSync(noSecretRoot, { recursive: true })
    const res = slay(
      [
        'hub',
        'create',
        `${NAME_PREFIX}nosecret`,
        '--root',
        noSecretRoot,
        '--public-address',
        'hub.example.com:8443',
        '--bind',
        '127.0.0.1:51989'
      ],
      { root: noSecretRoot, env: EXITING_HUB() }
    )
    expect(res.status, 'refused').not.toBe(0)
    expect(res.stderr, `names the variable: ${res.stderr}`).toMatch(/SLAYZONE_HUB_AUTH_SECRET/)
    expect(res.stderr, `says how to provide one: ${res.stderr}`).toMatch(/openssl rand/)
    // An existing hub already has sessions and enrolled computers keyed to its secret;
    // "generate a new one" would sign them all out, so the message must lead them to
    // the existing value first.
    expect(
      res.stderr,
      `says to reuse the existing secret of an existing hub: ${res.stderr}`
    ).toMatch(/computerTransportSecret/)
    expect(
      res.stderr,
      `says to reuse the existing secret of an existing hub: ${res.stderr}`
    ).toMatch(/hub\.state\.json/)
    expect(res.stderr, `limits generating to a new hub: ${res.stderr}`).toMatch(/New hub/)
    expect(
      existsSync(join(noSecretRoot, 'hub.config.json')),
      'failing fast wrote no half-configured hub root'
    ).toBe(false)
  })

  test('create --public-address REFUSES without --bind, writing nothing', async () => {
    const noBindRoot = join(TMP, 'remote-nobind')
    mkdirSync(noBindRoot, { recursive: true })
    // The hub serves plain http, so a public address must not silently widen it to
    // every interface. SECRET is set so the only thing wrong is the missing --bind.
    for (const extra of [[], ['--port', '51987']]) {
      const res = slay(
        [
          'hub',
          'create',
          `${NAME_PREFIX}nobind`,
          '--root',
          noBindRoot,
          '--public-address',
          'hub.example.com:8443',
          ...extra
        ],
        { root: noBindRoot, env: { SLZ_FORCE_NO_SERVICE: '1', ...SECRET } }
      )
      const label = extra.length > 0 ? 'with --port' : 'bare'
      expect(res.status, `${label}: refused`).not.toBe(0)
      expect(res.stderr, `${label}: names both options: ${res.stderr}`).toMatch(/--public-address/)
      expect(res.stderr, `${label}: names both options: ${res.stderr}`).toMatch(/--bind/)
      expect(res.stderr, `${label}: says why: ${res.stderr}`).toMatch(/plain http/)
      expect(
        existsSync(join(noBindRoot, 'hub.config.json')),
        `${label}: failing fast wrote no hub.config.json`
      ).toBe(false)
    }
  })

  test('create --public-address with an explicit wildcard --bind persists it as given', async () => {
    const wideRoot = join(TMP, 'remote-wide')
    mkdirSync(wideRoot, { recursive: true })
    // The stub hub never listens, so this leaves no hub on every interface.
    slay(
      [
        'hub',
        'create',
        `${NAME_PREFIX}wide`,
        '--root',
        wideRoot,
        '--public-address',
        'hub.example.com:8443',
        '--bind',
        '0.0.0.0:51987'
      ],
      { root: wideRoot, env: { ...EXITING_HUB(), ...SECRET } }
    )
    const cfg = JSON.parse(readFileSync(join(wideRoot, 'hub.config.json'), 'utf8')) as Record<
      string,
      unknown
    >
    // Still possible — but only because the operator said so.
    expect(cfg.listenAddress, 'the explicit bind, verbatim').toBe('0.0.0.0:51987')
  })

  test('create tells the operator to make the first account on a reachable hub', async () => {
    const acctRoot = join(TMP, 'remote-acct')
    mkdirSync(acctRoot, { recursive: true })
    const res = slay(
      [
        'hub',
        'create',
        `${NAME_PREFIX}acct`,
        '--root',
        acctRoot,
        '--public-address',
        'hub.example.com:8443',
        '--bind',
        '127.0.0.1:51989'
      ],
      { root: acctRoot, env: { ...EXITING_HUB(), ...SECRET } }
    )
    // A hub that requires login AND closes public signup with no account is
    // permanently unauthenticatable. This instruction is the difference between a
    // working deployment and a dead one, so it must be unconditional.
    const out = res.stdout + res.stderr
    expect(out, `names the account step: ${out}`).toMatch(/hub users add/)
    expect(out, `states that login is required: ${out}`).toMatch(/login required/i)
    // Join tokens point at the public address, https/wss because the host is not
    // loopback — the scheme comes from the host, not from a mode.
    expect(out, `says where tokens will point: ${out}`).toContain(
      'wss://hub.example.com:8443/computers'
    )
    expect(out, `login hint uses https for a public host: ${out}`).toContain(
      'slay hub login https://hub.example.com:8443'
    )
    expect(out, `says the hub itself serves plain http: ${out}`).toMatch(/TLS front end/)
  })

  test('create rejects a public address carrying a scheme or path', async () => {
    const badRoot = join(TMP, 'remote-bad')
    mkdirSync(badRoot, { recursive: true })
    for (const bad of ['https://hub.example.com', 'hub.example.com/trpc']) {
      const res = slay(
        ['hub', 'create', `${NAME_PREFIX}bad`, '--root', badRoot, '--public-address', bad],
        { root: badRoot, env: { SLZ_FORCE_NO_SERVICE: '1' } }
      )
      expect(res.status, `refused ${bad}`).not.toBe(0)
      expect(res.stderr, `explains the grammar: ${res.stderr}`).toMatch(/host\[:port\]/)
      // Failing fast means nothing was written — no half-configured hub root.
      expect(
        existsSync(join(badRoot, 'hub.config.json')),
        `no hub.config.json written for ${bad}`
      ).toBe(false)
    }
  })

  test('create refuses an off-loopback --bind without --public-address, writing nothing', async () => {
    const openRoot = join(TMP, 'remote-open')
    mkdirSync(openRoot, { recursive: true })
    const res = slay(
      ['hub', 'create', `${NAME_PREFIX}open`, '--root', openRoot, '--bind', '0.0.0.0:51988'],
      { root: openRoot, env: { SLZ_FORCE_NO_SERVICE: '1' } }
    )
    expect(res.status, 'refused').not.toBe(0)
    expect(res.stderr, `names the missing flag: ${res.stderr}`).toMatch(/--public-address/)
    expect(res.stderr, `says why: ${res.stderr}`).toMatch(/refuse to boot/)
    expect(existsSync(join(openRoot, 'hub.config.json')), 'nothing written').toBe(false)
  })

  test('create accepts a loopback --bind with no public address', async () => {
    // The refusal above must not catch the ordinary local shape. The stub hub exits at
    // once, so `create` fails — exit status is not the point; the absence of the
    // off-loopback refusal is.
    const loopRoot = join(TMP, 'remote-loop')
    mkdirSync(loopRoot, { recursive: true })
    const res = slay(
      ['hub', 'create', `${NAME_PREFIX}loop`, '--root', loopRoot, '--bind', '127.0.0.1:51989'],
      { root: loopRoot, env: EXITING_HUB() }
    )
    expect(res.stderr, `not asked for a public address: ${res.stderr}`).not.toMatch(
      /--public-address/
    )
  })

  test('create refuses an OS-assigned --bind port, writing nothing', async () => {
    // `slay hub` finds a hub by its port (or by name over the hub block), and a port
    // the OS assigns is neither known nor stable across restarts: such a `create`
    // could only wait out its deadline and tear the hub down again.
    const zeroRoot = join(TMP, 'remote-zero')
    mkdirSync(zeroRoot, { recursive: true })
    const started = Date.now()
    const res = slay(
      ['hub', 'create', `${NAME_PREFIX}zero`, '--root', zeroRoot, '--bind', '127.0.0.1:0'],
      { root: zeroRoot, env: { SLZ_FORCE_NO_SERVICE: '1' } }
    )
    expect(Date.now() - started, 'refused before launching anything').toBeLessThan(10_000)
    expect(res.status, 'refused').not.toBe(0)
    expect(res.stderr, `says why: ${res.stderr}`).toMatch(/port 0/)
    expect(res.stderr, `names the fix: ${res.stderr}`).toMatch(/--bind 127\.0\.0\.1:<port>/)
    expect(existsSync(join(zeroRoot, 'hub.config.json')), 'nothing written').toBe(false)
  })

  test('create refuses a --bind and --port that disagree', async () => {
    const clashRoot = join(TMP, 'remote-clash')
    mkdirSync(clashRoot, { recursive: true })
    const res = slay(
      [
        'hub',
        'create',
        `${NAME_PREFIX}clash`,
        '--root',
        clashRoot,
        '--bind',
        '0.0.0.0:51001',
        '--port',
        '51002'
      ],
      { root: clashRoot, env: { SLZ_FORCE_NO_SERVICE: '1' } }
    )
    expect(res.status, 'refused two answers for one port').not.toBe(0)
    expect(res.stderr, `says why: ${res.stderr}`).toMatch(/disagree/)
  })

  test('start on an unknown name points at create', async () => {
    // Without a user service manager (Linux with no systemd user bus — CI containers)
    // nothing is ever registered, so `start` explains that instead of "No hub named".
    // Both branches must point at `create`. The no-manager one is forced here so it
    // is covered on every platform; the natural one is whatever this machine has.
    const forced = slay(['hub', 'start', `${NAME_PREFIX}ghost`], {
      root: rootA,
      env: { SLZ_FORCE_NO_SERVICE: '1' }
    })
    expect(forced.status, 'non-zero exit (no service manager)').not.toBe(0)
    expect(forced.stderr, `said why: ${forced.stderr}`).toMatch(/no user service manager/i)
    expect(forced.stderr, `pointed at create: ${forced.stderr}`).toMatch(/hub create/i)

    const res = slay(['hub', 'start', `${NAME_PREFIX}ghost`], { root: rootA })
    const expected = detectBackend() === 'none' ? /no user service manager/i : /No hub named/i
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `said it does not exist: ${res.stderr}`).toMatch(expected)
    expect(res.stderr, `pointed at create: ${res.stderr}`).toMatch(/hub create/i)
  })

  test('start on a RUNNING hub is a no-op, never a restart', async () => {
    // A restart would drop connected computers and pty sessions. Someone typing
    // `start` on a running hub means "make sure it is up", so the pid must not
    // change. (This is why `start` is not an alias for `restart`.)
    const a = hubs.find((h) => basename(h.root) === NAME_A)!
    const before = lsJson(rootA).find((h) => h.port === a.port)
    const res = slay(['hub', 'start', basename(a.root)], { root: rootA })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    expect(res.stdout, `said so: ${res.stdout}`).toMatch(/already running/i)
    const after = lsJson(rootA).find((h) => h.port === a.port)
    expect(before?.pid, 'hub was running beforehand').not.toBe(undefined)
    expect(after?.pid, 'same pid — the hub was NOT bounced').toBe(before?.pid)
  })

  test('the hub bin is matched to an interpreter that can actually run it', async () => {
    // REGRESSION (found running `hub start` for real): the dev-tree hub bundle's
    // better-sqlite3 is compiled for ELECTRON's ABI (NODE_MODULE_VERSION 149), so
    // the unit launched it with plain node (137) and it died instantly on
    // `require('better-sqlite3')` — which under a supervisor is an invisible
    // crash-loop.
    //
    // Asserts the pairing directly: a dev-tree bundle must be paired with the
    // Electron interpreter + ELECTRON_RUN_AS_NODE, never bare node. Cannot go
    // through `hub start` here — that would register a real launchd/systemd unit.
    const probe = `
      const { existsSync, readFileSync } = require('node:fs');
      const { dirname, join } = require('node:path');
      // Mirror interpreterFor(): walk up from the bundle looking for electron.
      let dir = dirname(${JSON.stringify(HUB_BIN)});
      let electron = null;
      for (let i = 0; i < 6 && !electron; i++) {
        const pathTxt = join(dir, 'node_modules', 'electron', 'path.txt');
        if (existsSync(pathTxt)) {
          const cand = join(dir, 'node_modules', 'electron', 'dist',
            readFileSync(pathTxt, 'utf8').trim());
          if (existsSync(cand)) electron = cand;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      console.log(electron ? 'ELECTRON ' + electron : 'PLAIN_NODE');
    `
    const res = spawnSync(NODE_BIN, ['-e', probe], { encoding: 'utf8', timeout: 30_000 })
    expect(res.status, `probe ran (stderr: ${res.stderr})`).toBe(0)
    expect(
      res.stdout.startsWith('ELECTRON'),
      `dev-tree hub paired with Electron, not bare node: ${res.stdout.trim()}`
    ).toBe(true)
    // And that is exactly how this suite boots its own hubs — the hubs listed
    // above are live proof the pairing works, since a mismatched ABI could not
    // have opened its database at all.
    expect(
      lsJson(rootA).length,
      'a hub booted under that interpreter is running'
    ).toBeGreaterThanOrEqual(1)
  })

  test('a hub that fails to boot reports the actual error, not silence', async () => {
    // REGRESSION: when the hub crash-looped (the ABI mismatch above), `hub create`
    // waited 20s and printed nothing useful — the operator saw an apparently
    // hung command and had to go find a log file themselves.
    //
    // SLZ_FORCE_NO_SERVICE takes the unsupervised branch so NOTHING is registered
    // with launchd/systemd; SLZ_HUB_BIN points at a bundle that exits at once,
    // reproducing "spawned, never answers /health".
    const brokenRoot = join(TMP, 'broken-hub')
    mkdirSync(brokenRoot, { recursive: true })
    const brokenBin = join(TMP, 'broken-hub-bin.js')
    writeFileSync(
      brokenBin,
      'console.error("simulated hub crash: cannot load native module"); process.exit(1);\n'
    )
    const started = Date.now()
    const res = slay(['hub', 'create', `${NAME_PREFIX}broken`, '--root', brokenRoot], {
      root: rootA,
      env: { SLZ_FORCE_NO_SERVICE: '1', SLZ_HUB_BIN: brokenBin }
    })
    // A hub that is already gone cannot come up: `create` says so at once instead of
    // polling /health until its 20s deadline.
    expect(Date.now() - started, 'gave up as soon as the hub exited').toBeLessThan(10_000)
    expect(res.status, `failed loudly (stdout: ${res.stdout})`).not.toBe(0)
    const combined = res.stdout + res.stderr
    expect(combined, `said it did not start: ${combined}`).toMatch(/did not come up/i)
    // The crux: the crash output is surfaced inline.
    expect(combined, `surfaced the child's own error: ${combined}`).toMatch(/simulated hub crash/)
  })

  test('rm on a name that is neither running nor registered says so', async () => {
    // The other half of rm's contract; the registered-but-stopped path (the
    // regression) is covered in platform/src/service-unit.test.ts, which can point
    // the unit dir at a temp path — the CLI always reads the real one.
    const res = slay(['hub', 'rm', `${NAME_PREFIX}never-existed`], { root: rootA })
    expect(res.status, 'non-zero exit').not.toBe(0)
    expect(res.stderr, `clear message: ${res.stderr}`).toMatch(/No hub named or listening on/)
  })

  test('registered reports no units — nothing here installed a service', async () => {
    // Proves the suite left no launchd/systemd unit behind, which is the thing
    // that must never be a test side effect.
    const res = slay(['hub', 'registered'], { root: rootA })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    expect(res.stdout, `no unit for any test hub: ${res.stdout}`).not.toContain(NAME_PREFIX)
  })

  test('every store stayed inside the sandbox', async () => {
    for (const h of lsJson(rootA)) {
      expect(typeof h.root, `hub root inside the sandbox: ${String(h.root)}`).toBe('string')
      expect(
        (h.root as string).startsWith(TMP),
        `hub root inside the sandbox: ${String(h.root)}`
      ).toBe(true)
      expect(typeof h.dbPath, `db inside the sandbox: ${String(h.dbPath)}`).toBe('string')
      expect(
        (h.dbPath as string).startsWith(TMP),
        `db inside the sandbox: ${String(h.dbPath)}`
      ).toBe(true)
    }
  })

  // Runs AFTER teardown, so a survivor here is genuinely stranded — not merely
  // still-running mid-suite.
  //
  // `hub create` starts the hub DETACHED. A case that only asserts on the
  // hub.config.json/stdout `create` produced still leaves a live hub, and one bound
  // to an OS-assigned port is undiscoverable — so `hub stop <name>` cannot reach
  // it and the loop above never sees it. That stranded ~3 hubs per run; 25 were
  // found alive on one machine, the oldest four days old.
  //
  // Scoped to THIS process's name prefix, so a developer's or CI's real hubs —
  // and strays from an earlier run — are never even inspected.
  test('the suite strands no hub process', async () => {
    for (const h of hubs) await h.stop()
    const strays: string[] = []
    const pgrep = spawnSync('pgrep', ['-f', 'hub/dist/bin\\.cjs'], { encoding: 'utf8' })
    for (const line of (pgrep.stdout ?? '').split('\n')) {
      const pid = Number.parseInt(line.trim(), 10)
      if (!Number.isInteger(pid) || pid <= 0) continue
      const env = spawnSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
      const name = /\sSLAYZONE_HUB_NAME=(\S+)/.exec(env)?.[1]
      if (name?.startsWith(NAME_PREFIX)) strays.push(`${name} (pid ${pid})`)
    }
    expect(strays.join(', '), 'no hub outlived the case that created it').toBe('')
  })
})

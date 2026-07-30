/**
 * `slay hub` end-to-end against REAL hubs
 * (plans/hub-lifecycle-and-discovery.md, Phase 6).
 *
 * Drives the BUILT `slay` bundle against actual hub processes: two hubs in two
 * throwaway roots, then `hub ls` → `--hub` targeting → `hub stop`. The library
 * pieces are unit-tested elsewhere (platform/src/hub-discovery + hub-service);
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
 * platform/src/hub-service.test.ts; the register-and-start path is a documented
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
 * hubs run under `ELECTRON_RUN_AS_NODE=1 electron` (run_test_electron_strict_loader
 * in run-all.sh). The CLI bundle is plain node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/cli/src/commands/hub-lifecycle.test.ts
 */
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
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// Package roots are derived from the REPO root rather than this file's own URL:
// the CLI package typechecks as CommonJS (see its tsconfig `module`), where
// `import.meta` is a compile error, even though the suite is executed as ESM.
// Anchored on cwd, which run-all.sh invokes from the repo root.
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
 * `process.env.NODE` is set by some runners; otherwise fall back to PATH lookup,
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
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

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
 * SLAYZONE_HUB_ADDRESS) — that is the path `hub start` uses and the only one the
 * discovery sweep can find. The chosen port is read back from its boot line.
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
      SLAYZONE_HUB_NAME: name
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
      () => reject(new Error(`hub "${name}" printed no listening line in 40s:\n${logs.join('\n')}`)),
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
 * `hub ls --json`, narrowed to THIS test's hubs by name prefix. The sweep also
 * finds a developer's or CI's real hubs — filtering keeps them out of every
 * assertion (and out of anything this test would ever stop).
 */
function lsJson(root: string): Array<Record<string, unknown>> {
  const res = slay(['hub', 'ls', '--json'], { root })
  assertEq(res.status, 0, `hub ls exited 0 (stderr: ${res.stderr})`)
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
        pid: process.pid, mode: 'local', supervised: true, runnersConnected: 1,
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

async function main(): Promise<void> {
  console.log('\nslay hub — end-to-end against real hubs\n')

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

  try {
    // Every `slay` call below runs with SLAYZONE_ROOT pointed at a hub root, which
    // contains NO app database — so any command that hard-requires one fails here.
    // That is the hub-only-machine condition, held for the whole suite rather than
    // checked once.
    const rootA = join(TMP, NAME_A)

    await test('hub ls works with NO SlayZone database (hub-only machine)', async () => {
      const empty = join(TMP, 'no-db-at-all')
      mkdirSync(empty, { recursive: true })
      const res = slay(['hub', 'ls'], { root: empty })
      // getServerPort() → openDb() calls process.exit(1) when the DB file is
      // absent, which a try/catch CANNOT intercept — so this pins the file-probe
      // guard specifically, not just that the command "usually works".
      assertEq(res.status, 0, `exited 0 (stdout: ${res.stdout} stderr: ${res.stderr})`)
      assert(
        !/Database not found/i.test(res.stderr + res.stdout),
        `did not demand a database: ${res.stderr}${res.stdout}`
      )
    })

    await test('two hubs boot in separate roots, each taking a free hub-block port', async () => {
      const a = await startHub(NAME_A)
      const b = await startHub(NAME_B)
      assert(a.port !== b.port, `distinct ports (${a.port} vs ${b.port})`)
      for (const h of [a, b]) {
        assert(
          h.port >= 51110 && h.port <= 51199,
          `port ${h.port} inside the dynamic hub range (discovery only sweeps the block)`
        )
      }
    })

    await test('ls finds both hubs and reports name, root, pid and port', async () => {
      const listed = lsJson(rootA)
      assertEq(listed.length, 2, `both listed (got ${JSON.stringify(listed.map((h) => h.name))})`)
      for (const h of listed) {
        const live = hubs.find((x) => x.port === h.port)
        assert(live !== undefined, `row ${String(h.name)} matches a spawned hub`)
        assertEq(h.name, basename(live.root), 'name follows SLAYZONE_HUB_NAME')
        assertEq(h.root, live.root, 'root matches')
        assertEq(h.pid, live.proc.pid, 'pid is the real hub process')
        assertEq(h.supervised, false, 'a standalone hub is not flagged supervised')
      }
    })

    await test('ls prints a table naming both hubs', async () => {
      const res = slay(['hub', 'ls'], { root: rootA })
      assertEq(res.status, 0, 'exited 0')
      assert(/NAME\s+PORT\s+PID/.test(res.stdout), `has a header: ${res.stdout}`)
      assert(res.stdout.includes(NAME_A), 'lists hub A')
      assert(res.stdout.includes(NAME_B), 'lists hub B')
    })

    await test('--hub <port> routes to that hub', async () => {
      const b = hubs.find((h) => basename(h.root) === NAME_B)!
      // `hub current` echoes the resolved target, so it proves WHICH hub was hit.
      const res = slay(['--hub', String(b.port), 'hub', 'current'], { root: rootA })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      assert(res.stdout.includes(String(b.port)), `targeted hub B: ${res.stdout}`)
      assert(/Health: ok/.test(res.stdout), `probed healthy: ${res.stdout}`)
    })

    await test('--hub <name> resolves through the sweep to the right port', async () => {
      const b = hubs.find((h) => basename(h.root) === NAME_B)!
      const res = slay(['--hub', NAME_B, 'hub', 'current'], { root: rootA })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      assert(res.stdout.includes(String(b.port)), `name → hub B's port: ${res.stdout}`)
    })

    await test('--hub with an unknown name fails loudly and lists what IS running', async () => {
      const res = slay(['--hub', `${NAME_PREFIX}nope`, 'hub', 'current'], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(/No hub named or listening on/.test(res.stderr), `named the problem: ${res.stderr}`)
      assert(/Running hubs:/.test(res.stderr), `listed the alternatives: ${res.stderr}`)
    })

    await test('hub stop terminates an unregistered hub via SIGTERM, and discloses it', async () => {
      const b = hubs.find((h) => basename(h.root) === NAME_B)!
      const res = slay(['hub', 'stop', NAME_B], { root: rootA })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      // The hub was spawned directly, so there is no service unit — the CLI must
      // fall back to signalling the pid AND say that is what it did.
      assert(/not registered by slay/i.test(res.stdout), `disclosed the fallback: ${res.stdout}`)
      const deadline = Date.now() + 15_000
      while (b.proc.exitCode === null && b.proc.signalCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
      }
      assert(b.proc.exitCode !== null || b.proc.signalCode !== null, 'hub process actually ended')
      const listed = lsJson(rootA)
      assertEq(listed.length, 1, 'only hub A remains listed')
      assertEq(listed[0]?.name, NAME_A, 'and it is the one we did not stop')
    })

    await test('hub stop on an already-gone hub fails loudly', async () => {
      const res = slay(['hub', 'stop', NAME_B], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(/No hub named or listening on/.test(res.stderr), `clear message: ${res.stderr}`)
    })

    await test('hub stop REFUSES the desktop app’s supervised hub', async () => {
      // The app owns its sidecar's lifecycle: stopping it from here breaks a running
      // app while leaving it convinced its backend is alive. Booting a real
      // supervised hub needs the Electron host, so the refusal is driven through a
      // stub /health reporting supervised:true — the same field discovery reads.
      const stub = await startSupervisedStub()
      try {
        const res = slay(['hub', 'stop', String(stub.port)], { root: rootA })
        assert(res.status !== 0, `refused with a non-zero exit (stdout: ${res.stdout})`)
        assert(/desktop app/i.test(res.stderr), `explained who owns it: ${res.stderr}`)
        // Still answering ⇒ the refusal happened BEFORE any signal. If the guard
        // regressed, the CLI would have killed the stub and this fails.
        assertEq(stub.proc.exitCode, null, 'stub process was never signalled')
        const health = await fetch(`http://127.0.0.1:${stub.port}/health`, {
          signal: AbortSignal.timeout(3000)
        })
        assertEq(health.ok, true, 'stub still serving /health')
      } finally {
        stub.stop()
      }
    })

    await test('hub restart REFUSES the supervised hub too', async () => {
      const stub = await startSupervisedStub()
      try {
        const res = slay(['hub', 'restart', String(stub.port)], { root: rootA })
        assert(res.status !== 0, `refused with a non-zero exit (stdout: ${res.stdout})`)
        assert(/desktop app/i.test(res.stderr), `same refusal as stop: ${res.stderr}`)
        assertEq(stub.proc.exitCode, null, 'stub never signalled')
      } finally {
        stub.stop()
      }
    })

    await test('hub restart declines a hub slay does not manage', async () => {
      // Hub A was spawned directly: there is no unit to restart, so the CLI must
      // decline rather than pretend it restarted something.
      const res = slay(['hub', 'restart', NAME_A], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(/not managed by slay/i.test(res.stderr), `explained why: ${res.stderr}`)
    })

    await test('hub start resolves the hub bin locally, without a network fetch', async () => {
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
      assertEq(res.status, 0, `probe ran (stderr: ${res.stderr})`)
      assert(
        res.stdout.startsWith('RESOLVED'),
        `hub bin resolved from the local tree, no fetch needed: ${res.stdout.trim()}`
      )
      // And the command itself must not blow up on the resolver: an occupied root
      // is refused AFTER resolution succeeds, so no module error may appear.
      const a = hubs.find((h) => basename(h.root) === NAME_A)!
      const create = slay(['hub', 'create', `${NAME_PREFIX}dup`, '--root', a.root], {
        root: rootA
      })
      const combined = create.stdout + create.stderr
      assert(create.status !== 0, 'refused — that root already has a hub')
      assert(
        !/Cannot find module|Could not (fetch|install|locate)/i.test(combined),
        `no resolver failure surfaced: ${combined}`
      )
    })

    await test('create refuses a name that already exists, running or not', async () => {
      // The point of a REQUIRED, unique name: it is how every other command
      // addresses a hub. Two hubs sharing one would make `stop`/`logs`/`--hub`
      // ambiguous. The running case is checked here; the registered-but-STOPPED
      // case is what the unit-file probe in `create` adds (a running-only check
      // would silently overwrite a stopped hub's unit).
      const a = hubs.find((h) => basename(h.root) === NAME_A)!
      const otherRoot = join(TMP, 'another-root')
      mkdirSync(otherRoot, { recursive: true })
      const res = slay(['hub', 'create', basename(a.root), '--root', otherRoot], { root: rootA })
      assert(res.status !== 0, 'refused a duplicate name')
      assert(
        /already (exists|running)/i.test(res.stderr),
        `explained the clash: ${res.stderr}`
      )
    })

    await test('create requires a name — no silent dirname default', async () => {
      const res = slay(['hub', 'create'], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(
        /missing required argument/i.test(res.stderr),
        `commander demanded the name: ${res.stderr}`
      )
    })

    await test('start on an unknown name points at create', async () => {
      const res = slay(['hub', 'start', `${NAME_PREFIX}ghost`], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(/No hub named/i.test(res.stderr), `said it does not exist: ${res.stderr}`)
      assert(/hub create/i.test(res.stderr), `pointed at create: ${res.stderr}`)
    })

    await test('start on a RUNNING hub is a no-op, never a restart', async () => {
      // A restart would drop connected runners and pty sessions. Someone typing
      // `start` on a running hub means "make sure it is up", so the pid must not
      // change. (This is why `start` is not an alias for `restart`.)
      const a = hubs.find((h) => basename(h.root) === NAME_A)!
      const before = lsJson(rootA).find((h) => h.port === a.port)
      const res = slay(['hub', 'start', basename(a.root)], { root: rootA })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      assert(/already running/i.test(res.stdout), `said so: ${res.stdout}`)
      const after = lsJson(rootA).find((h) => h.port === a.port)
      assert(before?.pid !== undefined, 'hub was running beforehand')
      assertEq(after?.pid, before?.pid, 'same pid — the hub was NOT bounced')
    })

    await test('the hub bin is matched to an interpreter that can actually run it', async () => {
      // REGRESSION (found running `hub start` for real): the dev-tree hub bundle's
      // better-sqlite3 is compiled for ELECTRON's ABI (NODE_MODULE_VERSION 145), so
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
      assertEq(res.status, 0, `probe ran (stderr: ${res.stderr})`)
      assert(
        res.stdout.startsWith('ELECTRON'),
        `dev-tree hub paired with Electron, not bare node: ${res.stdout.trim()}`
      )
      // And that is exactly how this suite boots its own hubs — the hubs listed
      // above are live proof the pairing works, since a mismatched ABI could not
      // have opened its database at all.
      assert(lsJson(rootA).length >= 1, 'a hub booted under that interpreter is running')
    })

    await test('a hub that fails to boot reports the actual error, not silence', async () => {
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
      const res = slay(['hub', 'create', `${NAME_PREFIX}broken`, '--root', brokenRoot], {
        root: rootA,
        env: { SLZ_FORCE_NO_SERVICE: '1', SLZ_HUB_BIN: brokenBin }
      })
      assert(res.status !== 0, `failed loudly (stdout: ${res.stdout})`)
      const combined = res.stdout + res.stderr
      assert(/did not come up/i.test(combined), `said it did not start: ${combined}`)
      // The crux: the crash output is surfaced inline.
      assert(
        /simulated hub crash/.test(combined),
        `surfaced the child's own error: ${combined}`
      )
    })

    await test('rm on a name that is neither running nor registered says so', async () => {
      // The other half of rm's contract; the registered-but-stopped path (the
      // regression) is covered in platform/src/hub-service.test.ts, which can point
      // the unit dir at a temp path — the CLI always reads the real one.
      const res = slay(['hub', 'rm', `${NAME_PREFIX}never-existed`], { root: rootA })
      assert(res.status !== 0, 'non-zero exit')
      assert(/No hub named or listening on/.test(res.stderr), `clear message: ${res.stderr}`)
    })

    await test('registered reports no units — nothing here installed a service', async () => {
      // Proves the suite left no launchd/systemd unit behind, which is the thing
      // that must never be a test side effect.
      const res = slay(['hub', 'registered'], { root: rootA })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      assert(
        !res.stdout.includes(NAME_PREFIX),
        `no unit for any test hub: ${res.stdout}`
      )
    })

    await test('every store stayed inside the sandbox', async () => {
      for (const h of lsJson(rootA)) {
        assert(
          typeof h.root === 'string' && h.root.startsWith(TMP),
          `hub root inside the sandbox: ${String(h.root)}`
        )
        assert(
          typeof h.dbPath === 'string' && h.dbPath.startsWith(TMP),
          `db inside the sandbox: ${String(h.dbPath)}`
        )
      }
    })
  } finally {
    for (const h of hubs) await h.stop()
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()

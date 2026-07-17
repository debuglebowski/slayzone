/**
 * Side-car supervisor crash-recovery tests (slice 2.5.1 — HARD GATE).
 *
 * Covers the crash-recovery behaviours of startSidecarServer() — the most
 * logic-heavy new code in the slice 2.5 dark-launch:
 *  - /health probe drives the child to `ready`
 *  - exponential-backoff restart on repeated crash → permanent failure
 *  - a 60s healthy streak resets the backoff attempt counter
 *  - a ready child that exits respawns immediately (no backoff, no attempt++)
 *  - boot-timeout kills a child that never reports healthy
 *  - parent-death: the REAL built side-car self-exits when its stdin closes
 *
 * The supervisor logic is driven against a controllable fake side-car script
 * so backoff timing + permanent failure are deterministic and fast. Timing
 * constants are shrunk through the additive `opts.timing` override (defaults
 * unchanged in production). The parent-death case spawns the real built
 * dist/bin.cjs to exercise the side-car's own self-exit path.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm \
 *     packages/apps/app/src/main/sidecar-server-supervisor.test.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startSidecarServer,
  type SidecarServerHandle,
  type SidecarServerOpts
} from './sidecar-server-supervisor.js'

// --- tiny async test harness (matches repo style — no vitest) -------------

type TestFn = () => Promise<void>
const tests: Array<{ name: string; fn: TestFn }> = []
function test(name: string, fn: TestFn): void {
  tests.push({ name, fn })
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs: number, msg: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await delay(25)
  }
  throw new Error(`timeout after ${timeoutMs}ms: ${msg}`)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// --- fake side-car script (controllable crash / health behaviour) ---------

const FAKE_SIDECAR = `'use strict'
const http = require('node:http')
const fs = require('node:fs')

const host = process.env.SLAYZONE_HOST || '127.0.0.1'
const port = Number(process.env.SLAYZONE_PORT || '0')
const counterFile = process.env.FAKE_COUNTER_FILE || ''
const crashFirst = Number(process.env.FAKE_CRASH_FIRST || '0')
const crashAlways = process.env.FAKE_CRASH_ALWAYS === '1'
const nohealth = process.env.FAKE_NOHEALTH === '1'
const crashAfterReadyMs = Number(process.env.FAKE_CRASH_AFTER_READY_MS || '0')

let attempt = 0
if (counterFile) {
  try { attempt = Number(fs.readFileSync(counterFile, 'utf8')) || 0 } catch (e) {}
  attempt += 1
  try { fs.writeFileSync(counterFile, String(attempt)) } catch (e) {}
}

// Capture buildId ONCE at boot: explicit env wins; else read the manifest now.
// A fresh child (post-restart) picks up the current on-disk build; an old child
// keeps the build it booted with — exactly how a rebuilt bin behaves.
let bootBuildId = process.env.FAKE_BUILD_ID || ''
const manifestFile = process.env.FAKE_MANIFEST_FILE || ''
if (!bootBuildId && manifestFile) {
  try { bootBuildId = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).buildId || '' } catch (e) {}
}

function crash(why) {
  process.stderr.write('fake-sidecar crash attempt=' + attempt + ' why=' + why + '\\n')
  process.exit(1)
}

if (crashAlways) crash('crash-always')
if (crashFirst > 0 && attempt <= crashFirst) crash('crash-first')

let ready = false
const server = http.createServer(function (req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    if (ready && !nohealth) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bootBuildId ? { ok: true, buildId: bootBuildId } : { ok: true }))
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end('{"ok":false}')
    }
    return
  }
  res.writeHead(404)
  res.end()
})
server.listen(port, host, function () {
  process.stdout.write('fake-sidecar listening port=' + port + ' attempt=' + attempt + '\\n')
  if (!nohealth) {
    ready = true
    if (crashAfterReadyMs > 0 && attempt === 1) {
      setTimeout(function () { crash('crash-after-ready') }, crashAfterReadyMs)
    }
  }
})
`

// --- temp-dir + opts plumbing ---------------------------------------------

const tmpDirs: string[] = []
function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-sup-test-'))
  tmpDirs.push(dir)
  return dir
}
function writeFakeSidecar(dir: string): string {
  const p = path.join(dir, 'fake-sidecar.cjs')
  fs.writeFileSync(p, FAKE_SIDECAR)
  return p
}
/** Write the on-disk build manifest the supervisor compares the running build to. */
function writeManifest(dir: string, buildId: string): void {
  fs.writeFileSync(path.join(dir, 'sidecar-build.json'), JSON.stringify({ buildId }))
}
function cleanup(): void {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

type LogEntry = { t: number; line: string }

type HarnessCtx = {
  logs: LogEntry[]
  spawnTimes: number[]
  readyCount: number
  permanentFailure: { attempts: number; lastError: unknown } | null
  permanentFailed: ReturnType<typeof deferred<void>>
}

function makeHarness(
  dir: string,
  fakeEnv: Record<string, string>,
  timing?: SidecarServerOpts['timing'],
  extra?: Partial<SidecarServerOpts>
): { handle: SidecarServerHandle; ctx: HarnessCtx } {
  const scriptPath = writeFakeSidecar(dir)
  const ctx: HarnessCtx = {
    logs: [],
    spawnTimes: [],
    readyCount: 0,
    permanentFailure: null,
    permanentFailed: deferred<void>()
  }
  const handle = startSidecarServer({
    execPath: process.execPath,
    scriptPath,
    host: '127.0.0.1',
    env: { ...process.env, ...fakeEnv } as NodeJS.ProcessEnv,
    logger: (line) => {
      const entry = { t: Date.now(), line }
      ctx.logs.push(entry)
      if (line.includes('[supervisor] spawned ')) ctx.spawnTimes.push(entry.t)
    },
    onReady: () => {
      ctx.readyCount += 1
    },
    onPermanentFailure: (info) => {
      ctx.permanentFailure = info
      ctx.permanentFailed.resolve()
    },
    timing,
    ...extra
  })
  return { handle, ctx }
}

/** Single GET /health probe against a port. Resolves the HTTP status. */
function probe(port: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1_000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', () => resolve(0))
    req.on('timeout', () => {
      req.destroy()
      resolve(0)
    })
  })
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// --- tests ----------------------------------------------------------------

test('/health probe drives the child to ready + exposes status', async () => {
  const dir = mkTmp()
  const dbSentinel = path.join(dir, 'sentinel.sqlite')
  const { handle } = makeHarness(
    dir,
    { SLAYZONE_DB_PATH: dbSentinel },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    assertEq(handle.getHealth(), 'ready', 'health after waitForReady')
    const port = handle.getPort()
    assert(typeof port === 'number' && port > 0, 'getPort returns a bound port')

    const status = handle.getStatus()
    assertEq(status.health, 'ready', 'status.health')
    assertEq(status.port, port, 'status.port matches getPort')
    assert(typeof status.pid === 'number' && status.pid! > 0, 'status.pid set')
    assertEq(status.restarts, 0, 'status.restarts is 0 on clean start')
    assertEq(status.totalRespawns, 0, 'status.totalRespawns is 0 on clean start')
    assertEq(status.dbPath, dbSentinel, 'status.dbPath echoes SLAYZONE_DB_PATH')
    assert(typeof status.uptimeMs === 'number' && status.uptimeMs! >= 0, 'uptimeMs set')

    // The supervisor reported ready only because /health answered 200.
    assertEq(await probe(port!), 200, 'side-car /health answers 200')
  } finally {
    await handle.stop()
  }
})

test('repeated crash → exponential-backoff restart → permanent failure', async () => {
  const dir = mkTmp()
  const backoffMs = [300, 600, 1000, 1500, 2000]
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_CRASH_ALWAYS: '1' },
    { backoffMs, healthPollIntervalMs: 40 }
  )
  try {
    await Promise.race([
      ctx.permanentFailed.promise,
      delay(20_000).then(() => {
        throw new Error('permanent failure never reported')
      })
    ])

    // 1 initial spawn + 5 backoff retries = 6 spawns.
    assertEq(ctx.spawnTimes.length, 6, 'total spawn count (initial + 5 retries)')

    const gaps: number[] = []
    for (let i = 1; i < ctx.spawnTimes.length; i++) {
      gaps.push(ctx.spawnTimes[i] - ctx.spawnTimes[i - 1])
    }
    // Each gap is at least its backoff slot (minus tolerance) and the
    // sequence is strictly increasing — the signature of exponential backoff.
    for (let i = 0; i < gaps.length; i++) {
      assert(
        gaps[i] >= backoffMs[i] * 0.7,
        `gap ${i} (${gaps[i]}ms) >= backoff ${backoffMs[i]}ms * 0.7`
      )
      if (i > 0) {
        assert(gaps[i] > gaps[i - 1], `gap ${i} (${gaps[i]}ms) > gap ${i - 1} (${gaps[i - 1]}ms)`)
      }
    }

    assert(ctx.permanentFailure !== null, 'onPermanentFailure fired')
    assertEq(ctx.permanentFailure!.attempts, 5, 'permanent failure after 5 attempts')
    assertEq(handle.getHealth(), 'failed', 'health is failed')

    let rejected = false
    await handle.waitForReady().catch(() => {
      rejected = true
    })
    assert(rejected, 'waitForReady rejects after permanent failure')
  } finally {
    await handle.stop()
  }
})

test('60s healthy streak resets the backoff attempt counter', async () => {
  const dir = mkTmp()
  const counterFile = path.join(dir, 'counter')
  // Crash the first 2 spawns, then stay healthy. healthyResetMs shrunk so the
  // streak-reset is observable fast (production keeps the 60s default).
  const { handle } = makeHarness(
    dir,
    { FAKE_COUNTER_FILE: counterFile, FAKE_CRASH_FIRST: '2' },
    { backoffMs: [40, 80, 160, 320, 640], healthyResetMs: 400, healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    // 2 crashes happened before the healthy spawn — the attempt counter is non-zero.
    assertEq(handle.getStatus().restarts, 2, 'restarts reflects the 2 pre-ready crashes')

    // After a healthyResetMs streak the counter resets to 0.
    await waitFor(
      () => handle.getStatus().restarts === 0,
      3_000,
      'restarts never reset to 0 after healthy streak'
    )
    assertEq(handle.getHealth(), 'ready', 'still ready after the streak reset')
  } finally {
    await handle.stop()
  }
})

test('a ready child that exits respawns immediately — no backoff, no attempt++', async () => {
  const dir = mkTmp()
  const counterFile = path.join(dir, 'counter')
  // Attempt 1 becomes healthy then crashes ~200ms later; attempt 2 stays healthy.
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_COUNTER_FILE: counterFile, FAKE_CRASH_AFTER_READY_MS: '200' },
    { backoffMs: [5_000], healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady() // first ready
    await waitFor(() => ctx.spawnTimes.length === 2, 5_000, 'ready child never respawned')
    // Re-spawn happened far faster than the 5s backoff slot → no backoff used.
    const gap = ctx.spawnTimes[1] - ctx.spawnTimes[0]
    assert(gap < 2_000, `respawn gap ${gap}ms is well under the 5s backoff`)
    // No backoff scheduling log line was emitted.
    assert(
      !ctx.logs.some((l) => l.line.includes('restart in')),
      'no "restart in" backoff log for a ready-child exit'
    )
    await waitFor(() => handle.getHealth() === 'ready', 5_000, 'never returned to ready')
    assertEq(handle.getStatus().restarts, 0, 'restarts stayed 0 across a ready-child respawn')
    // The lifetime counter DOES move — crash e2e asserts on it since `restarts`
    // never increments on the healthy-crash immediate-respawn path.
    assertEq(handle.getStatus().totalRespawns, 1, 'totalRespawns counts the respawn')
  } finally {
    await handle.stop()
  }
})

test('boot-timeout kills a child that never reports healthy', async () => {
  const dir = mkTmp()
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_NOHEALTH: '1' },
    { backoffMs: [40, 80], healthBootTimeoutMs: 400, healthPollIntervalMs: 40 }
  )
  try {
    await Promise.race([
      ctx.permanentFailed.promise,
      delay(10_000).then(() => {
        throw new Error('boot-timeout child never escalated to permanent failure')
      })
    ])
    assert(
      ctx.logs.some((l) => l.line.includes('health timeout')),
      'supervisor logged a health-timeout kill'
    )
    assert(ctx.permanentFailure !== null, 'never-healthy child eventually fails permanently')
  } finally {
    await handle.stop()
  }
})

test('stop() is graceful and idempotent', async () => {
  const dir = mkTmp()
  const { handle, ctx } = makeHarness(dir, {}, { healthPollIntervalMs: 40 })
  try {
    await handle.waitForReady()
    const pid = handle.getStatus().pid
    assert(typeof pid === 'number' && pid! > 0, 'has a running child pid')

    await handle.stop()
    await handle.stop() // idempotent — must not throw

    // No restart fires after stop().
    const spawnsAfterStop = ctx.spawnTimes.length
    await delay(500)
    assertEq(ctx.spawnTimes.length, spawnsAfterStop, 'no respawn after stop()')
    assertEq(handle.getStatus().pid, null, 'no child pid after stop()')
  } finally {
    await handle.stop()
  }
})

test('parent-death: the real built side-car self-exits when stdin closes', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const binJs = path.resolve(here, '../../..', 'hub/dist/bin.cjs')
  if (!fs.existsSync(binJs)) {
    console.log(`  ⊘ skipped — ${binJs} not built (run pnpm build first)`)
    return
  }
  const dir = mkTmp()
  const dbPath = path.join(dir, 'parent-death.sqlite')
  // Migrate the DB before the supervised spawn. SLAYZONE_SUPERVISED=1 tells the
  // sidecar the host already owns + migrated this DB (openServerDatabase skips
  // schema bootstrap in supervised mode) — production always upholds that, since
  // the Electron host's DB worker migrates before spawning the sidecar. An
  // unmigrated DB would make the sidecar's compose-time initializers (automations
  // catchup, etc.) throw "no such table" and exit before printing "listening" — a
  // test artifact, not the parent-death behaviour under test.
  //
  // Seed by booting the SAME bin in STANDALONE mode (no SLAYZONE_SUPERVISED), which
  // runs the real schema bootstrap, then killing it once it reports listening. We
  // can't `import { runMigrations }` in-process: migrations.ts pulls
  // `@slayzone/ai-config/shared` → `@dagrejs/dagre` (ESM) and this test runs with
  // NO loader (run_test_electron_strict), so the import hits ERR_REQUIRE_CYCLE_MODULE.
  // The bundled bin has migrations inlined + native ABI matched — the closest thing
  // to what the host actually does.
  await new Promise<void>((resolve, reject) => {
    const seedDir = path.join(dir, 'seed-store')
    fs.mkdirSync(seedDir, { recursive: true })
    // Scrub inherited SLAYZONE_* so the seeder boots genuinely STANDALONE. When
    // this test runs inside a dogfooding session the parent leaks
    // SLAYZONE_SUPERVISED=1 (+ SLAYZONE_DB_PATH → the real dev DB) — which would
    // put the seeder in supervised mode (skips schema bootstrap → the seed does
    // nothing) and point it at the real store. Strip them, then set only the
    // explicit standalone knobs below.
    const seedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k === 'ELECTRON_RUN_AS_NODE' || /^SLAYZONE_/.test(k)) continue
      seedEnv[k] = v
    }
    const seeder = spawn(process.execPath, [binJs], {
      env: {
        ...seedEnv,
        ELECTRON_RUN_AS_NODE: '1',
        // Standalone (no SLAYZONE_SUPERVISED) → openServerDatabase bootstraps schema.
        SLAYZONE_HOST: '127.0.0.1',
        SLAYZONE_PORT: '0',
        SLAYZONE_STORE_DIR: seedDir,
        SLAYZONE_DB_PATH: dbPath,
        SLAYZONE_RUNNER_TRANSPORT_SECRET: 'seed-only-secret-at-least-32-chars-long'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let seedOut = ''
    const onData = (c: Buffer): void => {
      seedOut += c.toString()
      if (seedOut.includes('listening on http')) {
        seeder.kill('SIGKILL')
        resolve()
      }
    }
    seeder.stdout?.on('data', onData)
    seeder.stderr?.on('data', onData)
    const to = setTimeout(() => {
      seeder.kill('SIGKILL')
      reject(new Error(`schema seed never reported listening — output: ${seedOut}`))
    }, 15_000)
    seeder.on('exit', () => clearTimeout(to))
  })
  const child = spawn(process.execPath, [binJs], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_HOST: '127.0.0.1',
      SLAYZONE_PORT: '0',
      SLAYZONE_STORE_DIR: dir,
      SLAYZONE_DB_PATH: dbPath
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  try {
    await waitFor(
      () => out.includes('listening on http'),
      10_000,
      `real side-car never reported listening — output: ${out}`
    )
    // Close the parent→child stdin pipe: this is exactly what happens when the
    // Electron parent dies. The supervised side-car must self-exit.
    child.stdin?.end()
    const exited = await waitForExit(child, 6_000)
    assert(exited, `side-car did not self-exit within 6s of stdin close — output: ${out}`)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('build-identity: running build matches disk manifest ⇒ not stale', async () => {
  const dir = mkTmp()
  writeManifest(dir, 'abc123@2026-07-03T00:00:00.000Z')
  const { handle } = makeHarness(
    dir,
    { FAKE_BUILD_ID: 'abc123@2026-07-03T00:00:00.000Z' },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const s = handle.getStatus()
    assertEq(s.runningBuildId, 'abc123@2026-07-03T00:00:00.000Z', 'runningBuildId from /health')
    assertEq(s.diskBuildId, 'abc123@2026-07-03T00:00:00.000Z', 'diskBuildId from manifest')
    assertEq(s.stale, false, 'not stale when running === disk')
  } finally {
    await handle.stop()
  }
})

test('build-identity: disk manifest ahead of running build ⇒ stale + loud log', async () => {
  const dir = mkTmp()
  writeManifest(dir, 'NEW@2026-07-03T09:00:00.000Z')
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_BUILD_ID: 'OLD@2026-07-01T09:00:00.000Z' },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const s = handle.getStatus()
    assertEq(s.runningBuildId, 'OLD@2026-07-01T09:00:00.000Z', 'runningBuildId is the old build')
    assertEq(s.diskBuildId, 'NEW@2026-07-03T09:00:00.000Z', 'diskBuildId is the new on-disk build')
    assertEq(s.stale, true, 'stale when disk build differs from running build')
    assert(
      ctx.logs.some((l) => l.line.includes('STALE')),
      'a loud STALE log line was emitted on mismatch'
    )
  } finally {
    await handle.stop()
  }
})

test('hot-restart (flag ON): disk build change relaunches the sidecar onto the new build', async () => {
  const dir = mkTmp()
  writeManifest(dir, 'v1@2026-07-03T00:00:00.000Z')
  // Fake reports the manifest's buildId at boot (FAKE_BUILD_ID unset).
  const { handle } = makeHarness(
    dir,
    { FAKE_MANIFEST_FILE: path.join(dir, 'sidecar-build.json') },
    { healthPollIntervalMs: 40, buildWatchIntervalMs: 100 },
    { hotRestartOnBuildChange: true }
  )
  try {
    await handle.waitForReady()
    assertEq(handle.getStatus().runningBuildId, 'v1@2026-07-03T00:00:00.000Z', 'boots on v1')
    assertEq(handle.getStatus().stale, false, 'v1 not stale')
    const respawnsBefore = handle.getStatus().totalRespawns

    // Simulate a rebuild: bump the on-disk manifest.
    writeManifest(dir, 'v2@2026-07-03T01:00:00.000Z')

    await waitFor(
      () => handle.getStatus().runningBuildId === 'v2@2026-07-03T01:00:00.000Z',
      8_000,
      'sidecar hot-restarted onto the new build'
    )
    assert(
      handle.getStatus().totalRespawns > respawnsBefore,
      'a respawn occurred on the build change'
    )
    assertEq(handle.getStatus().stale, false, 'not stale after hot-restart (running === disk)')
  } finally {
    await handle.stop()
  }
})

test('hot-restart (flag OFF): disk build change surfaces stale, does NOT relaunch', async () => {
  const dir = mkTmp()
  writeManifest(dir, 'v1@2026-07-03T00:00:00.000Z')
  const { handle } = makeHarness(
    dir,
    { FAKE_MANIFEST_FILE: path.join(dir, 'sidecar-build.json') },
    { healthPollIntervalMs: 40, buildWatchIntervalMs: 100 }
    // no hotRestartOnBuildChange → detection only
  )
  try {
    await handle.waitForReady()
    const respawnsBefore = handle.getStatus().totalRespawns
    writeManifest(dir, 'v2@2026-07-03T01:00:00.000Z')
    // Give any (unwanted) watcher time to act.
    await delay(600)
    const s = handle.getStatus()
    assertEq(s.runningBuildId, 'v1@2026-07-03T00:00:00.000Z', 'still running v1 (no relaunch)')
    assertEq(s.diskBuildId, 'v2@2026-07-03T01:00:00.000Z', 'disk moved to v2')
    assertEq(s.stale, true, 'stale surfaces')
    assertEq(s.totalRespawns, respawnsBefore, 'no respawn without the flag')
  } finally {
    await handle.stop()
  }
})

test('manual restart() cycles a ready child on the same sticky port', async () => {
  const dir = mkTmp()
  const { handle } = makeHarness(dir, {}, { healthPollIntervalMs: 40 })
  try {
    await handle.waitForReady()
    const before = handle.getStatus()
    assert(typeof before.pid === 'number' && before.pid! > 0, 'has a running child pid')

    await handle.restart()
    await handle.waitForReady()

    const after = handle.getStatus()
    assertEq(after.health, 'ready', 'ready again after manual restart')
    assert(after.pid !== before.pid, 'a new child pid replaced the old one')
    assertEq(after.port, before.port, 'sticky port preserved across manual restart')
    assertEq(after.totalRespawns, before.totalRespawns + 1, 'exactly one respawn')
  } finally {
    await handle.stop()
  }
})

test('manual restart() recovers from permanent failure with a fresh backoff budget', async () => {
  const dir = mkTmp()
  const counterFile = path.join(dir, 'counter')
  // Crash the first 3 spawns (initial + 2 retries with backoffMs.length = 2 →
  // attempts exhausted → permanent failure), then stay healthy: the 4th spawn
  // (triggered only by the manual restart) comes up clean.
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_COUNTER_FILE: counterFile, FAKE_CRASH_FIRST: '3' },
    { backoffMs: [40, 80], healthPollIntervalMs: 40 }
  )
  try {
    await Promise.race([
      ctx.permanentFailed.promise,
      delay(10_000).then(() => {
        throw new Error('permanent failure never reported')
      })
    ])
    assertEq(handle.getHealth(), 'failed', 'failed after exhausting the backoff budget')

    await handle.restart()
    await handle.waitForReady()

    assertEq(handle.getHealth(), 'ready', 'manual restart recovers from failed')
    assertEq(handle.getStatus().restarts, 0, 'backoff attempt counter reset by manual restart')
  } finally {
    await handle.stop()
  }
})

test('fixedPort: binds the given port instead of probing, and keeps it across a crash respawn', async () => {
  const dir = mkTmp()
  // Pick a fixed port by probing one free port up front then closing it — avoids
  // a hardcoded literal colliding with something else already bound on CI/dev.
  const net = await import('node:net')
  const fixedPort: number = await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(p))
    })
  })
  const counterFile = path.join(dir, 'counter')
  const { handle } = makeHarness(
    dir,
    { FAKE_COUNTER_FILE: counterFile, FAKE_CRASH_AFTER_READY_MS: '150' },
    { healthPollIntervalMs: 40 },
    { fixedPort }
  )
  try {
    await handle.waitForReady()
    assertEq(handle.getPort(), fixedPort, 'bound exactly the fixed port, no probing')

    // Crash-after-ready respawns immediately (existing healthy-crash path) — the
    // fixed port must survive that respawn identically to how stickyPort does.
    await waitFor(() => handle.getStatus().totalRespawns >= 1, 8_000, 'respawn after crash')
    await handle.waitForReady()
    assertEq(handle.getPort(), fixedPort, 'fixed port unchanged after crash respawn')
  } finally {
    await handle.stop()
  }
})

// --- runner ---------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0
  let failed = 0
  console.log('\n=== sidecar-server-supervisor crash-recovery ===\n')
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${name}`)
      console.error(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      failed++
    }
  }
  cleanup()
  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exitCode = failed > 0 ? 1 : 0
}

void main()

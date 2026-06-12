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
      res.end('{"ok":true}')
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
  timing?: SidecarServerOpts['timing']
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
    timing
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
  const binJs = path.resolve(here, '../../..', 'server/dist/bin.cjs')
  if (!fs.existsSync(binJs)) {
    console.log(`  ⊘ skipped — ${binJs} not built (run pnpm build first)`)
    return
  }
  const dir = mkTmp()
  const dbPath = path.join(dir, 'parent-death.sqlite')
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

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
 *  - stop() resolves only once the hub is GONE — every caller, and including a
 *    hub a restart was replacing — so an app quit that awaits it cannot exit
 *    under a live hub
 *
 * The supervisor logic is driven against a controllable fake side-car script
 * so backoff timing + permanent failure are deterministic and fast. Timing
 * constants are shrunk through the additive `opts.timing` override (defaults
 * unchanged in production).
 *
 * The same supervisor against the REAL built hub lives in two sibling files, split
 * from this one so their real deadlines run on separate workers:
 * sidecar-server-supervisor-parent-death.test.ts (a supervised hub never outlives
 * its app; the built side-car self-exits when its stdin closes) and
 * sidecar-server-supervisor-real-stop.test.ts (the bounded stop of a real hub).
 */
import { afterAll, expect, test } from 'vitest'
import http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { HUB_PROCESS_ENV } from '@slayzone/platform/hub-switches'
import { SUPERVISED_STOP_DEADLINE_MS } from '@slayzone/platform/parent-watch'
import { QUIT_CHILD_REAP_MS, reapChildForQuit } from './lifecycle/quit-reap-child.js'
import {
  startSidecarServer,
  type SidecarServerHandle,
  type SidecarServerOpts
} from './sidecar-server-supervisor.js'
import {
  cleanupTmpDirs,
  delay,
  mkTmp,
  pidGone,
  waitFor
} from './sidecar-server-supervisor-harness.js'

afterAll(cleanupTmpDirs)

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

// Mirrors the real hub's bind-side read of its listen address var: host[:port].
const addr = process.env.SLAYZONE_HUB_LISTEN_ADDRESS || ''
const colon = addr.lastIndexOf(':')
const host = (colon > 0 ? addr.slice(0, colon) : addr) || '127.0.0.1'
const port = Number((colon > 0 ? addr.slice(colon + 1) : '') || '0')
const counterFile = process.env.FAKE_COUNTER_FILE || ''
const crashFirst = Number(process.env.FAKE_CRASH_FIRST || '0')
const crashAlways = process.env.FAKE_CRASH_ALWAYS === '1'
const nohealth = process.env.FAKE_NOHEALTH === '1'
const crashAfterReadyMs = Number(process.env.FAKE_CRASH_AFTER_READY_MS || '0')

// Lets a test read back the environment the supervisor actually handed the child.
const envDumpFile = process.env.FAKE_ENV_DUMP_FILE || ''
if (envDumpFile) {
  try { fs.writeFileSync(envDumpFile, JSON.stringify(process.env)) } catch (e) {}
}

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

// A hub whose stop never finishes (the orphan class: a client connection that keeps
// the hub's HTTP server from closing), which only SIGKILL ends.
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', function () {})
// A hub whose graceful stop takes this long (closing its DB, flushing diagnostics).
const stopMs = Number(process.env.FAKE_STOP_MS || '0')
if (stopMs > 0) process.on('SIGTERM', function () { setTimeout(function () { process.exit(0) }, stopMs) })
// How it ended: a code when it exited by itself, nothing when it was SIGKILLed.
const exitFile = process.env.FAKE_EXIT_FILE || ''
if (exitFile) process.on('exit', function (code) { fs.writeFileSync(exitFile, String(code)) })

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

function writeFakeSidecar(dir: string): string {
  const p = path.join(dir, 'fake-sidecar.cjs')
  fs.writeFileSync(p, FAKE_SIDECAR)
  return p
}
/** Write the on-disk build manifest the supervisor compares the running build to. */
function writeManifest(dir: string, buildId: string): void {
  fs.writeFileSync(path.join(dir, 'sidecar-build.json'), JSON.stringify({ buildId }))
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
    // Diagnostics-only echo, DERIVED by the caller in production (there is no
    // path-pointing env var). Overridable per-test through `extra`.
    dbPath: path.join(dir, 'slayzone.dev.data.sqlite'),
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

// --- tests ----------------------------------------------------------------

test('/health probe drives the child to ready + exposes status', async () => {
  const dir = mkTmp()
  const dbSentinel = path.join(dir, 'sentinel.sqlite')
  const { handle } = makeHarness(dir, {}, { healthPollIntervalMs: 40 }, { dbPath: dbSentinel })
  try {
    await handle.waitForReady()
    expect(handle.getHealth(), 'health after waitForReady').toBe('ready')
    const port = handle.getPort()
    expect(typeof port, 'getPort returns a bound port').toBe('number')
    expect(port, 'getPort returns a bound port').toBeGreaterThan(0)

    const status = handle.getStatus()
    expect(status.health, 'status.health').toBe('ready')
    expect(status.port, 'status.port matches getPort').toBe(port)
    expect(typeof status.pid, 'status.pid set').toBe('number')
    expect(status.pid!, 'status.pid set').toBeGreaterThan(0)
    expect(status.restarts, 'status.restarts is 0 on clean start').toBe(0)
    expect(status.totalRespawns, 'status.totalRespawns is 0 on clean start').toBe(0)
    expect(status.dbPath, 'status.dbPath echoes the caller-derived path').toBe(dbSentinel)
    expect(typeof status.uptimeMs, 'uptimeMs set').toBe('number')
    expect(status.uptimeMs!, 'uptimeMs set').toBeGreaterThanOrEqual(0)

    // The supervisor reported ready only because /health answered 200.
    expect(await probe(port!), 'side-car /health answers 200').toBe(200)
  } finally {
    await handle.stop()
  }
})

test('the child gets the hub env: its LISTEN address, login off, never the dial-side address', async () => {
  const dir = mkTmp()
  const dump = path.join(dir, 'child-env.json')
  const { handle } = makeHarness(
    dir,
    {
      FAKE_ENV_DUMP_FILE: dump,
      // What a dev app launched from a SlayZone task terminal inherits: a dial-side
      // address (the hub refuses to boot with it, rule B5) and, say, a stray login switch.
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:51101',
      SLAYZONE_HUB_REQUIRE_LOGIN: '1'
    },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const env = JSON.parse(fs.readFileSync(dump, 'utf8')) as Record<string, string | undefined>
    expect(
      env.SLAYZONE_HUB_LISTEN_ADDRESS,
      'the hub is told where to listen under its own name'
    ).toBe(`127.0.0.1:${handle.getPort()}`)
    expect(env.SLAYZONE_HUB_ADDRESS, 'the dial-side name never reaches the hub').toBe(undefined)
    expect(
      env.SLAYZONE_HUB_REQUIRE_LOGIN,
      "the desktop app's hub has login off, set explicitly over whatever was inherited"
    ).toBe('0')
    expect(env.SLAYZONE_SUPERVISED, 'still marked as started by the desktop app').toBe('1')
    expect(env.SLAYZONE_MODE, 'no mode is handed over').toBe(undefined)
  } finally {
    await handle.stop()
  }
})

test('hub-side config the app inherited never reaches the child hub', async () => {
  const dir = mkTmp()
  const dump = path.join(dir, 'child-env.json')
  // Every variable that configures a hub process, set to something that would break
  // the desktop's hub if it got through: a public address makes a login-off hub
  // "reachable" (B1 refuses), a non-0/1 switch is B4, the old listen name is B5, and
  // an inherited auth secret / SSO secret / origin list silently change who gets in.
  const inheritedHubConfig: Record<string, string> = {
    SLAYZONE_HUB_PUBLIC_ADDRESS: 'hub.example.com',
    SLAYZONE_HUB_LISTEN_ADDRESS: '0.0.0.0:9',
    SLAYZONE_HUB_ADDRESS: 'hub.example.com:443',
    SLAYZONE_HUB_REQUIRE_LOGIN: 'sometimes',
    SLAYZONE_HUB_ENABLE_PASSWORD: 'yes',
    SLAYZONE_HUB_ENABLE_SSO: '1',
    SLAYZONE_HUB_ENABLE_PROCESSES: 'maybe',
    SLAYZONE_HUB_ENABLE_INTEGRATIONS: 'true',
    SLAYZONE_HUB_SSO_TENANT_ID: 'inherited-tenant',
    SLAYZONE_HUB_SSO_CLIENT_ID: 'inherited-client',
    SLAYZONE_HUB_SSO_CLIENT_SECRET: 'inherited-sso-secret',
    SLAYZONE_HUB_SSO_CERT_PATH: '/inherited/sso-cert.pem',
    SLAYZONE_HUB_SSO_KEY_PATH: '/inherited/sso-key.pem',
    SLAYZONE_HUB_SSO_REQUIRE_MFA: 'perhaps',
    SLAYZONE_HUB_AUTH_SECRET: 'inherited-auth-secret',
    SLAYZONE_HUB_ALLOWED_WEB_ORIGINS: 'https://elsewhere.example.com',
    SLAYZONE_HUB_TRUSTED_PROXIES: '0.0.0.0/0',
    // A shared hub's period: inherited, it would delete the desktop user's sessions.
    SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90',
    // Inherited, the hub would start GitHub sign-in against someone else's host (T-99).
    SLAYZONE_HUB_CONVEX_ADDRESS: 'metadata.internal',
    // Inherited, a shared hub's telemetry opt-out would silently switch off the desktop's.
    SLAYZONE_HUB_ENABLE_TELEMETRY: '0'
  }
  // The list under test must be the WHOLE hub-side surface, not what this test
  // remembers: a hub variable added to the platform list without a case here is a
  // variable this test no longer proves is stripped.
  for (const name of HUB_PROCESS_ENV) {
    expect(
      inheritedHubConfig,
      `${name} is in HUB_PROCESS_ENV but not exercised here`
    ).toHaveProperty([name])
  }
  const { handle } = makeHarness(
    dir,
    { FAKE_ENV_DUMP_FILE: dump, ...inheritedHubConfig },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const env = JSON.parse(fs.readFileSync(dump, 'utf8')) as Record<string, string | undefined>
    for (const name of HUB_PROCESS_ENV) {
      if (name === 'SLAYZONE_HUB_LISTEN_ADDRESS' || name === 'SLAYZONE_HUB_REQUIRE_LOGIN') continue
      expect(env[name], `inherited ${name} was stripped`).toBe(undefined)
    }
    // The two the app sets itself are its own values, not what was inherited.
    expect(env.SLAYZONE_HUB_LISTEN_ADDRESS, 'listen address is the app’s own').toBe(
      `127.0.0.1:${handle.getPort()}`
    )
    expect(env.SLAYZONE_HUB_REQUIRE_LOGIN, 'login switch is the app’s own').toBe('0')
    // Unrelated environment still flows through.
    expect(env.SLAYZONE_SUPERVISED, 'still marked as started by the desktop app').toBe('1')
  } finally {
    await handle.stop()
  }
})

test("the app's own Convex deployment reaches the hub, never an inherited one", async () => {
  const dir = mkTmp()
  const dump = path.join(dir, 'child-env.json')
  const { handle } = makeHarness(
    dir,
    { FAKE_ENV_DUMP_FILE: dump, SLAYZONE_HUB_CONVEX_ADDRESS: 'metadata.internal' },
    { healthPollIntervalMs: 40 },
    { convexAddress: 'happy-animal-123.convex.cloud' }
  )
  try {
    await handle.waitForReady()
    const env = JSON.parse(fs.readFileSync(dump, 'utf8')) as Record<string, string | undefined>
    expect(
      env.SLAYZONE_HUB_CONVEX_ADDRESS,
      'the hub signs in against the deployment the renderer was built for'
    ).toBe('happy-animal-123.convex.cloud')
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
    expect(ctx.spawnTimes.length, 'total spawn count (initial + 5 retries)').toBe(6)

    // Measure the backoff itself: from the crash (the "restart in Xms" line the
    // supervisor logs when it schedules the retry) to the next spawn. Spawn→spawn
    // gaps also include the child's boot-until-crash time, which under a loaded
    // box (2s+) swamps a 300ms slot and made the old "strictly increasing gaps"
    // check flake.
    const restarts = ctx.logs
      .map((e) => ({ t: e.t, m: /\[supervisor\] restart in (\d+)ms/.exec(e.line) }))
      .filter((r): r is { t: number; m: RegExpExecArray } => r.m !== null)
    expect(
      restarts.map((r) => Number(r.m[1])),
      'scheduled delays follow the backoff schedule exactly'
    ).toEqual(backoffMs)
    for (let i = 0; i < restarts.length; i++) {
      const waited = ctx.spawnTimes[i + 1] - restarts[i].t
      // setTimeout never fires early; the slack covers Date.now() granularity.
      expect(
        waited,
        `retry ${i} waited ${waited}ms >= backoff ${backoffMs[i]}ms`
      ).toBeGreaterThanOrEqual(backoffMs[i] - 5)
    }

    expect(ctx.permanentFailure, 'onPermanentFailure fired').not.toBe(null)
    expect(ctx.permanentFailure!.attempts, 'permanent failure after 5 attempts').toBe(5)
    expect(handle.getHealth(), 'health is failed').toBe('failed')

    let rejected = false
    await handle.waitForReady().catch(() => {
      rejected = true
    })
    expect(rejected, 'waitForReady rejects after permanent failure').toBe(true)
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
    expect(handle.getStatus().restarts, 'restarts reflects the 2 pre-ready crashes').toBe(2)

    // After a healthyResetMs streak the counter resets to 0.
    await waitFor(
      () => handle.getStatus().restarts === 0,
      3_000,
      'restarts never reset to 0 after healthy streak'
    )
    expect(handle.getHealth(), 'still ready after the streak reset').toBe('ready')
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
    expect(gap, `respawn gap ${gap}ms is well under the 5s backoff`).toBeLessThan(2_000)
    // No backoff scheduling log line was emitted.
    expect(
      ctx.logs.some((l) => l.line.includes('restart in')),
      'no "restart in" backoff log for a ready-child exit'
    ).toBe(false)
    await waitFor(() => handle.getHealth() === 'ready', 5_000, 'never returned to ready')
    expect(handle.getStatus().restarts, 'restarts stayed 0 across a ready-child respawn').toBe(0)
    // The lifetime counter DOES move — crash e2e asserts on it since `restarts`
    // never increments on the healthy-crash immediate-respawn path.
    expect(handle.getStatus().totalRespawns, 'totalRespawns counts the respawn').toBe(1)
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
    expect(
      ctx.logs.some((l) => l.line.includes('health timeout')),
      'supervisor logged a health-timeout kill'
    ).toBe(true)
    expect(ctx.permanentFailure, 'never-healthy child eventually fails permanently').not.toBe(null)
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
    expect(typeof pid, 'has a running child pid').toBe('number')
    expect(pid!, 'has a running child pid').toBeGreaterThan(0)

    await handle.stop()
    await handle.stop() // idempotent — must not throw

    // No restart fires after stop().
    const spawnsAfterStop = ctx.spawnTimes.length
    await delay(500)
    expect(ctx.spawnTimes.length, 'no respawn after stop()').toBe(spawnsAfterStop)
    expect(handle.getStatus().pid, 'no child pid after stop()').toBe(null)
  } finally {
    await handle.stop()
  }
})

test('suspendRestarts: a hub that dies during app quit stays down', async () => {
  // App quit drains subprocesses BEFORE will-quit runs stop(). A ready hub that
  // dies in that window (SIGINT to the dev process group) used to respawn
  // immediately — and outlived the stalled quit, holding the port the next app
  // boot needed.
  const dir = mkTmp()
  const { handle, ctx } = makeHarness(dir, {}, { healthPollIntervalMs: 40 })
  try {
    await handle.waitForReady()
    const pid = handle.getStatus().pid!
    handle.suspendRestarts()
    process.kill(pid, 'SIGKILL')
    await waitFor(() => handle.getStatus().pid === null, 5_000, 'killed hub detached')
    await delay(300)
    expect(ctx.spawnTimes.length, 'no respawn after suspendRestarts').toBe(1)
  } finally {
    await handle.stop()
  }
})

// --- quit: stop() resolves only once the hub is gone --------------------------

test('stop: resolves only once the hub is gone, SIGKILLing one that ignores SIGTERM', async () => {
  const dir = mkTmp()
  const { handle } = makeHarness(
    dir,
    { FAKE_IGNORE_SIGTERM: '1' },
    { healthPollIntervalMs: 40, stopSigtermGraceMs: 300 }
  )
  try {
    await handle.waitForReady()
    const pid = handle.getStatus().pid!
    const started = Date.now()
    await handle.stop()
    expect(pidGone(pid), 'the hub is gone when stop() resolves').toBe(true)
    expect(
      Date.now() - started,
      'SIGTERM got its grace period before the SIGKILL'
    ).toBeGreaterThanOrEqual(250)
  } finally {
    await handle.stop()
  }
})

test('stop: a second caller waits for the same reap instead of returning early', async () => {
  // will-quit and the quit watchdog can both reach stop(). Whichever comes second
  // must not read "already stopping" as "gone" and let the app exit under a live hub.
  const dir = mkTmp()
  const { handle } = makeHarness(
    dir,
    { FAKE_IGNORE_SIGTERM: '1' },
    { healthPollIntervalMs: 40, stopSigtermGraceMs: 300 }
  )
  await handle.waitForReady()
  const pid = handle.getStatus().pid!
  const first = handle.stop()
  await handle.stop()
  expect(pidGone(pid), 'the second stop() resolved only after the hub was gone').toBe(true)
  await first
})

test('stop: during a restart, reaps the hub the restart was replacing and spawns none', async () => {
  const dir = mkTmp()
  const { handle, ctx } = makeHarness(
    dir,
    { FAKE_IGNORE_SIGTERM: '1' },
    { healthPollIntervalMs: 40, stopSigtermGraceMs: 300, restartSigtermGraceMs: 300 }
  )
  await handle.waitForReady()
  const outgoing = handle.getStatus().pid!
  const restarting = handle.restart()
  await handle.stop()
  expect(pidGone(outgoing), 'the outgoing hub is gone when stop() resolves').toBe(true)
  await restarting
  await delay(200)
  expect(handle.getStatus().pid, 'the restart spawned no replacement after the stop').toBe(null)
  expect(ctx.spawnTimes.length, 'no second hub was ever spawned').toBe(1)
})

// --- quit: a graceful stop is never cut shorter than the hub's own deadline ----
// Production timing on purpose (no stopSigtermGraceMs override): what is pinned is
// how the real grace and the quit's real wait line up with the hub's own deadline.

test('quit: a hub whose stop takes ~4s exits by itself, cleanly — never SIGKILLed early', async () => {
  // Past the 3s grace this used to be SIGKILLed at, inside the hub's own 5s deadline:
  // its DB close and diagnostics flush must get to run.
  const dir = mkTmp()
  const exitFile = path.join(dir, 'exit')
  const { handle } = makeHarness(
    dir,
    { FAKE_STOP_MS: '4000', FAKE_EXIT_FILE: exitFile },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const started = Date.now()
    const result = await reapChildForQuit({
      stop: () => handle.stop(),
      timeoutMs: QUIT_CHILD_REAP_MS
    })
    expect(result, 'the quit saw the hub gone').toBe('stopped')
    expect(Date.now() - started, 'it really took its ~4s').toBeGreaterThanOrEqual(3_900)
    expect(
      fs.existsSync(exitFile) ? fs.readFileSync(exitFile, 'utf8') : null,
      'exit 0, not SIGKILL'
    ).toBe('0')
  } finally {
    await handle.stop()
  }
})

test('quit: a stuck hub is still SIGKILLed — after its own deadline, inside the quit’s wait', async () => {
  const dir = mkTmp()
  const exitFile = path.join(dir, 'exit')
  const { handle } = makeHarness(
    dir,
    { FAKE_IGNORE_SIGTERM: '1', FAKE_EXIT_FILE: exitFile },
    { healthPollIntervalMs: 40 }
  )
  try {
    await handle.waitForReady()
    const pid = handle.getStatus().pid!
    const started = Date.now()
    const result = await reapChildForQuit({
      stop: () => handle.stop(),
      timeoutMs: QUIT_CHILD_REAP_MS
    })
    const elapsed = Date.now() - started
    expect(result, `the quit saw the hub gone, not a timeout (${elapsed}ms)`).toBe('stopped')
    expect(pidGone(pid), 'the stuck hub is gone').toBe(true)
    expect(fs.existsSync(exitFile), 'it was SIGKILLed: no exit of its own').toBe(false)
    expect(elapsed, `not before its own deadline (${elapsed}ms)`).toBeGreaterThanOrEqual(
      SUPERVISED_STOP_DEADLINE_MS
    )
  } finally {
    await handle.stop()
  }
})

test('restart: keeps its short grace — the replacement waits on the outgoing hub', async () => {
  // The app stays up, so nothing can be orphaned and nothing finishes "after the
  // app": a slow stop only delays the hub the user is waiting for (it needs the
  // same port). The 3s grace is unchanged.
  const dir = mkTmp()
  // Only the stop is shortened (the cleanup below); the restart keeps production timing.
  const { handle } = makeHarness(
    dir,
    { FAKE_IGNORE_SIGTERM: '1' },
    { healthPollIntervalMs: 40, stopSigtermGraceMs: 300 }
  )
  try {
    await handle.waitForReady()
    const started = Date.now()
    await handle.restart()
    const elapsed = Date.now() - started
    expect(elapsed, `SIGKILL at 3s (${elapsed}ms)`).toBeGreaterThanOrEqual(2_900)
    expect(elapsed, `SIGKILL at 3s (${elapsed}ms)`).toBeLessThan(SUPERVISED_STOP_DEADLINE_MS)
  } finally {
    await handle.stop()
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
    expect(s.runningBuildId, 'runningBuildId from /health').toBe('abc123@2026-07-03T00:00:00.000Z')
    expect(s.diskBuildId, 'diskBuildId from manifest').toBe('abc123@2026-07-03T00:00:00.000Z')
    expect(s.stale, 'not stale when running === disk').toBe(false)
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
    expect(s.runningBuildId, 'runningBuildId is the old build').toBe('OLD@2026-07-01T09:00:00.000Z')
    expect(s.diskBuildId, 'diskBuildId is the new on-disk build').toBe(
      'NEW@2026-07-03T09:00:00.000Z'
    )
    expect(s.stale, 'stale when disk build differs from running build').toBe(true)
    expect(
      ctx.logs.some((l) => l.line.includes('STALE')),
      'a loud STALE log line was emitted on mismatch'
    ).toBe(true)
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
    expect(handle.getStatus().runningBuildId, 'boots on v1').toBe('v1@2026-07-03T00:00:00.000Z')
    expect(handle.getStatus().stale, 'v1 not stale').toBe(false)
    const respawnsBefore = handle.getStatus().totalRespawns

    // Simulate a rebuild: bump the on-disk manifest.
    writeManifest(dir, 'v2@2026-07-03T01:00:00.000Z')

    await waitFor(
      () => handle.getStatus().runningBuildId === 'v2@2026-07-03T01:00:00.000Z',
      8_000,
      'sidecar hot-restarted onto the new build'
    )
    expect(
      handle.getStatus().totalRespawns,
      'a respawn occurred on the build change'
    ).toBeGreaterThan(respawnsBefore)
    expect(handle.getStatus().stale, 'not stale after hot-restart (running === disk)').toBe(false)
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
    expect(s.runningBuildId, 'still running v1 (no relaunch)').toBe('v1@2026-07-03T00:00:00.000Z')
    expect(s.diskBuildId, 'disk moved to v2').toBe('v2@2026-07-03T01:00:00.000Z')
    expect(s.stale, 'stale surfaces').toBe(true)
    expect(s.totalRespawns, 'no respawn without the flag').toBe(respawnsBefore)
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
    expect(typeof before.pid, 'has a running child pid').toBe('number')
    expect(before.pid!, 'has a running child pid').toBeGreaterThan(0)

    await handle.restart()
    await handle.waitForReady()

    const after = handle.getStatus()
    expect(after.health, 'ready again after manual restart').toBe('ready')
    expect(after.pid, 'a new child pid replaced the old one').not.toBe(before.pid)
    expect(after.port, 'sticky port preserved across manual restart').toBe(before.port)
    expect(after.totalRespawns, 'exactly one respawn').toBe(before.totalRespawns + 1)
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
    expect(handle.getHealth(), 'failed after exhausting the backoff budget').toBe('failed')

    await handle.restart()
    await handle.waitForReady()

    expect(handle.getHealth(), 'manual restart recovers from failed').toBe('ready')
    expect(handle.getStatus().restarts, 'backoff attempt counter reset by manual restart').toBe(0)
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
    expect(handle.getPort(), 'bound exactly the fixed port, no probing').toBe(fixedPort)

    // Crash-after-ready respawns immediately (existing healthy-crash path) — the
    // fixed port must survive that respawn identically to how stickyPort does.
    await waitFor(() => handle.getStatus().totalRespawns >= 1, 8_000, 'respawn after crash')
    await handle.waitForReady()
    expect(handle.getPort(), 'fixed port unchanged after crash respawn').toBe(fixedPort)
  } finally {
    await handle.stop()
  }
})

/**
 * Local-computer supervisor exit-reporting + manual-restart tests.
 *
 * The local computer OWNS every agent pty (each `claude` process is a direct
 * child of it), so a computer exit kills every agent at once and the hub renders
 * it as "Process exited with code 1" on every open task. Until now the reason
 * was unrecoverable: the supervisor's own `computer exited code=…` notice and the
 * child's stdout/stderr both went to `logBoot`, a no-op unless
 * SLAYZONE_DEBUG_BOOT=1, and nothing recorded a diagnostics event. These tests
 * pin the structured `onExit` report that replaces that blind spot.
 *
 * The second group pins `restart()` — the Settings → Computers button. It is the
 * only recovery from the supervisor's two DEAD ENDS (backoff exhausted, and the
 * needs-re-enrollment latch), so the tests assert it clears both rather than
 * merely cycling a healthy child.
 *
 * The third group pins `stop()` as the app's quit relies on it: it resolves only
 * once the computer is GONE — every caller, and including a computer a restart
 * was replacing — so an awaited quit cannot exit under a live computer.
 *
 * Driven against a controllable fake computer script so exit codes, output tails
 * and backoff exhaustion are deterministic and fast. Timing constants are
 * shrunk through the additive `opts.timing` override (defaults unchanged in
 * production).
 *
 * The last group is parent death, against the REAL built computer (rebuilt on
 * demand): a supervised computer must never outlive its app — not when the app is
 * SIGKILLed, not when it quits without waiting, not when a leaked handle keeps the
 * computer's loop alive — while a standalone computer ignores its parent entirely.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm \
 *     packages/apps/app/src/main/local-computer-supervisor.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SUPERVISED_STOP_DEADLINE_MS } from '@slayzone/platform/parent-watch'
import { QUIT_CHILD_REAP_MS, reapChildForQuit } from './lifecycle/quit-reap-child.js'
import {
  startLocalComputer,
  type LocalComputerExitInfo,
  type LocalComputerHandle,
  type LocalComputerOpts
} from './local-computer-supervisor.js'

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
    await delay(10)
  }
  throw new Error(`timeout after ${timeoutMs}ms: ${msg}`)
}

// --- fake computer script (controllable exit code / output) -----------------

const FAKE_COMPUTER = `'use strict'
const code = Number(process.env.FAKE_EXIT_CODE || '0')
const lines = Number(process.env.FAKE_LINES || '0')
const stayAlive = process.env.FAKE_STAY_ALIVE === '1'
if (stayAlive) {
  // A long-lived computer, like the real one: only a signal ends it. SIGTERM is
  // handled explicitly so the supervisor's graceful-stop path is exercised
  // rather than its SIGKILL fallback — unless FAKE_IGNORE_SIGTERM asks for a
  // computer whose stop never finishes (the orphan class: a handle that keeps a
  // stopping computer's loop alive), which only SIGKILL ends. Installed BEFORE
  // the token line below, which tests read as "spawned": a SIGTERM that landed
  // between the two would hit the default action and kill it at once.
  // FAKE_STOP_MS: a graceful stop that takes this long (disposing ptys, closing
  // its hub socket) before it exits by itself.
  process.on('SIGTERM', function () {
    if (process.env.FAKE_IGNORE_SIGTERM === '1') return
    const stopMs = Number(process.env.FAKE_STOP_MS || '0')
    if (stopMs > 0) setTimeout(function () { process.exit(0) }, stopMs)
    else process.exit(0)
  })
}
// How it ended: a code when it exited by itself, nothing when it was SIGKILLed.
if (process.env.FAKE_EXIT_FILE) {
  process.on('exit', function (c) { require('node:fs').writeFileSync(process.env.FAKE_EXIT_FILE, String(c)) })
}
// Echoed so a test can see WHICH join token this particular spawn was handed —
// that is how the re-mint on restart is observed from outside.
process.stdout.write('fake-computer token=' + (process.env.SLAYZONE_HUB_JOIN_TOKEN || '') + '\\n')
for (let i = 1; i <= lines; i++) process.stderr.write('computer-line-' + i + '\\n')
process.stdout.write('fake-computer bye\\n')
if (stayAlive) {
  setInterval(function () {}, 1000)
} else {
  // Exit on a turn of the loop so the pipes flush first.
  setTimeout(function () { process.exit(code) }, 10)
}
`

const tmpDirs: string[] = []
function writeFakeComputer(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-sup-test-'))
  tmpDirs.push(dir)
  const p = path.join(dir, 'fake-computer.cjs')
  fs.writeFileSync(p, FAKE_COMPUTER)
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

type HarnessCtx = {
  exits: LocalComputerExitInfo[]
  permanentFailure: { attempts: number; lastError: unknown } | null
  needsReEnrollment: number
  /** Every stdout/stderr line from every child, in order. */
  lines: string[]
  /** Tokens handed out by the harness's `mintJoinToken`, in mint order. */
  mintedTokens: string[]
}

function makeHarness(
  fakeEnv: Record<string, string>,
  timing: LocalComputerOpts['timing'],
  /** Opt in to the re-mint hook (production always supplies one). */
  withMint = false
): { handle: LocalComputerHandle; ctx: HarnessCtx } {
  const ctx: HarnessCtx = {
    exits: [],
    permanentFailure: null,
    needsReEnrollment: 0,
    lines: [],
    mintedTokens: []
  }
  const handle = startLocalComputer({
    execPath: process.execPath,
    scriptPath: writeFakeComputer(),
    env: { ...process.env, SLAYZONE_HUB_JOIN_TOKEN: 'token-boot', ...fakeEnv },
    logger: (line) => ctx.lines.push(line),
    onExit: (info) => ctx.exits.push(info),
    onPermanentFailure: (info) => {
      ctx.permanentFailure = info
    },
    onNeedsReEnrollment: () => {
      ctx.needsReEnrollment += 1
    },
    ...(withMint
      ? {
          mintJoinToken: async () => {
            const token = `token-mint-${ctx.mintedTokens.length + 1}`
            ctx.mintedTokens.push(token)
            return token
          }
        }
      : {}),
    timing
  })
  return { handle, ctx }
}

/** Lines the children echoed their join token on, oldest first. */
function tokensSeenByChildren(ctx: HarnessCtx): string[] {
  return ctx.lines
    .filter((l) => l.includes('fake-computer token='))
    .map((l) => l.slice(l.indexOf('token=') + 'token='.length).trim())
}

// --- tests ----------------------------------------------------------------

test('reports the exit code, uptime and the dying child output tail', async () => {
  const { handle, ctx } = makeHarness(
    { FAKE_EXIT_CODE: '7', FAKE_LINES: '3' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 100 }
  )
  try {
    await waitFor(() => ctx.exits.length >= 1, 15_000, 'first computer exit reported')
    const first = ctx.exits[0]
    assertEq(first.code, 7, 'exit code surfaced verbatim')
    assertEq(first.signal, null, 'no signal on a self-exit')
    assert(first.uptimeMs >= 0, 'uptimeMs is present')
    // The tail is what makes an exit diagnosable — a computer that dies on an
    // uncaught exception prints the stack here and nowhere else.
    assert(
      first.tail.includes('computer-line-3'),
      `tail carries the child's last stderr line, got ${JSON.stringify(first.tail)}`
    )
    assert(
      first.tail.includes('fake-computer bye'),
      `tail carries stdout too, got ${JSON.stringify(first.tail)}`
    )
  } finally {
    await handle.stop()
  }
})

test('reports the scheduled restart, then reports the give-up exit', async () => {
  // Two-slot backoff budget: exits 1 and 2 each schedule a restart; exit 3 has
  // no budget left, so it is the one an operator must be told about.
  const { handle, ctx } = makeHarness(
    { FAKE_EXIT_CODE: '1', FAKE_LINES: '1' },
    { backoffMs: [5, 5], healthyResetMs: 60_000, stopSigtermGraceMs: 100 }
  )
  try {
    await waitFor(() => ctx.exits.length >= 3, 20_000, 'three computer exits reported')
    assertEq(ctx.exits[0].restartAttempt, 1, 'first exit schedules restart 1')
    assertEq(ctx.exits[0].restartDelayMs, 5, 'first exit reports its backoff delay')
    assertEq(ctx.exits[1].restartAttempt, 2, 'second exit schedules restart 2')
    assertEq(ctx.exits[2].restartAttempt, null, 'third exit has no restart left')
    assertEq(ctx.exits[2].restartDelayMs, null, 'no delay when not restarting')
    await waitFor(() => ctx.permanentFailure !== null, 5_000, 'permanent failure reported')
  } finally {
    await handle.stop()
  }
})

// --- manual restart (Settings → Computers button) ---------------------------

test('restart cycles a live computer without reporting it as a crash', async () => {
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 500 }
  )
  try {
    await waitFor(() => handle.getPid() !== null, 15_000, 'first computer spawned')
    const firstPid = handle.getPid()
    await handle.restart()
    const secondPid = handle.getPid()
    assert(secondPid !== null, 'a replacement computer is running after restart')
    assert(
      secondPid !== firstPid,
      `restart replaced the process (was ${String(firstPid)}, now ${String(secondPid)})`
    )
    // The kill was deliberate, so it must NOT reach the crash-reporting channel:
    // that feeds a warn/error diagnostic about every agent on the machine dying.
    assertEq(ctx.exits.length, 0, 'a deliberate restart is not reported as an exit')
  } finally {
    await handle.stop()
  }
})

test('restart re-mints the join token for the new child', async () => {
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 500 },
    true
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length >= 1, 15_000, 'first child echoed a token')
    assertEq(tokensSeenByChildren(ctx)[0], 'token-boot', 'first spawn uses the env token')
    await handle.restart()
    await waitFor(
      () => tokensSeenByChildren(ctx).length >= 2,
      15_000,
      'restarted child echoed a token'
    )
    // The env token is SINGLE-USE. A restart that reuses it cannot recover the
    // one failure it exists to recover (a refused stored credential).
    assertEq(ctx.mintedTokens.length, 1, 'restart minted exactly one fresh token')
    assertEq(tokensSeenByChildren(ctx)[1], 'token-mint-1', 'the new child got the fresh token')
  } finally {
    await handle.stop()
  }
})

test('restart recovers a computer that exhausted its backoff budget', async () => {
  // One-slot budget: exit → restart 1 → exit → give up. Nothing auto-recovers
  // from there today; the button is the whole recovery.
  const { handle, ctx } = makeHarness(
    { FAKE_EXIT_CODE: '1' },
    { backoffMs: [5], healthyResetMs: 60_000, stopSigtermGraceMs: 500 }
  )
  try {
    await waitFor(() => ctx.permanentFailure !== null, 20_000, 'backoff budget exhausted')
    assertEq(handle.getPid(), null, 'no computer is running after the give-up')
    ctx.exits.length = 0
    await handle.restart()
    // A fresh budget, so the respawned (still-failing) fake gets to retry again —
    // proof the attempt counter was reset rather than left exhausted.
    await waitFor(
      () => ctx.exits.some((e) => e.restartAttempt === 1),
      20_000,
      'restart granted a fresh backoff budget'
    )
  } finally {
    await handle.stop()
  }
})

test('restart clears the needs-re-enrollment latch', async () => {
  // Exit 78 = the hub no longer recognizes this computer. The supervisor latches
  // it and refuses every further restart — permanently, until the app relaunches.
  const { handle, ctx } = makeHarness(
    { FAKE_EXIT_CODE: '78' },
    { backoffMs: [5, 5], healthyResetMs: 60_000, stopSigtermGraceMs: 500 },
    true
  )
  try {
    await waitFor(() => ctx.needsReEnrollment >= 1, 20_000, 'computer latched needs-re-enrollment')
    assertEq(handle.getPid(), null, 'no computer is running while latched')
    const spawnsBefore = tokensSeenByChildren(ctx).length
    await handle.restart()
    await waitFor(
      () => tokensSeenByChildren(ctx).length > spawnsBefore,
      15_000,
      'restart spawned a computer despite the latch'
    )
    // Re-enrolling is exactly what a fresh token is for — the latch means the
    // stored credential is dead, so the new child must not be handed the spent one.
    assert(ctx.mintedTokens.length >= 1, 'restart minted a fresh token to re-enroll with')
  } finally {
    await handle.stop()
  }
})

test('suspendRestarts: a computer that dies during app quit stays down', async () => {
  // App quit drains subprocesses BEFORE will-quit runs stop(). A computer that
  // dies in that window (e.g. SIGINT to the dev process group) must not be
  // respawned: the respawn outlives a stalled quit and fights the next app's
  // computer for the same id, killing every agent on each takeover.
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1' },
    { backoffMs: [5, 5], healthyResetMs: 60_000, stopSigtermGraceMs: 100 }
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
    const pid = handle.getPid()!
    handle.suspendRestarts()
    process.kill(pid, 'SIGKILL')
    await waitFor(() => handle.getPid() === null, 15_000, 'killed computer detached')
    await delay(200)
    assertEq(tokensSeenByChildren(ctx).length, 1, 'no respawn after suspendRestarts')
    assertEq(handle.getPid(), null, 'nothing running')
    assertEq(ctx.permanentFailure, null, 'a quit-time death is not a permanent failure')
  } finally {
    await handle.stop()
  }
})

// --- quit: stop() resolves only once the computer is gone --------------------

/**
 * True once `pid` no longer runs. A zombie counts as gone: an orphan that exited
 * but has not been reaped by its new parent yet is not a running computer.
 */
function pidGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    return stat.trim().startsWith('Z')
  } catch {
    return true // ps exits non-zero for a pid it cannot find
  }
}

test('stop: resolves only once the computer is gone, SIGKILLing one that ignores SIGTERM', async () => {
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_IGNORE_SIGTERM: '1' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 300 }
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
    const pid = handle.getPid()!
    const started = Date.now()
    await handle.stop()
    assert(pidGone(pid), 'the computer is gone when stop() resolves')
    assert(Date.now() - started >= 250, 'SIGTERM got its grace period before the SIGKILL')
  } finally {
    await handle.stop()
  }
})

test('stop: a second caller waits for the same reap instead of returning early', async () => {
  // will-quit and the quit watchdog can both reach stop(). Whichever comes second
  // must not read "already stopping" as "gone" and let the app exit under a live
  // computer.
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_IGNORE_SIGTERM: '1' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 300 }
  )
  await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
  const pid = handle.getPid()!
  const first = handle.stop()
  await handle.stop()
  assert(pidGone(pid), 'the second stop() resolved only after the computer was gone')
  await first
})

test('stop: during a restart, reaps the computer the restart was replacing', async () => {
  // restart() detaches the outgoing computer before killing it, so `stop()` used to
  // find no child and return at once — while the outgoing one was still inside its
  // SIGTERM grace, and the app was free to exit before the SIGKILL landed.
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_IGNORE_SIGTERM: '1' },
    {
      backoffMs: [10_000],
      healthyResetMs: 60_000,
      stopSigtermGraceMs: 300,
      restartSigtermGraceMs: 300
    },
    true
  )
  await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
  const outgoing = handle.getPid()!
  const restarting = handle.restart()
  await handle.stop()
  assert(pidGone(outgoing), 'the outgoing computer is gone when stop() resolves')
  await restarting
  await delay(100)
  assertEq(handle.getPid(), null, 'the restart spawned no replacement after the stop')
  assertEq(tokensSeenByChildren(ctx).length, 1, 'no second computer was ever spawned')
})

// --- quit: a graceful stop is never cut shorter than the computer's own deadline
// Production timing on purpose (no stopSigtermGraceMs override): what is pinned is
// how the real grace and the quit's real wait line up with the computer's deadline.

function exitCodeIn(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

test('quit: a computer whose stop takes ~4s exits by itself, cleanly — never SIGKILLed early', async () => {
  // Past the 3s grace this used to be SIGKILLed at, inside the computer's own 5s
  // deadline: its pty disposal and hub-socket close must get to finish.
  const exitFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-exit-')), 'exit')
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_STOP_MS: '4000', FAKE_EXIT_FILE: exitFile },
    { backoffMs: [10_000], healthyResetMs: 60_000 }
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
    const started = Date.now()
    const result = await reapChildForQuit({
      stop: () => handle.stop(),
      timeoutMs: QUIT_CHILD_REAP_MS
    })
    assertEq(result, 'stopped', 'the quit saw the computer gone')
    assert(Date.now() - started >= 3_900, 'it really took its ~4s')
    assertEq(exitCodeIn(exitFile), '0', 'exit 0, not SIGKILL')
  } finally {
    await handle.stop()
  }
})

test('quit: a stuck computer is still SIGKILLed — after its own deadline, inside the quit’s wait', async () => {
  const exitFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-exit-')), 'exit')
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_IGNORE_SIGTERM: '1', FAKE_EXIT_FILE: exitFile },
    { backoffMs: [10_000], healthyResetMs: 60_000 }
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
    const pid = handle.getPid()!
    const started = Date.now()
    const result = await reapChildForQuit({
      stop: () => handle.stop(),
      timeoutMs: QUIT_CHILD_REAP_MS
    })
    const elapsed = Date.now() - started
    assertEq(result, 'stopped', `the quit saw the computer gone, not a timeout (${elapsed}ms)`)
    assert(pidGone(pid), 'the stuck computer is gone')
    assertEq(exitCodeIn(exitFile), null, 'it was SIGKILLed: no exit of its own')
    assert(elapsed >= SUPERVISED_STOP_DEADLINE_MS, `not before its own deadline (${elapsed}ms)`)
  } finally {
    await handle.stop()
  }
})

test('restart: keeps its short grace — the replacement waits on the outgoing computer', async () => {
  // The app stays up, so nothing can be orphaned and nothing finishes "after the
  // app": a slow stop only delays the computer the user is waiting for (it needs the
  // same computer id). The 3s grace is unchanged. Only the stop is shortened (the
  // cleanup below).
  const { handle, ctx } = makeHarness(
    { FAKE_STAY_ALIVE: '1', FAKE_IGNORE_SIGTERM: '1' },
    { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 300 }
  )
  try {
    await waitFor(() => tokensSeenByChildren(ctx).length === 1, 15_000, 'computer spawned')
    const started = Date.now()
    await handle.restart()
    const elapsed = Date.now() - started
    assert(
      elapsed >= 2_900 && elapsed < SUPERVISED_STOP_DEADLINE_MS,
      `SIGKILL at 3s (${elapsed}ms)`
    )
  } finally {
    await handle.stop()
  }
})

// --- parent death: the REAL built computer -----------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const COMPUTER_DIR = path.resolve(HERE, '../../..', 'computer')
const COMPUTER_BIN = path.join(COMPUTER_DIR, 'dist', 'bin.cjs')
/** The parent watch the computer bundles. Shared with the hub, so it lives outside computer/src. */
const PLATFORM_SRC = path.resolve(HERE, '../../../..', 'shared/platform/src')
const SUPERVISOR_MODULE = path.join(HERE, 'local-computer-supervisor.ts')
/** Must cover the computer's own SUPERVISED_STOP_DEADLINE_MS (5s) plus boot + reap. */
const REAL_EXIT_BUDGET_MS = 12_000
/**
 * The real computer is fully up: logged from an async boot step, so the synchronous
 * part of its main() — signal handlers and parent watch included — has run. (An
 * earlier line can precede the SIGTERM handler, and a SIGTERM there just kills it.)
 */
const COMPUTER_BOOTED = 'agent-hook loopback relay listening'

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs)
  }
  return newest
}

/** The supervisor runs dist/bin.cjs, so that is what is tested: (re)built when older than src. */
let computerBuildChecked = false
function ensureComputerBuilt(): void {
  if (computerBuildChecked) return
  const stale =
    !fs.existsSync(COMPUTER_BIN) ||
    Math.max(newestMtime(path.join(COMPUTER_DIR, 'src')), newestMtime(PLATFORM_SRC)) >
      fs.statSync(COMPUTER_BIN).mtimeMs
  if (stale) {
    console.log('  … building the computer bundle (missing or older than its src)')
    execFileSync('node', ['build.mjs'], { cwd: COMPUTER_DIR, stdio: 'inherit' })
  }
  computerBuildChecked = true
}

/**
 * Preloaded into the real computer (NODE_OPTIONS=--require). Once its app is dead
 * nothing reads the computer's stdout, so it is mirrored to a file; and the exit
 * code is recorded: 0 = a clean stop, anything else = a crash or a forced exit.
 */
const COMPUTER_PROBE = `'use strict'
const fs = require('node:fs')
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, ...rest) {
  try { fs.appendFileSync(process.env.PROBE_LOG_FILE, chunk) } catch (e) {}
  return write(chunk, ...rest)
}
process.on('exit', function (code) {
  try { fs.writeFileSync(process.env.PROBE_EXIT_FILE, String(code)) } catch (e) {}
})
// The d468275b5 class: a handle that keeps a stopping computer's loop alive forever.
if (process.env.PROBE_LEAK === '1') setInterval(function () {}, 60000)
`

/**
 * The desktop app, reduced to its supervisor: the REAL `startLocalComputer`, so the
 * computer is spawned exactly as the app spawns it. On SIGTERM it "quits" the way
 * the app used to: fire-and-forget `stop()`, then exit before the supervisor's
 * SIGTERM→SIGKILL escalation can land.
 */
const FAKE_APP = `import { startLocalComputer } from '${pathToFileURL(SUPERVISOR_MODULE).href}'
const handle = startLocalComputer({
  execPath: process.execPath,
  scriptPath: process.env.FAKE_APP_COMPUTER_BIN as string,
  env: JSON.parse(process.env.FAKE_APP_COMPUTER_ENV as string),
  logger: (line: string) => process.stdout.write(line + '\\n')
})
process.on('SIGTERM', () => {
  handle.suspendRestarts()
  void handle.stop()
  setTimeout(() => process.exit(0), 500)
})
setInterval(() => {}, 1 << 30)
`

/**
 * A bare parent that spawns the computer with a chosen stdio shape — for the cases
 * the real supervisor never produces: a standalone computer logging to a file, and
 * a stdin whose other end someone else holds (FAKE_PARENT_STDIN_PORT: a socket to
 * a server in the test process), which the parent's death does not close — only
 * the ppid poll can tell.
 */
const FAKE_PARENT = `'use strict'
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const out = fs.openSync(process.env.FAKE_PARENT_OUT, 'a')
function start(stdin) {
  const c = spawn(process.execPath, [process.env.FAKE_APP_COMPUTER_BIN], {
    env: Object.assign(JSON.parse(process.env.FAKE_APP_COMPUTER_ENV), { ELECTRON_RUN_AS_NODE: '1' }),
    stdio: [stdin, out, out]
  })
  process.stdout.write('[fake-parent] spawned pid=' + c.pid + '\\n')
}
const port = Number(process.env.FAKE_PARENT_STDIN_PORT || '0')
if (port) {
  const sock = net.connect(port, '127.0.0.1', function () { start(sock) })
} else {
  start('pipe')
}
setInterval(function () {}, 1 << 30)
`

/**
 * A server that accepts connections, holds them open and never answers.
 *
 * As the computer's hub: the computer sits in its handshake, QUIET — like a
 * computer idling on a healthy hub, and unlike one in a reconnect loop, whose next
 * log line would hit the dead app's stdout pipe and crash it (EPIPE), hiding an
 * orphan behind an accidental exit.
 *
 * As the far end of the computer's stdin: an end this test process holds, so the
 * parent's death cannot close it.
 */
async function startSilentServer(): Promise<{ port: number; close: () => void }> {
  const sockets: net.Socket[] = []
  const server = net.createServer((s) => {
    s.on('error', () => {})
    sockets.push(s)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    }
  }
}

/** Every SLAYZONE_ and ELECTRON_ var stripped: a supervised test runner leaks the real root. */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k) || k === 'NODE_OPTIONS') continue
    out[k] = v
  }
  return out
}

type RealComputerRun = {
  /** The process the computer believes is its app. */
  parent: ChildProcess
  computerPid: number
  /** The computer's own stdout so far (mirrored by the probe). */
  log: () => string
  /** The computer's exit code, once it has exited on its own (null otherwise). */
  exitCode: () => string | null
  cleanup: () => void
}

async function startRealComputer(opts: {
  parent: 'supervisor' | 'stdin-held-elsewhere' | 'standalone'
  supervised: boolean
  leak?: boolean
}): Promise<RealComputerRun> {
  ensureComputerBuilt()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-parent-death-'))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'home'))
  fs.mkdirSync(path.join(dir, 'root'))
  const probe = path.join(dir, 'probe.cjs')
  fs.writeFileSync(probe, COMPUTER_PROBE)
  const logFile = path.join(dir, 'computer.log')
  const exitFile = path.join(dir, 'computer.exit')
  const hub = await startSilentServer()
  const stdinHolder = opts.parent === 'stdin-held-elsewhere' ? await startSilentServer() : null
  const computerEnv: Record<string, string> = {
    ...scrubbedEnv(),
    // Isolated: the computer's state, credentials and path-jail all live in `dir`.
    HOME: path.join(dir, 'home'),
    SLAYZONE_ROOT: path.join(dir, 'root'),
    SLAYZONE_HUB_ADDRESS: `127.0.0.1:${hub.port}`,
    SLAYZONE_HUB_JOIN_TOKEN: 'parent-death-test',
    SLAYZONE_NONINTERACTIVE: '1',
    ...(opts.supervised ? { SLAYZONE_SUPERVISED: '1' } : {}),
    NODE_OPTIONS: `--require ${probe}`,
    PROBE_LOG_FILE: logFile,
    PROBE_EXIT_FILE: exitFile,
    ...(opts.leak ? { PROBE_LEAK: '1' } : {})
  }
  const parentEnv: Record<string, string> = {
    ...scrubbedEnv(),
    ELECTRON_RUN_AS_NODE: '1',
    FAKE_APP_COMPUTER_BIN: COMPUTER_BIN,
    FAKE_APP_COMPUTER_ENV: JSON.stringify(computerEnv)
  }
  let parent: ChildProcess
  if (opts.parent === 'supervisor') {
    const script = path.join(dir, 'fake-app.mts')
    fs.writeFileSync(script, FAKE_APP)
    parent = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), script], {
      env: parentEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } else {
    const script = path.join(dir, 'fake-parent.cjs')
    fs.writeFileSync(script, FAKE_PARENT)
    parent = spawn(process.execPath, [script], {
      env: {
        ...parentEnv,
        FAKE_PARENT_OUT: path.join(dir, 'computer.out'),
        ...(stdinHolder ? { FAKE_PARENT_STDIN_PORT: String(stdinHolder.port) } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }
  let parentOut = ''
  parent.stdout?.on('data', (c: Buffer) => (parentOut += c.toString()))
  parent.stderr?.on('data', (c: Buffer) => (parentOut += c.toString()))

  const read = (file: string): string => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  }
  let computerPid = 0
  const cleanup = (): void => {
    for (const pid of [computerPid, parent.pid]) {
      if (pid && !pidGone(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    parent.stdin?.destroy()
    hub.close()
    stdinHolder?.close()
  }
  try {
    await waitFor(
      () => /spawned pid=\d+/.test(parentOut),
      20_000,
      `parent never spawned the computer — output: ${parentOut}`
    )
    computerPid = Number(/spawned pid=(\d+)/.exec(parentOut)![1])
    await waitFor(
      () => read(logFile).includes(COMPUTER_BOOTED),
      20_000,
      `computer never booted — log: ${read(logFile)} ${read(path.join(dir, 'computer.out'))} parent: ${parentOut}`
    )
  } catch (err) {
    cleanup()
    throw err
  }
  return {
    parent,
    computerPid,
    log: () => read(logFile),
    exitCode: () => (fs.existsSync(exitFile) ? read(exitFile) : null),
    cleanup
  }
}

/** {@link waitFor}, but a timeout carries the computer's log as it is THEN. */
async function waitForRun(
  run: RealComputerRun,
  cond: () => boolean,
  timeoutMs: number,
  msg: string
): Promise<void> {
  await waitFor(cond, timeoutMs, msg).catch((err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} — log:\n${run.log()}`)
  })
}

test('parent-death: a SIGKILLed app takes its supervised computer with it, cleanly', async () => {
  const run = await startRealComputer({ parent: 'supervisor', supervised: true })
  try {
    // No false positive while the app lives: longer than one parent poll.
    await delay(1_500)
    assert(!pidGone(run.computerPid), 'the computer runs while its app is alive')
    run.parent.kill('SIGKILL')
    await waitForRun(
      run,
      () => pidGone(run.computerPid),
      REAL_EXIT_BUDGET_MS,
      'computer outlived its SIGKILLed app'
    )
    // 0, not 1: a clean stop that disposed its ptys, not a crash on the first
    // write to the dead app's stdout pipe.
    assertEq(run.exitCode(), '0', `the computer stopped cleanly — log:\n${run.log()}`)
    assert(
      /parent app is gone \(parent-(pipe-closed|output-closed|reparented|exited)\)/.test(run.log()),
      `the computer said why it stopped — log:\n${run.log()}`
    )
  } finally {
    run.cleanup()
  }
})

test('parent-death: an app that quits without waiting cannot orphan a computer whose stop hangs', async () => {
  // The reported orphan, end to end: the app SIGTERMs its computer and exits
  // before the supervisor's SIGKILL escalation; the computer's stop never lets its loop
  // drain (a leaked handle). Nothing is left to SIGKILL it — it must end itself.
  const run = await startRealComputer({ parent: 'supervisor', supervised: true, leak: true })
  try {
    run.parent.kill('SIGTERM')
    await waitForRun(
      run,
      () => run.log().includes('received SIGTERM'),
      10_000,
      "the computer never got the app's SIGTERM"
    )
    await waitForRun(
      run,
      () => pidGone(run.computerPid),
      REAL_EXIT_BUDGET_MS,
      'a stuck computer outlived the app that quit on it'
    )
  } finally {
    run.cleanup()
  }
})

test('parent-death: a SIGKILLed app is noticed even when stdin is held open elsewhere', async () => {
  // Only the ppid/liveness poll can see this one: the stdin pipe outlives the app.
  const run = await startRealComputer({ parent: 'stdin-held-elsewhere', supervised: true })
  try {
    run.parent.kill('SIGKILL')
    await waitForRun(
      run,
      () => pidGone(run.computerPid),
      REAL_EXIT_BUDGET_MS,
      'computer outlived its app with stdin still open'
    )
    assert(
      /parent app is gone \(parent-(reparented|exited)\)/.test(run.log()),
      `the parent poll noticed — log:\n${run.log()}`
    )
  } finally {
    run.cleanup()
  }
})

test('parent-death: a standalone computer ignores its parent dying', async () => {
  // `slay computer`, a launchd/systemd unit, a shell: no app owns it, and a closed
  // stdin or a reparent means nothing. It must keep serving.
  const run = await startRealComputer({ parent: 'standalone', supervised: false })
  try {
    run.parent.kill('SIGKILL')
    await delay(4_000) // several parent polls (1s each)
    assert(!pidGone(run.computerPid), `a standalone computer stopped — log:\n${run.log()}`)
    assert(!run.log().includes('parent app is gone'), 'it never watched its parent')
  } finally {
    run.cleanup()
  }
})

test('stop: the real supervised computer still exits on its own when its app stops it', async () => {
  // The parent watch must never hold the computer's loop: a SIGTERMed computer
  // exits by itself (code 0), not by the supervisor's SIGKILL.
  ensureComputerBuilt()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-computer-real-stop-'))
  tmpDirs.push(dir)
  fs.mkdirSync(path.join(dir, 'home'))
  fs.mkdirSync(path.join(dir, 'root'))
  const probe = path.join(dir, 'probe.cjs')
  fs.writeFileSync(probe, COMPUTER_PROBE)
  const logFile = path.join(dir, 'computer.log')
  const exitFile = path.join(dir, 'computer.exit')
  const hub = await startSilentServer()
  const handle = startLocalComputer({
    execPath: process.execPath,
    scriptPath: COMPUTER_BIN,
    env: {
      ...scrubbedEnv(),
      HOME: path.join(dir, 'home'),
      SLAYZONE_ROOT: path.join(dir, 'root'),
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${hub.port}`,
      SLAYZONE_HUB_JOIN_TOKEN: 'parent-death-test',
      SLAYZONE_SUPERVISED: '1',
      NODE_OPTIONS: `--require ${probe}`,
      PROBE_LOG_FILE: logFile,
      PROBE_EXIT_FILE: exitFile
    },
    logger: () => {},
    timing: { backoffMs: [10_000], healthyResetMs: 60_000, stopSigtermGraceMs: 3_000 }
  })
  try {
    await waitFor(
      () => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes(COMPUTER_BOOTED),
      20_000,
      'real computer booted'
    )
    const started = Date.now()
    await handle.stop()
    assertEq(
      fs.existsSync(exitFile) ? fs.readFileSync(exitFile, 'utf8') : null,
      '0',
      `the computer exited by itself, cleanly — not SIGKILLed after the grace — log:\n${fs.readFileSync(logFile, 'utf8')}`
    )
    assert(Date.now() - started < 3_000, 'well inside the SIGTERM grace')
  } finally {
    await handle.stop()
    hub.close()
  }
})

// --- computer ---------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0
  let failed = 0
  console.log('\n=== local-computer-supervisor exit reporting + manual restart ===\n')
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

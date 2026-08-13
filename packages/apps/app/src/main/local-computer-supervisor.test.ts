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
 * Driven against a controllable fake computer script so exit codes, output tails
 * and backoff exhaustion are deterministic and fast. Timing constants are
 * shrunk through the additive `opts.timing` override (defaults unchanged in
 * production).
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm \
 *     packages/apps/app/src/main/local-computer-supervisor.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
// Echoed so a test can see WHICH join token this particular spawn was handed —
// that is how the re-mint on restart is observed from outside.
process.stdout.write('fake-computer token=' + (process.env.SLAYZONE_HUB_JOIN_TOKEN || '') + '\\n')
for (let i = 1; i <= lines; i++) process.stderr.write('computer-line-' + i + '\\n')
process.stdout.write('fake-computer bye\\n')
if (process.env.FAKE_STAY_ALIVE === '1') {
  // A long-lived computer, like the real one: only a signal ends it. SIGTERM is
  // handled explicitly so the supervisor's graceful-stop path is exercised
  // rather than its SIGKILL fallback.
  process.on('SIGTERM', function () { process.exit(0) })
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

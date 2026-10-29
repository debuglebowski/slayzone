/**
 * Event-loop stall detector: a frozen main thread must be reported AFTER it
 * thaws, with enough evidence to name the cause. Pure Node → runs under plain
 * `npx tsx`.
 *
 * The three shapes of freeze, each with the evidence that identifies it:
 *   - busy JavaScript            → stack samples name the function; the main
 *                                  thread burned CPU the whole time
 *   - many short blocking calls  → stack samples name the caller between calls
 *   - one long blocking call     → no JS runs until it returns, so no stack can
 *                                  be taken mid-freeze — the child-process
 *                                  snapshot names what the thread is waiting on
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/event-loop-stall.test.ts
 */
import { beforeAll, describe, expect, test } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type EventLoopStall, startEventLoopStallDetector } from './event-loop-stall'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function busyFreezeForTest(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Spinning on the main thread, like a CPU-heavy synchronous handler.
  }
}

/**
 * Run `fn` on this (the main) thread, measuring for ourselves — independently of
 * the detector — the CPU this thread burned and the wall time it took.
 */
function measuredOnThisThread(fn: () => void): { cpuMs: number; wallMs: number } {
  const cpuBefore = process.threadCpuUsage()
  const wallBefore = performance.now()
  fn()
  const wallMs = performance.now() - wallBefore
  const cpu = process.threadCpuUsage(cpuBefore)
  return { cpuMs: (cpu.user + cpu.system) / 1000, wallMs }
}
function oneGitLikeCall(): void {
  spawnSync('sleep', ['0.3'])
}
function manyBlockingCallsForTest(): void {
  for (let i = 0; i < 6; i++) oneGitLikeCall()
}

/** How the one long blocking call's child shows in a process listing. */
const BLOCKING_CALL = 'one-long-blocking-call'
/**
 * One long blocking call: the main thread waits on a single child for the whole freeze.
 * The child lasts 1.6s (well past the 500ms threshold + one tick, so the freeze is
 * reported) and then until a child snapshot has SEEN it: `seen` appears once the
 * watcher's `ps` has read a process table holding this child (see {@link withFakePs}).
 * A bare `sleep 1.6` left that to the clock: on a loaded box its only snapshot read the
 * table as the sleep was exiting, and named just `(sleep)`. Bounded (20s), so a watcher
 * that never snapshots cannot hang the suite.
 */
function oneLongBlockingCallForTest(seen: string): void {
  spawnSync(
    '/bin/sh',
    ['-c', 'sleep 1.6; until [ -e "$1" ]; do sleep 0.05; done', BLOCKING_CALL, seen],
    { timeout: 20_000 }
  )
}

/**
 * Run `run` with a fake `ps` first on PATH, which the watcher thread inherits when the
 * detector starts it. The fake reads the REAL process table at once; if that table
 * holds the blocking call (matched by its `seen` path, unique to this run), it creates
 * `seen`, the call's cue to return; then it runs `beforeReply(dir)` (shell) and only
 * then prints the table.
 */
async function withFakePs<T>(
  beforeReply: (dir: string) => string,
  run: (paths: { dir: string; seen: string }) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'fake-ps-'))
  const fake = join(dir, 'ps')
  const seen = join(dir, 'seen')
  writeFileSync(
    fake,
    `#!/bin/sh\nout=$(/bin/ps "$@")\ncase "$out" in *'${seen}'*) : > '${seen}' ;; esac\n${beforeReply(dir)}printf '%s\\n' "$out"\n`
  )
  chmodSync(fake, 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = `${dir}:${savedPath}`
  try {
    return await run({ dir, seen })
  } finally {
    process.env.PATH = savedPath
  }
}

/**
 * Run `freeze` under a fresh detector and return what it reported.
 *
 * A report has no fixed time after the thaw: when a child snapshot taken mid-freeze is
 * still running, the detector holds the report for it, for up to its grace window
 * (300ms) + `psTimeoutMs`, and `stop()` cancels a held report. So this waits for the
 * report itself, up to that bound plus slack. A fixed 1.2s wait stopped the detector
 * before its report on a loaded box, where the snapshot taken just before the thaw ran
 * long: the freeze went unreported, failing every check on it.
 */
async function observe(
  freeze: () => void,
  { psTimeoutMs = 2_000 }: { psTimeoutMs?: number } = {}
): Promise<EventLoopStall[]> {
  const stalls: EventLoopStall[] = []
  const detector = startEventLoopStallDetector({
    thresholdMs: 500,
    psTimeoutMs,
    onStall: (s) => stalls.push(s)
  })
  // Let the watcher thread boot and the heartbeat settle first.
  await sleep(400)
  freeze()
  const deadline = Date.now() + psTimeoutMs + 1_000
  while (stalls.length === 0 && Date.now() < deadline) await sleep(25)
  // Listen on past the first report: a second one fails the "reported once" checks.
  if (stalls.length > 0) await sleep(1_000)
  detector.stop()
  return stalls
}

const stackText = (s: EventLoopStall): string =>
  s.stacks.map((x) => x.frames.join(' < ')).join(' | ')
const childText = (s: EventLoopStall): string =>
  s.children.flatMap((x) => x.processes.map((p) => p.command)).join(' | ')

// --- nothing frozen → nothing reported ---
describe('nothing frozen → nothing reported', () => {
  let stalls: EventLoopStall[] = []
  beforeAll(async () => {
    stalls = await observe(() => undefined)
  })

  test('an idle event loop reports no stall', () => {
    expect(stalls.length, JSON.stringify(stalls)).toBe(0)
  })
})

// --- busy JavaScript ---
describe('busy JavaScript', () => {
  let stalls: EventLoopStall[] = []
  let s: EventLoopStall | undefined
  let spin = { cpuMs: 0, wallMs: 0 }
  beforeAll(async () => {
    stalls = await observe(() => {
      spin = measuredOnThisThread(() => busyFreezeForTest(1500))
    })
    s = stalls[0]
  })

  test('a busy freeze is reported once', () => {
    expect(stalls.length, `count=${stalls.length}`).toBe(1)
  })

  test('its duration covers the freeze', () => {
    expect(s, 'no stall').toBeDefined()
    expect(s!.durationMs).toBeGreaterThanOrEqual(1300)
    expect(s!.durationMs).toBeLessThan(3000)
  })

  test('a stack sample names the spinning function', () => {
    expect(s, 'no stall').toBeDefined()
    expect(stackText(s!)).toContain('busyFreezeForTest')
  })
  // What tells BUSY from WAITING in a report is `mainThreadCpuMs`: the CPU the
  // main thread really burned over the freeze. How much a spinning thread gets is
  // the scheduler's call, not the detector's — ~100% of the wall clock on an idle
  // machine, a quarter of it with the unit suites oversubscribing every core — so
  // the report is held to the spin's OWN CPU, measured on the spinning thread
  // itself, not to a share of wall clock. The contrast is the waiting freeze
  // below, which burns almost nothing.
  test('mainThreadCpuMs is the CPU the spinning main thread burned (busy, not waiting)', () => {
    expect(s, 'no stall').toBeDefined()
    expect(s!.mainThreadCpuMs, 'mainThreadCpuMs').not.toBeNull()
    const cpuMs = s!.mainThreadCpuMs!
    const detail =
      `mainThreadCpuMs=${cpuMs} durationMs=${s!.durationMs} ` +
      `spin: cpu=${spin.cpuMs.toFixed(1)}ms wall=${spin.wallMs.toFixed(1)}ms`
    expect(spin.cpuMs, `the spin burned CPU at all (${detail})`).toBeGreaterThan(0)
    // The freeze window encloses the spin, so it holds all of the spin's CPU
    // (−1: the report rounds to whole ms)...
    expect(cpuMs, `covers the spin's CPU (${detail})`).toBeGreaterThanOrEqual(spin.cpuMs - 1)
    // ...and on top at most the wall time the window adds around the spin: one
    // thread cannot burn more CPU than wall time (+5: rounding, clock granularity).
    expect(cpuMs, `only this thread's CPU, in ms (${detail})`).toBeLessThanOrEqual(
      spin.cpuMs + (s!.durationMs - spin.wallMs) + 5
    )
  })

  test('machine CPU and GC time are reported as numbers', () => {
    expect(s, 'no stall').toBeDefined()
    expect(typeof s!.gcMs, 'gcMs').toBe('number')
    const pct = s!.machineCpuBusyPct
    if (pct !== null) {
      expect(pct, 'machineCpuBusyPct').toBeGreaterThanOrEqual(0)
      expect(pct, 'machineCpuBusyPct').toBeLessThanOrEqual(100)
    }
  })
})

// --- many short blocking calls (the suspected git pattern) ---
describe('many short blocking calls (the suspected git pattern)', () => {
  let stalls: EventLoopStall[] = []
  let s: EventLoopStall | undefined
  beforeAll(async () => {
    stalls = await observe(manyBlockingCallsForTest)
    s = stalls[0]
  })

  test('a freeze made of blocking calls is reported', () => {
    expect(stalls.length, `count=${stalls.length}`).toBe(1)
  })

  test('a stack sample names the caller between the calls', () => {
    expect(s, 'no stall').toBeDefined()
    expect(stackText(s!)).toContain('manyBlockingCallsForTest')
  })

  test('the main thread mostly WAITED (almost no CPU), unlike a busy freeze', () => {
    expect(s, 'no stall').toBeDefined()
    expect(s!.mainThreadCpuMs, 'mainThreadCpuMs').not.toBeNull()
    expect(
      s!.mainThreadCpuMs!,
      `mainThreadCpuMs=${s?.mainThreadCpuMs} durationMs=${s?.durationMs}`
    ).toBeLessThan(0.15 * s!.durationMs)
  })
})

// --- one long blocking call ---
// No child snapshots on Windows (the detector has no `ps` there), nor a /bin/sh.
describe('one long blocking call', () => {
  let stalls: EventLoopStall[] = []
  let s: EventLoopStall | undefined
  beforeAll(async () => {
    if (process.platform === 'win32') return
    stalls = await withFakePs(
      () => '',
      ({ seen }) => observe(() => oneLongBlockingCallForTest(seen))
    )
    s = stalls[0]
  })

  test.skipIf(process.platform === 'win32')('a single long blocking call is reported', () => {
    expect(stalls.length, `count=${stalls.length}`).toBe(1)
  })

  test.skipIf(process.platform === 'win32')(
    'the child-process snapshot names what the thread was waiting on',
    () => {
      expect(s, 'no stall').toBeDefined()
      expect(childText(s!)).toContain(BLOCKING_CALL)
    }
  )
})

// --- one long blocking call, on a loaded machine (slow `ps`) ---
describe('one long blocking call, when the child snapshot is slow to return', () => {
  // On a loaded box `ps` reads the process table during the freeze but its output
  // lands after the thaw. That snapshot is still evidence from the freeze: it must
  // not be dropped for arriving late. The fake `ps` snapshots at once and replies 1s
  // after the thaw, past the report grace window. Timed off the thaw itself (a
  // marker written the moment the freeze returns), not a fixed sleep, and under a
  // generous `ps` cap: a fixed sleep against the default 2s cap left ~0.4s of slack
  // and failed on a loaded box.
  let stalls: EventLoopStall[] = []
  let s: EventLoopStall | undefined
  beforeAll(async () => {
    if (process.platform === 'win32') return
    stalls = await withFakePs(
      // Bounded wait (10s): a stuck fake must not outlive the suite.
      (dir) =>
        `i=0\nwhile [ ! -e '${join(dir, 'thawed')}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done\nsleep 1\n`,
      ({ dir, seen }) =>
        observe(
          () => {
            oneLongBlockingCallForTest(seen)
            writeFileSync(join(dir, 'thawed'), '')
          },
          { psTimeoutMs: 30_000 }
        )
    )
    s = stalls[0]
  })

  test.skipIf(process.platform === 'win32')('a late snapshot still names the blocking call', () => {
    expect(stalls.length, `count=${stalls.length}`).toBe(1)
    expect(childText(s!)).toContain(BLOCKING_CALL)
  })
})

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
 * Run with: npx tsx packages/shared/platform/src/event-loop-stall.test.ts
 */
import { spawnSync } from 'node:child_process'
import { type EventLoopStall, startEventLoopStallDetector } from './event-loop-stall'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function busyFreezeForTest(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // Spinning on the main thread, like a CPU-heavy synchronous handler.
  }
}
function oneGitLikeCall(): void {
  spawnSync('sleep', ['0.3'])
}
function manyBlockingCallsForTest(): void {
  for (let i = 0; i < 6; i++) oneGitLikeCall()
}
function oneLongBlockingCallForTest(): void {
  spawnSync('sleep', ['1.6'])
}

/** Run `freeze` under a fresh detector and return what it reported. */
async function observe(freeze: () => void): Promise<EventLoopStall[]> {
  const stalls: EventLoopStall[] = []
  const detector = startEventLoopStallDetector({
    thresholdMs: 500,
    onStall: (s) => stalls.push(s)
  })
  // Let the watcher thread boot and the heartbeat settle first.
  await sleep(400)
  freeze()
  // Past the report grace window.
  await sleep(1200)
  detector.stop()
  return stalls
}

const stackText = (s: EventLoopStall): string =>
  s.stacks.map((x) => x.frames.join(' < ')).join(' | ')
const childText = (s: EventLoopStall): string =>
  s.children.flatMap((x) => x.processes.map((p) => p.command)).join(' | ')

async function main(): Promise<void> {
  // --- nothing frozen → nothing reported ---
  {
    const stalls = await observe(() => undefined)
    check('an idle event loop reports no stall', stalls.length === 0, JSON.stringify(stalls))
  }

  // --- busy JavaScript ---
  {
    const stalls = await observe(() => busyFreezeForTest(1500))
    const s = stalls[0]
    check('a busy freeze is reported once', stalls.length === 1, `count=${stalls.length}`)
    check(
      'its duration covers the freeze',
      !!s && s.durationMs >= 1300 && s.durationMs < 3000,
      `durationMs=${s?.durationMs}`
    )
    check(
      'a stack sample names the spinning function',
      !!s && stackText(s).includes('busyFreezeForTest'),
      s ? stackText(s) : 'no stall'
    )
    // Not ~100%: on a saturated machine the OS deschedules even a spinning thread
    // (that is what `machineCpuBusyPct` shows). The signal is the CONTRAST with a
    // waiting thread below, which burns almost nothing.
    check(
      'the main thread burned CPU for a large share of it (busy, not waiting)',
      !!s && s.mainThreadCpuMs !== null && s.mainThreadCpuMs >= 0.3 * s.durationMs,
      `mainThreadCpuMs=${s?.mainThreadCpuMs} durationMs=${s?.durationMs}`
    )
    check(
      'machine CPU and GC time are reported as numbers',
      !!s &&
        typeof s.gcMs === 'number' &&
        (s.machineCpuBusyPct === null || (s.machineCpuBusyPct >= 0 && s.machineCpuBusyPct <= 100)),
      `gcMs=${s?.gcMs} machineCpuBusyPct=${s?.machineCpuBusyPct}`
    )
  }

  // --- many short blocking calls (the suspected git pattern) ---
  {
    const stalls = await observe(manyBlockingCallsForTest)
    const s = stalls[0]
    check(
      'a freeze made of blocking calls is reported',
      stalls.length === 1,
      `count=${stalls.length}`
    )
    check(
      'a stack sample names the caller between the calls',
      !!s && stackText(s).includes('manyBlockingCallsForTest'),
      s ? stackText(s) : 'no stall'
    )
    check(
      'the main thread mostly WAITED (almost no CPU), unlike a busy freeze',
      !!s && s.mainThreadCpuMs !== null && s.mainThreadCpuMs < 0.15 * s.durationMs,
      `mainThreadCpuMs=${s?.mainThreadCpuMs} durationMs=${s?.durationMs}`
    )
  }

  // --- one long blocking call ---
  {
    const stalls = await observe(oneLongBlockingCallForTest)
    const s = stalls[0]
    check('a single long blocking call is reported', stalls.length === 1, `count=${stalls.length}`)
    check(
      'the child-process snapshot names what the thread was waiting on',
      !!s && childText(s).includes('sleep 1.6'),
      s ? `children: ${childText(s)}` : 'no stall'
    )
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()

/**
 * Pre-init leg of the terminal mount trace (open-trace.ts): open requested →
 * Terminal mounted → init started.
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/open-trace.test.ts
 */
import {
  __resetOpenTraceForTest,
  noteTerminalMounted,
  takeOpenTrace,
  traceSessionOpen
} from './open-trace'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function ok(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

test('open → mount → init yields both legs, then is consumed', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 100)
  noteTerminalMounted('s', 700)
  const t = takeOpenTrace('s', 760)
  ok(t?.openToMountMs === 600 && t?.mountToInitMs === 60, `legs ${JSON.stringify(t)}`)
  ok(takeOpenTrace('s', 800) === null, 'one-shot')
})

test('mount without a traced open records nothing', () => {
  __resetOpenTraceForTest()
  noteTerminalMounted('s', 700)
  ok(takeOpenTrace('s', 760) === null, 'untraced')
})

test('init before a mount note: mount leg null, open leg covers all', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 100)
  const t = takeOpenTrace('s', 500)
  ok(t?.openToMountMs === null && t?.openToInitMs === 400, `legs ${JSON.stringify(t)}`)
})

test('remount keeps the FIRST mount time', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 0)
  noteTerminalMounted('s', 200)
  noteTerminalMounted('s', 900)
  ok(takeOpenTrace('s', 950)?.openToMountMs === 200, 'first mount wins')
})

test('stale open trace is dropped', () => {
  __resetOpenTraceForTest()
  traceSessionOpen('s', 0)
  ok(takeOpenTrace('s', 60_001) === null, 'expired')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)

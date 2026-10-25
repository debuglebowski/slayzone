/**
 * Tests for the client's stuck-in-`starting` watchdog verdict.
 * Run with: pnpm tsx packages/domains/terminal/src/client/starting-watchdog.test.ts
 */
import {
  startingWatchdogVerdict,
  STARTING_WATCHDOG_INTERVAL_MS,
  STARTING_WATCHDOG_MAX_WAIT_MS
} from './starting-watchdog'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${(e as Error).message}`)
    failed++
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

console.log('startingWatchdogVerdict')

// The bug this guards: during a workspace restore an agent can wait on its
// computer for an agent-start slot for longer than the watchdog interval. The
// backend still holds it, as `starting`; the old watchdog showed it as dead.
test('backend holds it live and starting (queued for a slot): keep waiting', () => {
  eq(
    startingWatchdogVerdict({
      exists: true,
      actual: 'starting',
      waitedMs: STARTING_WATCHDOG_INTERVAL_MS
    }),
    { kind: 'wait' },
    'verdict'
  )
})

test('backend moved on (a lost state event): adopt its state', () => {
  eq(
    startingWatchdogVerdict({ exists: true, actual: 'running', waitedMs: 20_000 }),
    { kind: 'adopt', state: 'running' },
    'verdict'
  )
})

test('backend no longer has it: dead', () => {
  eq(startingWatchdogVerdict({ exists: false, actual: null, waitedMs: 20_000 }), { kind: 'dead' }, 'gone')
  eq(
    startingWatchdogVerdict({ exists: false, actual: 'starting', waitedMs: 20_000 }),
    { kind: 'dead' },
    'not existing but starting'
  )
})

test('starting for implausibly long: dead (last-resort bound)', () => {
  eq(
    startingWatchdogVerdict({
      exists: true,
      actual: 'starting',
      waitedMs: STARTING_WATCHDOG_MAX_WAIT_MS
    }),
    { kind: 'dead' },
    'verdict'
  )
})

test('backend already reports dead: leave it to the exit event', () => {
  eq(startingWatchdogVerdict({ exists: true, actual: 'dead', waitedMs: 20_000 }), { kind: 'none' }, 'verdict')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

/**
 * Tests for StateMachine (terminal state transitions + debounce)
 * Run with: npx tsx packages/domains/terminal/src/main/state-machine.test.ts
 */
import {
  StateMachine,
  activityToTerminalState,
  shouldRefreshIdleClock,
  shouldFlipToIdle,
  shouldFlipToRunningOnInput,
} from './state-machine'
import type { TerminalState } from '@slayzone/terminal/shared'
import type { ActivityState } from './adapters/types'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

// Fake timers
let pendingTimers: { id: number; fn: () => void; delay: number; scheduledAt: number }[] = []
let now = 0
let nextId = 1
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

function useFakeTimers() {
  now = 0
  pendingTimers = []
  nextId = 1
  // @ts-expect-error — replacing global setTimeout with fake
  globalThis.setTimeout = (fn: () => void, delay: number) => {
    const id = nextId++
    pendingTimers.push({ id, fn, delay, scheduledAt: now })
    return id
  }
  // @ts-expect-error — replacing global clearTimeout with fake
  globalThis.clearTimeout = (id: number) => {
    pendingTimers = pendingTimers.filter(t => t.id !== id)
  }
}

function advanceTimersByTime(ms: number) {
  const target = now + ms
  while (true) {
    const next = pendingTimers
      .filter(t => t.scheduledAt + t.delay <= target)
      .sort((a, b) => (a.scheduledAt + a.delay) - (b.scheduledAt + b.delay))[0]
    if (!next) break
    now = next.scheduledAt + next.delay
    pendingTimers = pendingTimers.filter(t => t.id !== next.id)
    next.fn()
  }
  now = target
}

function useRealTimers() {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}

// --- Tests ---

console.log('\nStateMachine.transition\n')

test('running transition is immediate', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'idle')

  sm.transition('s1', 'running')

  expect(changes.length).toBe(1)
  expect(changes[0]).toEqual(['s1', 'running', 'idle'])
  expect(sm.getState('s1')).toBe('running')
  sm.dispose()
  useRealTimers()
})

test('non-running transition is debounced (not immediate)', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'idle')

  expect(changes.length).toBe(0)
  expect(sm.getState('s1')).toBe('running')
  sm.dispose()
  useRealTimers()
})

test('non-running transition fires at 100ms', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'idle')

  advanceTimersByTime(99)
  expect(changes.length).toBe(0)

  advanceTimersByTime(1)
  expect(changes.length).toBe(1)
  expect(changes[0]).toEqual(['s1', 'idle', 'running'])
  sm.dispose()
  useRealTimers()
})

test('pending non-running transition cancelled by running', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'idle')
  advanceTimersByTime(50)
  expect(changes.length).toBe(0)

  sm.transition('s1', 'running')
  expect(changes.length).toBe(0)
  expect(sm.getState('s1')).toBe('running')

  advanceTimersByTime(500)
  expect(changes.length).toBe(0)
  sm.dispose()
  useRealTimers()
})

test('same-state transition is no-op', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'running')
  advanceTimersByTime(1000)

  expect(changes.length).toBe(0)
  sm.dispose()
  useRealTimers()
})

test('error transition debounces at 100ms', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'error')

  advanceTimersByTime(99)
  expect(changes.length).toBe(0)

  advanceTimersByTime(1)
  expect(changes.length).toBe(1)
  expect(changes[0]).toEqual(['s1', 'error', 'running'])
  sm.dispose()
  useRealTimers()
})

test('dead transition debounces at 100ms', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'idle')

  sm.transition('s1', 'dead')

  advanceTimersByTime(99)
  expect(changes.length).toBe(0)

  advanceTimersByTime(1)
  expect(changes.length).toBe(1)
  expect(changes[0]).toEqual(['s1', 'dead', 'idle'])
  sm.dispose()
  useRealTimers()
})

test('unregistered session is no-op', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))

  sm.transition('nope', 'running')
  advanceTimersByTime(1000)

  expect(changes.length).toBe(0)
  sm.dispose()
  useRealTimers()
})

test('new transition replaces pending timer', () => {
  useFakeTimers()
  const changes: [string, TerminalState, TerminalState][] = []
  const sm = new StateMachine((id, n, o) => changes.push([id, n, o]))
  sm.register('s1', 'running')

  sm.transition('s1', 'idle')
  advanceTimersByTime(50)

  sm.transition('s1', 'error')
  advanceTimersByTime(100)

  expect(changes.length).toBe(1)
  expect(changes[0]).toEqual(['s1', 'error', 'running'])
  sm.dispose()
  useRealTimers()
})

console.log('\nactivityToTerminalState\n')

test('working → running', () => {
  expect(activityToTerminalState('working')).toBe('running')
})

test('idle → idle (explicit done-signal from adapter)', () => {
  expect(activityToTerminalState('idle')).toBe('idle')
})

test('unknown → null', () => {
  expect(activityToTerminalState('unknown')).toBe(null)
})

console.log('\nshouldRefreshIdleClock\n')

test('TUI default (undefined): refresh ONLY on detected working', () => {
  expect(shouldRefreshIdleClock({}, 'working')).toBe(true)
  expect(shouldRefreshIdleClock({}, 'idle')).toBe(false)
  expect(shouldRefreshIdleClock({}, null)).toBe(false)
})

test('TUI explicit (true): same as default', () => {
  expect(shouldRefreshIdleClock({ transitionOnInput: true }, 'working')).toBe(true)
  expect(shouldRefreshIdleClock({ transitionOnInput: true }, 'idle')).toBe(false)
  expect(shouldRefreshIdleClock({ transitionOnInput: true }, null)).toBe(false)
})

test('output-driven (false): refresh on EVERY chunk', () => {
  expect(shouldRefreshIdleClock({ transitionOnInput: false }, 'working')).toBe(true)
  expect(shouldRefreshIdleClock({ transitionOnInput: false }, 'idle')).toBe(true)
  expect(shouldRefreshIdleClock({ transitionOnInput: false }, null)).toBe(true)
})

test('TUI: explicit idle does NOT pin clock (timer fallback stays primed)', () => {
  // Active 'idle' is the primary done-signal, but if a later chunk's signal
  // is missed the silence timer must still be able to fire. So 'idle' must
  // NOT refresh lastOutputTime — same treatment as null.
  expect(shouldRefreshIdleClock({}, 'idle')).toBe(false)
})

console.log('\nshouldFlipToIdle\n')

test('flips when running and silent past timeout', () => {
  expect(shouldFlipToIdle('running', 0, 60_000, 60_000)).toBe(true)
  expect(shouldFlipToIdle('running', 0, 100_000, 60_000)).toBe(true)
})

test('does NOT flip when running but still inside window', () => {
  expect(shouldFlipToIdle('running', 0, 59_999, 60_000)).toBe(false)
})

test('does NOT flip when not running', () => {
  expect(shouldFlipToIdle('idle', 0, 100_000, 60_000)).toBe(false)
  expect(shouldFlipToIdle('starting', 0, 100_000, 60_000)).toBe(false)
  expect(shouldFlipToIdle('dead', 0, 100_000, 60_000)).toBe(false)
})

console.log('\nshouldFlipToRunningOnInput\n')

test('TUI default + non-empty input + not running → flip', () => {
  expect(shouldFlipToRunningOnInput({}, 'idle', 5)).toBe(true)
})

test('output-driven (false) → never flip on input', () => {
  expect(shouldFlipToRunningOnInput({ transitionOnInput: false }, 'idle', 5)).toBe(false)
})

test('empty input → no flip', () => {
  expect(shouldFlipToRunningOnInput({}, 'idle', 0)).toBe(false)
})

test('already running → no flip', () => {
  expect(shouldFlipToRunningOnInput({}, 'running', 5)).toBe(false)
})

console.log('\nIntegration: TUI redraw stream → idle flip\n')

/**
 * Regression test for the stuck-running bug. Simulates the chain:
 *   1. Adapter detects spinner once → state = 'running'
 *   2. Long stream of redraw chunks (cursor blink, status bar) — adapter
 *      returns null for each (no activity).
 *   3. After idle window passes, the inactivity checker MUST flip to 'idle'.
 *
 * If `shouldRefreshIdleClock` were to update the clock on every chunk
 * (the old buggy behavior on Claude/CCS/Qwen), the checker would never
 * flip and this test would loop forever — guarded by the assert.
 */
test('TUI default: redraw stream does NOT keep idle clock pinned open', () => {
  let lastOutputTime = 0
  const adapter = {} // default = TUI
  const idleTimeoutMs = 60_000

  // Step 1: spinner glyph chunk — adapter returns 'working'.
  const t0 = 1000
  if (shouldRefreshIdleClock(adapter, 'working')) lastOutputTime = t0
  expect(lastOutputTime).toBe(t0)

  // Step 2: 10 redraw chunks at 100ms intervals over 1 second — all return null.
  let now = t0
  for (let i = 0; i < 10; i++) {
    now += 100
    if (shouldRefreshIdleClock(adapter, null)) lastOutputTime = now
  }
  // Clock unchanged — stayed pinned at t0.
  expect(lastOutputTime).toBe(t0)

  // Step 3: jump just past the idle window from t0.
  now = t0 + idleTimeoutMs
  expect(shouldFlipToIdle('running', lastOutputTime, now, idleTimeoutMs)).toBe(true)
})

test('output-driven (false): redraw stream KEEPS idle clock fresh (legacy plain-shell behavior)', () => {
  let lastOutputTime = 0
  const adapter = { transitionOnInput: false }
  const idleTimeoutMs = 60_000

  const t0 = 1000
  if (shouldRefreshIdleClock(adapter, null)) lastOutputTime = t0
  expect(lastOutputTime).toBe(t0)

  let now = t0
  for (let i = 0; i < 10; i++) {
    now += 100
    if (shouldRefreshIdleClock(adapter, null)) lastOutputTime = now
  }
  // Clock kept refreshing — last update at t0 + 1000.
  expect(lastOutputTime).toBe(t0 + 1000)

  // Even at the "old" idle window from t0, clock isn't past timeout because
  // we kept refreshing.
  now = t0 + idleTimeoutMs
  expect(shouldFlipToIdle('running', lastOutputTime, now, idleTimeoutMs)).toBe(false)
})

// Quiet unused-var warnings on imports referenced only via type-narrowing in tests.
const _activitySanity: ActivityState = 'working'
void _activitySanity

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1

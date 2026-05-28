/**
 * Tests for the adaptive paint cadence used by Terminal.tsx.
 * Run with: pnpm tsx packages/domains/terminal/src/client/paint-throttle.test.ts
 */
import { decideThrottle, type ThrottleState } from './paint-throttle'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    failed++
  }
}

function expect<T>(actual: T): { toBe: (expected: T) => void } {
  return {
    toBe(expected: T): void {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

const OPTS = {
  slowDripThresholdMs: 500,
  floodBytesThreshold: 4096,
  floodEmaAlpha: 0.3,
  throttleSkipFrames: 2
}

const freshState = (overrides: Partial<ThrottleState> = {}): ThrottleState => ({
  lastActivityTime: 0,
  floodScore: 0,
  skipCounter: 0,
  ...overrides
})

test('active (recent activity) → never skip, regardless of byte size', () => {
  const now = 100
  const state = freshState({ lastActivityTime: now - 100 }) // 100ms ago, well under 500ms
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(false)
  expect(decision.nextSkipCounter).toBe(0)
})

test('slow-drip + small bytes → skip first frame', () => {
  const now = 1000
  const state = freshState({ lastActivityTime: now - 600 }) // > 500ms
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(true)
  expect(decision.nextSkipCounter).toBe(1)
})

test('slow-drip + small bytes, skipCounter at limit → paint (do not skip forever)', () => {
  const now = 1000
  const state = freshState({
    lastActivityTime: now - 600,
    skipCounter: 2 // already skipped THROTTLE_SKIP_FRAMES
  })
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(false)
  expect(decision.nextSkipCounter).toBe(0) // reset after paint
})

test('skip pattern over 6 frames yields 20fps cadence (2 paints per 6 frames at 60Hz)', () => {
  let state = freshState({ lastActivityTime: -10_000 }) // permanently slow-drip
  const paints: number[] = []
  for (let frame = 0; frame < 6; frame++) {
    // No new activity bump — keep lastActivityTime stale across all frames.
    const decision = decideThrottle(frame * 16.67, 50, state, OPTS)
    if (!decision.skip) paints.push(frame)
    state = {
      lastActivityTime: state.lastActivityTime, // unchanged — simulating no incoming data
      floodScore: decision.nextFloodScore,
      skipCounter: decision.nextSkipCounter
    }
  }
  // 6 frames at 60Hz = 100ms. Skip 2, paint 1 → frames 2 and 5.
  expect(paints.length).toBe(2)
  expect(paints[0]).toBe(2)
  expect(paints[1]).toBe(5)
})

test('large single chunk → bypass throttle even when slow-drip', () => {
  const now = 1000
  const state = freshState({ lastActivityTime: now - 600 })
  const decision = decideThrottle(now, 5000, state, OPTS) // > 4096
  expect(decision.skip).toBe(false)
})

test('high EMA floodScore → bypass throttle even with small current chunk', () => {
  const now = 1000
  const state = freshState({ lastActivityTime: now - 600, floodScore: 10_000 })
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(false)
})

test('EMA decays toward zero across small frames', () => {
  let score = 10_000
  for (let i = 0; i < 50; i++) {
    score = (1 - OPTS.floodEmaAlpha) * score + OPTS.floodEmaAlpha * 50
  }
  // After 50 frames of 50-byte chunks, EMA should be well under threshold.
  if (score > OPTS.floodBytesThreshold) {
    throw new Error(`EMA did not decay below threshold (got ${score})`)
  }
})

test('boundary: exactly slowDripThresholdMs is NOT slow-drip (strict >)', () => {
  const now = 500
  const state = freshState({ lastActivityTime: 0 }) // delta = 500 exactly
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(false)
})

test('boundary: 1ms past threshold IS slow-drip', () => {
  const now = 501
  const state = freshState({ lastActivityTime: 0 })
  const decision = decideThrottle(now, 50, state, OPTS)
  expect(decision.skip).toBe(true)
})

test('activity bump exits throttle immediately on next frame', () => {
  // Frame 1: slow-drip + small chunk → skip
  let state = freshState({ lastActivityTime: 0 })
  let decision = decideThrottle(600, 50, state, OPTS)
  expect(decision.skip).toBe(true)
  state = {
    lastActivityTime: state.lastActivityTime,
    floodScore: decision.nextFloodScore,
    skipCounter: decision.nextSkipCounter
  }
  // Frame 2: keystroke just landed → bump lastActivityTime to "now".
  state.lastActivityTime = 610
  decision = decideThrottle(616, 50, state, OPTS)
  expect(decision.skip).toBe(false)
  expect(decision.nextSkipCounter).toBe(0)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

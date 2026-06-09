/**
 * Tests for the pure idle-close engagement helpers (browser-panel / other-panel
 * interaction → keep the main agent's idle clock fresh).
 * Run with: npx tsx packages/domains/terminal/src/server/engagement.test.ts
 */
import {
  isEngagementInputType,
  shouldReportEngagement,
  ENGAGEMENT_TOUCH_THROTTLE_MS
} from './engagement'

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
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }
}

// --- isEngagementInputType -----------------------------------------------------
// Genuine engagement: typing, clicking, scrolling. Mirrors the terminal's own
// touch listener (keydown/mousedown/wheel) — NOT passive pointer motion, which
// would let mere hover defeat the throttle and pin every agent open forever.

test('engagement: keyDown counts', () => {
  expect(isEngagementInputType('keyDown')).toBe(true)
})

test('engagement: rawKeyDown counts', () => {
  expect(isEngagementInputType('rawKeyDown')).toBe(true)
})

test('engagement: mouseDown counts', () => {
  expect(isEngagementInputType('mouseDown')).toBe(true)
})

test('engagement: mouseWheel counts', () => {
  expect(isEngagementInputType('mouseWheel')).toBe(true)
})

test('engagement: mouseMove does NOT count (passive hover)', () => {
  expect(isEngagementInputType('mouseMove')).toBe(false)
})

test('engagement: keyUp does NOT count (redundant with keyDown)', () => {
  expect(isEngagementInputType('keyUp')).toBe(false)
})

test('engagement: mouseEnter does NOT count', () => {
  expect(isEngagementInputType('mouseEnter')).toBe(false)
})

test('engagement: unknown type does NOT count', () => {
  expect(isEngagementInputType('char')).toBe(false)
})

// --- shouldReportEngagement (throttle) -----------------------------------------
// Coalesce a burst of input into at most one touch per throttle window so a
// scrolling user doesn't flood the IPC / pty layer.

test('throttle: first ever report (lastReportAt 0, real clock) fires', () => {
  // lastReportAt starts at 0; a real `now` is a large epoch ms, so the very
  // first qualifying event is always far past the window → fires.
  expect(shouldReportEngagement(0, 50_000, ENGAGEMENT_TOUCH_THROTTLE_MS)).toBe(true)
})

test('throttle: inside the window is suppressed', () => {
  expect(shouldReportEngagement(1_000, 1_000 + ENGAGEMENT_TOUCH_THROTTLE_MS - 1, ENGAGEMENT_TOUCH_THROTTLE_MS)).toBe(
    false
  )
})

test('throttle: exactly at the window fires', () => {
  expect(shouldReportEngagement(1_000, 1_000 + ENGAGEMENT_TOUCH_THROTTLE_MS, ENGAGEMENT_TOUCH_THROTTLE_MS)).toBe(true)
})

test('throttle: well past the window fires', () => {
  expect(shouldReportEngagement(1_000, 99_000, ENGAGEMENT_TOUCH_THROTTLE_MS)).toBe(true)
})

test('throttle: window matches the terminal touch throttle (4s)', () => {
  expect(ENGAGEMENT_TOUCH_THROTTLE_MS).toBe(4000)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1

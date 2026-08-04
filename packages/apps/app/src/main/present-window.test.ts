/**
 * Tests for presentWindowWith — the hidden-window invariant under Playwright.
 *
 * This exists because the invariant was previously implicit: `tryShowMainWindow`
 * gated its own `show()` on `!isPlaywright`, and five other call sites raised
 * the window with no gate at all. Pinning the gate here makes a sixth divergent
 * copy fail a test instead of stealing the developer's focus mid-suite.
 *
 * Run with: npx tsx packages/apps/app/src/main/present-window.test.ts
 */
import {
  presentWindowWith,
  type PresentableWindow,
  type PresentOutcome
} from './present-window'

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

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    )
  }
}

type FakeWindow = PresentableWindow & { calls: string[] }

function mockWindow(state: { destroyed?: boolean; minimized?: boolean } = {}): FakeWindow {
  const calls: string[] = []
  return {
    calls,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  }
}

console.log('\npresentWindowWith')
console.log('─'.repeat(40))

test('playwright — no-op, nothing touched', () => {
  const win = mockWindow()
  const r: PresentOutcome = presentWindowWith(win, true)
  eq(r, 'skipped-under-test')
  eq(win.calls.length, 0, 'no window method may be called under Playwright')
})

test('playwright — no-op even when minimized (restore would raise too)', () => {
  const win = mockWindow({ minimized: true })
  eq(presentWindowWith(win, true), 'skipped-under-test')
  eq(win.calls.length, 0)
})

test('not playwright — shows and focuses', () => {
  const win = mockWindow()
  eq(presentWindowWith(win, false), 'presented')
  eq(win.calls.join(','), 'show,focus')
})

test('not playwright + minimized — restores first', () => {
  const win = mockWindow({ minimized: true })
  eq(presentWindowWith(win, false), 'presented')
  eq(win.calls.join(','), 'restore,show,focus')
})

test('destroyed window — no-op, reports no-window', () => {
  const win = mockWindow({ destroyed: true })
  eq(presentWindowWith(win, false), 'no-window')
  eq(win.calls.length, 0)
})

test('null / undefined window — no-op, reports no-window', () => {
  eq(presentWindowWith(null, false), 'no-window')
  eq(presentWindowWith(undefined, false), 'no-window')
})

test('playwright gate wins over a missing window', () => {
  // Order matters: the gate is checked FIRST so the outcome never depends on
  // whether a window happened to exist under test.
  eq(presentWindowWith(null, true), 'skipped-under-test')
})

console.log('\n' + '─'.repeat(40))
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

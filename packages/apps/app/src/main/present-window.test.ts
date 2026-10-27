/**
 * Tests for presentWindowWith — the hidden-window invariant under Playwright.
 *
 * This exists because the invariant was previously implicit: `tryShowMainWindow`
 * gated its own `show()` on `!isPlaywright`, and five other call sites raised
 * the window with no gate at all. Pinning the gate here makes a sixth divergent
 * copy fail a test instead of stealing the developer's focus mid-suite.
 */
import { describe, expect, test } from 'vitest'
import { presentWindowWith, type PresentableWindow, type PresentOutcome } from './present-window'

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

describe('presentWindowWith', () => {
  test('playwright — no-op, nothing touched', () => {
    const win = mockWindow()
    const r: PresentOutcome = presentWindowWith(win, true)
    expect(r).toBe('skipped-under-test')
    expect(win.calls, 'no window method may be called under Playwright').toEqual([])
  })

  test('playwright — no-op even when minimized (restore would raise too)', () => {
    const win = mockWindow({ minimized: true })
    expect(presentWindowWith(win, true)).toBe('skipped-under-test')
    expect(win.calls).toEqual([])
  })

  test('not playwright — shows and focuses', () => {
    const win = mockWindow()
    expect(presentWindowWith(win, false)).toBe('presented')
    expect(win.calls.join(',')).toBe('show,focus')
  })

  test('not playwright + minimized — restores first', () => {
    const win = mockWindow({ minimized: true })
    expect(presentWindowWith(win, false)).toBe('presented')
    expect(win.calls.join(',')).toBe('restore,show,focus')
  })

  test('destroyed window — no-op, reports no-window', () => {
    const win = mockWindow({ destroyed: true })
    expect(presentWindowWith(win, false)).toBe('no-window')
    expect(win.calls).toEqual([])
  })

  test('null / undefined window — no-op, reports no-window', () => {
    expect(presentWindowWith(null, false)).toBe('no-window')
    expect(presentWindowWith(undefined, false)).toBe('no-window')
  })

  test('playwright gate wins over a missing window', () => {
    // Order matters: the gate is checked FIRST so the outcome never depends on
    // whether a window happened to exist under test.
    expect(presentWindowWith(null, true)).toBe('skipped-under-test')
  })
})

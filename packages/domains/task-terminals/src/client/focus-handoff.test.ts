import { describe, it, expect, vi } from 'vitest'
import { createFocusHandoff } from './focus-handoff'

describe('createFocusHandoff', () => {
  it('cold activation keeps the claim until a pane attaches', () => {
    let landed = false
    const handoff = createFocusHandoff(() => landed, false)

    // Tab becomes active but the xterm pane hasn't attached yet — the focus
    // call silently no-ops (the regression: claim was dropped here).
    handoff.activate(() => {})

    landed = true
    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    expect(focus).toHaveBeenCalledTimes(1)

    // Claim consumed — a later attach must not steal focus.
    const focus2 = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'b', focus: focus2 })
    expect(focus2).not.toHaveBeenCalled()
  })

  it('warm activation focuses immediately and leaves no stale claim', () => {
    const handoff = createFocusHandoff(() => true, false)

    const groupFocus = vi.fn(() => {})
    handoff.activate(groupFocus)
    expect(groupFocus).toHaveBeenCalledTimes(1)

    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    expect(focus).not.toHaveBeenCalled()
  })

  it('attach inside an inert view keeps the claim for the next activation', () => {
    let landed = false
    const handoff = createFocusHandoff(() => landed, false)
    handoff.claim(true)

    // Pane attaches while the tab view is still inert/invisible (deferred
    // swap) — focus() no-ops, so the claim must survive.
    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    expect(focus).toHaveBeenCalledTimes(1)

    landed = true
    const groupFocus = vi.fn(() => {})
    handoff.activate(groupFocus)
    expect(groupFocus).toHaveBeenCalledTimes(1)

    // Activation landed — claim cleared, later attach must not steal.
    const focus2 = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'b', focus: focus2 })
    expect(focus2).not.toHaveBeenCalled()
  })

  it('session-targeted claim only completes on the matching pane', () => {
    const handoff = createFocusHandoff(() => true, false)
    handoff.claim('b')

    const focusA = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus: focusA })
    expect(focusA).not.toHaveBeenCalled()

    const focusB = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'b', focus: focusB })
    expect(focusB).toHaveBeenCalledTimes(1)

    const focusB2 = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'b', focus: focusB2 })
    expect(focusB2).not.toHaveBeenCalled()
  })

  it('attach without a claim does not steal focus', () => {
    const handoff = createFocusHandoff(() => true, false)
    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    expect(focus).not.toHaveBeenCalled()
  })

  it('mounting already-active claims the first attaching pane', () => {
    const handoff = createFocusHandoff(() => true, true)
    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    expect(focus).toHaveBeenCalledTimes(1)
  })
})

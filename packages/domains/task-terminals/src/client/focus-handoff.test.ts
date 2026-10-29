// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { createContainerFocusHandoff, createFocusHandoff } from './focus-handoff'

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

describe('createContainerFocusHandoff', () => {
  it('counts focus as landed only inside its container', () => {
    const container = document.createElement('div')
    const inside = document.createElement('input')
    // Not a text field: focus in one outside the container vetoes the attach
    // (covered below).
    const outside = document.createElement('button')
    container.appendChild(inside)
    document.body.append(container, outside)
    try {
      const handoff = createContainerFocusHandoff(false)
      handoff.setContainer(container)

      // Focus lands outside the container: the claim survives for the pane.
      handoff.activate(() => outside.focus())
      const focus = vi.fn(() => inside.focus())
      handoff.paneAttached({ sessionId: 'a', focus })
      expect(focus).toHaveBeenCalledTimes(1)

      // Landed inside: claim consumed.
      const focus2 = vi.fn(() => {})
      handoff.paneAttached({ sessionId: 'b', focus: focus2 })
      expect(focus2).not.toHaveBeenCalled()
    } finally {
      container.remove()
      outside.remove()
    }
  })

  it('a late-attaching pane does not take focus from a field being typed in', () => {
    const container = document.createElement('div')
    const pane = document.createElement('textarea')
    container.appendChild(pane)
    const rename = document.createElement('input')
    document.body.append(container, rename)
    try {
      // Task opened: the activation's focus no-ops (pane not attached yet), so
      // the claim waits for the attach.
      const handoff = createContainerFocusHandoff(true)
      handoff.setContainer(container)
      handoff.activate(() => {})

      // Meanwhile the user starts an inline rename elsewhere in the task view.
      rename.focus()
      const focus = vi.fn(() => pane.focus())
      handoff.paneAttached({ sessionId: 'a', focus })
      expect(focus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(rename)

      // The user moved on: the claim is dropped, not parked for a later attach.
      rename.blur()
      const focus2 = vi.fn(() => pane.focus())
      handoff.paneAttached({ sessionId: 'b', focus: focus2 })
      expect(focus2).not.toHaveBeenCalled()
    } finally {
      container.remove()
      rename.remove()
    }
  })

  it('without a container, focus never counts as landed', () => {
    const handoff = createContainerFocusHandoff(true)
    const focus = vi.fn(() => {})
    handoff.paneAttached({ sessionId: 'a', focus })
    handoff.paneAttached({ sessionId: 'b', focus })
    expect(focus).toHaveBeenCalledTimes(2)
  })
})

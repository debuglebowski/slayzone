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
    const outside = document.createElement('input')
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

  it('an explicit claim made while typing still completes (Cmd+T from the description)', () => {
    const container = document.createElement('div')
    const pane = document.createElement('textarea')
    container.appendChild(pane)
    const description = document.createElement('textarea')
    document.body.append(container, description)
    try {
      const handoff = createContainerFocusHandoff(false)
      handoff.setContainer(container)
      // The user asks for a new terminal while focus is still in the editor.
      description.focus()
      handoff.claim(true)
      const focus = vi.fn(() => pane.focus())
      handoff.paneAttached({ sessionId: 'a', focus })
      expect(focus).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(pane)
    } finally {
      container.remove()
      description.remove()
    }
  })

  it("focus in another terminal or a non-text control doesn't hold the claim off", () => {
    const container = document.createElement('div')
    const pane = document.createElement('textarea')
    container.appendChild(pane)
    const otherTerminal = document.createElement('div')
    otherTerminal.className = 'xterm'
    const otherXterm = document.createElement('textarea')
    otherTerminal.appendChild(otherXterm)
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    document.body.append(container, otherTerminal, checkbox)
    try {
      for (const elsewhere of [otherXterm, checkbox]) {
        pane.blur()
        const handoff = createContainerFocusHandoff(true)
        handoff.setContainer(container)
        handoff.activate(() => {})
        elsewhere.focus()
        const focus = vi.fn(() => pane.focus())
        handoff.paneAttached({ sessionId: 'a', focus })
        expect(focus).toHaveBeenCalledTimes(1)
      }
    } finally {
      container.remove()
      otherTerminal.remove()
      checkbox.remove()
    }
  })

  it('a late tab activation does not take focus from a field being typed in', () => {
    // Opening a task is a transition: a double-click's first click opens it, the
    // double-click opens an inline rename, and the swap commits after that.
    const container = document.createElement('div')
    const pane = document.createElement('textarea')
    container.appendChild(pane)
    const rename = document.createElement('input')
    document.body.append(container, rename)
    try {
      const handoff = createContainerFocusHandoff(false)
      handoff.setContainer(container)
      rename.focus()
      const groupFocus = vi.fn(() => pane.focus())
      handoff.activate(groupFocus)
      expect(groupFocus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(rename)

      // Dropped, not parked: the pane attaching later must not take it either.
      const focus = vi.fn(() => pane.focus())
      handoff.paneAttached({ sessionId: 'a', focus })
      expect(focus).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(rename)
    } finally {
      container.remove()
      rename.remove()
    }
  })

  it('a field left focused in a hidden (inert) tab does not hold focus off', () => {
    // Cmd+2 from the description editor: the old tab turns inert in the same
    // commit, possibly before its field is blurred.
    const container = document.createElement('div')
    const pane = document.createElement('textarea')
    container.appendChild(pane)
    const hiddenTab = document.createElement('div')
    const description = document.createElement('textarea')
    hiddenTab.appendChild(description)
    document.body.append(container, hiddenTab)
    try {
      const handoff = createContainerFocusHandoff(false)
      handoff.setContainer(container)
      description.focus()
      hiddenTab.setAttribute('inert', '')
      const groupFocus = vi.fn(() => pane.focus())
      handoff.activate(groupFocus)
      expect(groupFocus).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(pane)
    } finally {
      container.remove()
      hiddenTab.remove()
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

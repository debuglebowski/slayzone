import { useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useGuardedHotkeys } from './useGuardedHotkeys'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

afterEach(() => {
  cleanup()
})

// The modal guard answers "was a modal open when the key was pressed?". Radix closes a
// dialog on Escape in its own document-capture listener, BEFORE react-hotkeys-hook's
// document-bubble listener runs. In a browser, a real keystroke runs a microtask
// checkpoint after every listener, so React commits that close in between: by the time
// the hotkey asks, the overlay is already `data-state="closed"`. jsdom dispatches
// synchronously (no checkpoint between listeners), so `flushSync` in onOpenChange
// stands in for that commit.
function ZenEscapeHarness({ onAppEscape }: { onAppEscape: () => void }) {
  const [open, setOpen] = useState(true)
  // As the Chromium-fork HomeView binds exit-zen-explode: guarded, fires from inputs.
  useGuardedHotkeys('escape', onAppEscape, { enableOnFormTags: true })
  return (
    <Dialog open={open} onOpenChange={(next) => flushSync(() => setOpen(next))}>
      <DialogContent>
        <DialogTitle>Create task</DialogTitle>
        <DialogDescription>New task in this project.</DialogDescription>
        <input aria-label="Title" autoFocus />
      </DialogContent>
    </Dialog>
  )
}

describe('useGuardedHotkeys', () => {
  it('an Escape that closes a modal does not also reach the guarded hotkey', () => {
    const onAppEscape = vi.fn()
    render(<ZenEscapeHarness onAppEscape={onAppEscape} />)
    const input = document.activeElement as HTMLElement
    expect(input.getAttribute('aria-label')).toBe('Title')

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })

    // Radix closed the dialog on this very key…
    expect(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')).toBeNull()
    // …and the app's Escape (exit zen / explode) must stand down: the modal was open
    // when the key was pressed.
    expect(onAppEscape).not.toHaveBeenCalled()
  })

  it('still fires once no modal is open', () => {
    const onAppEscape = vi.fn()
    render(<ZenEscapeHarness onAppEscape={onAppEscape} />)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape', code: 'Escape' })
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    expect(onAppEscape).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'

/**
 * jsdom runs no CSS animations, so Radix `Presence` would unmount a closing layer at
 * once. Report the animation name the real classes resolve to, keyed off the live
 * `data-state`, so a close suspends the unmount until the test dispatches that
 * layer's `animationend` — the same sequence a browser drives, one layer at a time.
 */
function fakeCssAnimations(): void {
  const real = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = real(el, pseudo)
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'animationName') {
          const state = el.getAttribute('data-state')
          return state === 'open' ? 'enter' : state === 'closed' ? 'exit' : 'none'
        }
        const value: unknown = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  // Presence matches `animationend` through CSS.escape, which jsdom lacks.
  vi.stubGlobal('CSS', { escape: (s: string) => s })
}

function finishExitAnimation(el: Element): void {
  act(() => {
    el.dispatchEvent(Object.assign(new Event('animationend'), { animationName: 'exit' }))
  })
}

function Nav({
  open,
  modal,
  onOpenChange
}: {
  open: boolean
  modal?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Sheet open={open} modal={modal} onOpenChange={onOpenChange}>
      <SheetContent side="left">
        <SheetTitle>Sidebar</SheetTitle>
        <SheetDescription>Displays the mobile sidebar.</SheetDescription>
        <button type="button">Inbox</button>
      </SheetContent>
    </Sheet>
  )
}

const overlay = (): Element =>
  document.querySelector('[data-slot="sheet-overlay"][data-state="open"]')!
const content = (): Element =>
  document.querySelector('[data-slot="sheet-content"][data-state="open"]')!

/** Overlay and content share `z-50`, so tree order alone decides which one is hit. */
function contentIsAboveOverlay(): boolean {
  const o = overlay()
  const c = content()
  return o.contains(c) || !!(o.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
}

/** DismissableLayer arms its outside-pointerdown listener one macrotask after mount. */
const armOutsideListener = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

describe('SheetContent', () => {
  beforeEach(fakeCssAnimations)
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stacks the content above its overlay on first open', () => {
    render(<Nav open />)
    expect(contentIsAboveOverlay()).toBe(true)
  })

  // The overlay's exit (150ms) ends well before the content's slide-out (`duration-300`).
  // A reopen inside that gap used to re-mount ONLY the overlay — appended after the
  // still-mounted content — so the overlay covered the sheet and swallowed every click.
  it('keeps the content above its overlay when reopened mid exit animation', () => {
    const { rerender } = render(<Nav open />)
    const closingOverlay = overlay()
    rerender(<Nav open={false} />)
    finishExitAnimation(closingOverlay)

    rerender(<Nav open />)

    expect(contentIsAboveOverlay()).toBe(true)
  })

  it('dismisses on a pointerdown on the overlay, not on one inside the content', async () => {
    const onOpenChange = vi.fn()
    render(<Nav open onOpenChange={onOpenChange} />)
    await armOutsideListener()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inbox' }))
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.pointerDown(overlay())
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // Radix renders no overlay for a non-modal sheet (`Overlay` returns null), so the
  // content must not depend on the overlay to be mounted.
  it('still renders the content of a non-modal sheet', () => {
    render(<Nav open modal={false} />)
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Sidebar' })).toBeTruthy()
  })
})

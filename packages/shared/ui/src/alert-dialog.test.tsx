import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from './alert-dialog'

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

function Confirm({ open }: { open: boolean }) {
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogTitle>Unstage All</AlertDialogTitle>
        <AlertDialogDescription>Unstage all 2 files?</AlertDialogDescription>
        <AlertDialogAction>Unstage All</AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const overlay = (): Element =>
  document.querySelector('[data-slot="alert-dialog-overlay"][data-state="open"]')!
const content = (): Element =>
  document.querySelector('[data-slot="alert-dialog-content"][data-state="open"]')!

/** Overlay and content share `z-50`, so tree order alone decides which one is hit. */
function contentIsAboveOverlay(): boolean {
  const o = overlay()
  const c = content()
  return o.contains(c) || !!(o.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('AlertDialogContent', () => {
  beforeEach(fakeCssAnimations)
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stacks the content above its overlay on first open', () => {
    render(<Confirm open />)
    expect(contentIsAboveOverlay()).toBe(true)
  })

  // The overlay's exit (150ms) ends before the content's (`duration-200`). A reopen
  // inside that gap used to re-mount ONLY the overlay — appended after the still-mounted
  // content — so the overlay covered the dialog and swallowed every click on its
  // buttons (measured: e2e 32-git-diff-panel "unstage all", overlay intercepts pointer).
  it('keeps the content above its overlay when reopened mid exit animation', () => {
    const { rerender } = render(<Confirm open />)
    const closingOverlay = overlay()
    rerender(<Confirm open={false} />)
    finishExitAnimation(closingOverlay)

    rerender(<Confirm open />)

    expect(contentIsAboveOverlay()).toBe(true)
  })
})

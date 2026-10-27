import { Activity, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { isModalDialogOpen } from './is-modal-dialog-open'
import { withModalGuard } from './with-modal-guard'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from './alert-dialog'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet'
import { CommandDialog, CommandInput, CommandList } from './command'
import { Popover, PopoverAnchor, PopoverContent } from './popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

// Every surface below is the REAL @slayzone/ui component, not a hand-built
// `role="dialog"` node: the guard must agree with what Radix actually renders.

// jsdom lacks ResizeObserver (Radix Popper, cmdk), scrollIntoView (Radix Select) and
// checkVisibility (which Chromium has; its `display: none` part is all this guard needs).
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const hadScrollIntoView = 'scrollIntoView' in Element.prototype
const hadCheckVisibility = 'checkVisibility' in Element.prototype

function checkVisibility(this: Element): boolean {
  for (let el: Element | null = this; el; el = el.parentElement) {
    if (window.getComputedStyle(el).display === 'none') return false
  }
  return true
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  if (!hadScrollIntoView) Element.prototype.scrollIntoView = () => {}
  if (!hadCheckVisibility) Element.prototype.checkVisibility = checkVisibility
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (!hadScrollIntoView) delete (Element.prototype as Partial<Element>).scrollIntoView
  if (!hadCheckVisibility) delete (Element.prototype as Partial<Element>).checkVisibility
})

/** The modal surfaces the app opens: global shortcuts must stand down for each. */
const modalSurfaces: Array<[name: string, render: (open: boolean) => ReactNode]> = [
  [
    'Dialog',
    (open) => (
      <Dialog open={open}>
        <DialogContent>
          <DialogTitle>Create task</DialogTitle>
          <DialogDescription>New task in this project.</DialogDescription>
          <input aria-label="Title" />
        </DialogContent>
      </Dialog>
    )
  ],
  [
    'AlertDialog',
    (open) => (
      <AlertDialog open={open}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete task</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )
  ],
  [
    'Sheet',
    (open) => (
      <Sheet open={open}>
        <SheetContent>
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Displays the mobile sidebar.</SheetDescription>
        </SheetContent>
      </Sheet>
    )
  ],
  [
    'CommandDialog',
    (open) => (
      <CommandDialog open={open}>
        <DialogTitle>Search</DialogTitle>
        <DialogDescription>Files, tasks and commands.</DialogDescription>
        <CommandInput placeholder="Search..." />
        <CommandList />
      </CommandDialog>
    )
  ]
]

/**
 * Open surfaces that are NOT modal: the rest of the app stays usable, so its shortcuts
 * must keep working. Popover content is itself `role="dialog"`.
 */
const nonModalSurfaces: Array<[name: string, render: () => ReactNode]> = [
  [
    'Popover (role="dialog")',
    () => (
      <Popover open>
        <PopoverAnchor />
        <PopoverContent>Status picker</PopoverContent>
      </Popover>
    )
  ],
  [
    'modal Popover',
    () => (
      <Popover open modal>
        <PopoverAnchor />
        <PopoverContent>Lock project</PopoverContent>
      </Popover>
    )
  ],
  [
    'DropdownMenu',
    () => (
      <DropdownMenu open>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  ],
  [
    'Select',
    () => (
      <Select open value="todo">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="todo">Todo</SelectItem>
        </SelectContent>
      </Select>
    )
  ],
  [
    'Tooltip',
    () => (
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Info</TooltipTrigger>
          <TooltipContent>Hint</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  ],
  [
    'non-modal Dialog',
    () => (
      <Dialog open modal={false}>
        <DialogContent>
          <DialogTitle>Inspector</DialogTitle>
          <DialogDescription>Floats over the page.</DialogDescription>
        </DialogContent>
      </Dialog>
    )
  ],
  [
    'non-modal Sheet',
    () => (
      <Sheet open modal={false}>
        <SheetContent>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Floats over the page.</SheetDescription>
        </SheetContent>
      </Sheet>
    )
  ]
]

describe('isModalDialogOpen', () => {
  it.each(modalSurfaces)('detects an open %s', (_name, surface) => {
    const { rerender } = render(<>{surface(false)}</>)
    expect(isModalDialogOpen()).toBe(false)
    rerender(<>{surface(true)}</>)
    expect(isModalDialogOpen()).toBe(true)
    rerender(<>{surface(false)}</>)
    expect(isModalDialogOpen()).toBe(false)
  })

  it.each(nonModalSurfaces)('ignores an open %s', (_name, surface) => {
    render(<>{surface()}</>)
    // The surface really is open (Tooltip: "instant-open") — the guard must not count it.
    expect(document.querySelector('[data-state$="open"]')).not.toBeNull()
    expect(isModalDialogOpen()).toBe(false)
  })

  it('stops counting a dialog once it starts closing', () => {
    // jsdom runs no CSS animations, so Radix `Presence` would unmount a closing layer at
    // once. Report an exit animation for `data-state="closed"` so the closing dialog
    // stays mounted, as it does in a browser for its exit animation.
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
    vi.stubGlobal('CSS', { escape: (s: string) => s })
    const [, surface] = modalSurfaces[0]
    const { rerender } = render(<>{surface(true)}</>)
    expect(isModalDialogOpen()).toBe(true)
    rerender(<>{surface(false)}</>)
    expect(
      document.querySelector('[data-slot="dialog-content"][data-state="closed"]')
    ).not.toBeNull()
    expect(isModalDialogOpen()).toBe(false)
  })

  // A task panel's dialog stays open when its tab goes to the background: React hides
  // the panel's <Activity> (portal included) and unmounts the dialog's focus trap and
  // pointer block, so the visible tab must keep its shortcuts.
  it('ignores a dialog left open in a hidden <Activity>, until it is shown again', () => {
    const [, surface] = modalSurfaces[0]
    const panel = (mode: 'visible' | 'hidden') => <Activity mode={mode}>{surface(true)}</Activity>
    const { rerender } = render(panel('visible'))
    expect(isModalDialogOpen()).toBe(true)
    rerender(panel('hidden'))
    expect(document.querySelector('[data-slot="dialog-overlay"][data-state="open"]')).not.toBeNull()
    expect(isModalDialogOpen()).toBe(false)
    rerender(panel('visible'))
    expect(isModalDialogOpen()).toBe(true)
  })

  it('counts every open overlay where checkVisibility is unavailable', () => {
    delete (Element.prototype as Partial<Element>).checkVisibility
    const [, surface] = modalSurfaces[0]
    const panel = (mode: 'visible' | 'hidden') => <Activity mode={mode}>{surface(true)}</Activity>
    const { rerender } = render(panel('visible'))
    rerender(panel('hidden'))
    expect(isModalDialogOpen()).toBe(true)
  })

  it('queries the DOM once per event, however many handlers ask', () => {
    const query = vi.spyOn(document, 'querySelectorAll')
    const event = new KeyboardEvent('keydown', { key: 'a' })
    for (let i = 0; i < 50; i++) isModalDialogOpen(event)
    expect(query).toHaveBeenCalledTimes(1)

    // A new event asks the DOM again — the answer is not cached across events.
    const [, surface] = modalSurfaces[0]
    render(<>{surface(true)}</>)
    query.mockClear()
    expect(isModalDialogOpen(new KeyboardEvent('keydown', { key: 'a' }))).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('re-queries on every call made without an event', () => {
    const query = vi.spyOn(document, 'querySelectorAll')
    isModalDialogOpen()
    isModalDialogOpen()
    expect(query).toHaveBeenCalledTimes(2)
  })
})

describe('withModalGuard', () => {
  it('shares one modal check across every guarded handler of a keystroke', () => {
    const query = vi.spyOn(document, 'querySelectorAll')
    const handlers = Array.from({ length: 20 }, () => vi.fn())
    const listeners = handlers.map((h) => withModalGuard(h))
    for (const l of listeners) window.addEventListener('keydown', l)
    try {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    } finally {
      for (const l of listeners) window.removeEventListener('keydown', l)
    }
    for (const h of handlers) expect(h).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each(modalSurfaces)('skips the handler while a %s is open', (_name, surface) => {
    const handler = vi.fn()
    const guarded = withModalGuard(handler)
    const { rerender } = render(<>{surface(true)}</>)
    guarded(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    expect(handler).not.toHaveBeenCalled()

    act(() => rerender(<>{surface(false)}</>))
    guarded(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'

import { cn } from './utils'

// `@slayzone/ui` is consumed by the Electron renderer, the Chromium-fork shell
// and jsdom tests, so it can't depend on any one of their `window.api` types.
// Narrow to the single flag this file reads instead.
type PlaywrightProbeWindow = { api?: { app?: { isPlaywright?: boolean } } }

const isPlaywright =
  typeof window !== 'undefined' &&
  !!(window as unknown as PlaywrightProbeWindow).api?.app?.isPlaywright

// The Root's `modal`, for `DialogContent`: only a modal dialog has an overlay to nest
// the content in (Radix's `Overlay` renders null when `modal` is false).
const DialogModalContext = React.createContext(true)

function Dialog({ modal = true, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogModalContext value={modal}>
      <DialogPrimitive.Root data-slot="dialog" modal={modal} {...props} />
    </DialogModalContext>
  )
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40 dark:bg-black/60 backdrop-blur-sm',
        isPlaywright ? 'data-[state=closed]:duration-0' : '',
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = 'default',
  overlayClassName,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  size?: 'default' | 'project-settings' | 'xl'
  overlayClassName?: string
}) {
  const sizeClass =
    size === 'project-settings'
      ? 'h-[88vh] !w-[94vw] !max-w-[1320px] p-0'
      : size === 'xl'
        ? 'w-[min(1200px,92vw)] max-w-[1200px]'
        : ''

  const modal = React.useContext(DialogModalContext)

  const content = (
    <DialogPrimitive.Content
      data-slot="dialog-content"
      className={cn(
        'bg-modal data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-[var(--modal-border)] p-6 shadow-lg outline-none',
        // Playwright: no close animation, so a closed dialog leaves the DOM at once.
        // Added (Radix dialog 1.1.15) when the modal content held `body { pointer-events:
        // none }` until it unmounted, i.e. through the whole exit. It still shortens the
        // closed-but-mounted window, in which the closing overlay intercepts pointers and
        // the closing content, still the top layer, preventDefaults every Escape. Not
        // load-bearing for overlay/content stacking any more (see the nesting below).
        isPlaywright
          ? 'data-[state=closed]:duration-0 data-[state=open]:duration-200'
          : 'duration-200',
        sizeClass,
        className
      )}
      // Playwright's click({ force: true }) is interpreted by Radix as an outside-click,
      // dismissing the dialog. Prevent this in test environments.
      {...(isPlaywright ? { onInteractOutside: (e: Event) => e.preventDefault() } : {})}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          data-slot="dialog-close"
          className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  )

  return (
    <DialogPortal data-slot="dialog-portal">
      {/* Content INSIDE the overlay, not beside it (Radix's nested-overlay layout), as in
          AlertDialogContent. The Portal mounts each child separately, so as siblings the
          overlay's shorter exit (150ms vs the content's 200ms; a caller's `duration-*`
          widens the gap) unmounted it first; a reopen inside that gap re-mounted only the
          overlay, appended AFTER the still-mounted content, and the equal-z-index overlay
          then covered the dialog and swallowed every click in it. Nested, the content
          cannot end up beneath its own overlay. A non-modal dialog has no overlay. */}
      {modal ? <DialogOverlay className={overlayClassName}>{content}</DialogOverlay> : content}
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-row justify-end gap-2', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}

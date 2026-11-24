import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { Button, Popover, PopoverAnchor, PopoverContent, cn } from '@slayzone/ui'
interface ActionLabel {
  label: string
  icon: LucideIcon
}

export function ArtifactToolbarActionButton({
  action: { label, icon: Icon },
  opensOptions,
  className,
  ...props
}: ComponentProps<typeof Button> & { action: ActionLabel; opensOptions: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn('h-8 min-w-0 flex-1 justify-start px-2 text-xs', className)}
      {...props}
    >
      <Icon className="size-3.5 text-muted-foreground" />
      {label}
      {opensOptions && <ChevronRight className="ml-auto size-3 text-muted-foreground" />}
    </Button>
  )
}

export function ArtifactToolbarSubmenu({
  action,
  open,
  onOpenChange,
  options,
  className,
  children
}: {
  action: ActionLabel
  open: boolean
  onOpenChange: (open: boolean) => void
  options: ReactNode
  className?: string
  children: ReactNode
}) {
  const contentId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const focusOnOpen = useRef(false)

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  function cancelHover() {
    window.clearTimeout(hoverTimer.current)
  }

  function focusOption() {
    const search = content.current?.querySelector<HTMLInputElement>(
      'input[role="combobox"]:enabled'
    )
    const selected = content.current?.querySelector<HTMLButtonElement>(
      'button[aria-pressed="true"]:enabled'
    )
    const option =
      search ?? selected ?? content.current?.querySelector<HTMLButtonElement>('button:enabled')
    option?.focus()
  }

  function show(moveFocus: boolean) {
    cancelHover()
    if (open) {
      if (moveFocus) focusOption()
      return
    }
    focusOnOpen.current = moveFocus
    onOpenChange(true)
  }

  // Leave room to move across the gap between the More menu and the submenu.
  function closeAfterHover() {
    cancelHover()
    hoverTimer.current = window.setTimeout(() => {
      if (!content.current?.contains(document.activeElement)) onOpenChange(false)
    }, 200)
  }

  function returnToTrigger() {
    cancelHover()
    onOpenChange(false)
    trigger.current?.focus()
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div className="flex items-center gap-0.5" onPointerLeave={closeAfterHover}>
          <ArtifactToolbarActionButton
            ref={trigger}
            action={action}
            opensOptions
            className={open ? 'bg-accent text-accent-foreground' : undefined}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? contentId : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType === 'touch') return
              cancelHover()
              if (!open) hoverTimer.current = window.setTimeout(() => show(false), 100)
            }}
            onPointerLeave={() => {
              if (!open) cancelHover()
            }}
            onClick={() => show(true)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight') return
              event.preventDefault()
              show(true)
            }}
          />
          {children}
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={content}
        id={contentId}
        aria-label={action.label}
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'flex max-h-[var(--radix-popover-content-available-height)] w-56 max-w-[var(--radix-popover-content-available-width)] flex-col overflow-y-auto p-1',
          className
        )}
        onPointerEnter={cancelHover}
        onPointerLeave={closeAfterHover}
        onInteractOutside={(event) => {
          if (event.target instanceof Node && trigger.current?.contains(event.target)) {
            event.preventDefault()
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          if (focusOnOpen.current) focusOption()
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          returnToTrigger()
        }}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            (event.target instanceof HTMLElement &&
              event.target.closest('input, select, textarea, [contenteditable], [role="combobox"]'))
          )
            return
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            returnToTrigger()
            return
          }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const buttons = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('button:enabled')
          )
          if (buttons.length === 0) return
          event.preventDefault()
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : event.key === 'ArrowDown'
                  ? (index + 1) % buttons.length
                  : index <= 0
                    ? buttons.length - 1
                    : index - 1
          buttons[next]?.focus()
        }}
      >
        {open && options}
      </PopoverContent>
    </Popover>
  )
}

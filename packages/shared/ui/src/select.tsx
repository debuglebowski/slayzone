import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'

import { cn } from './utils'

const selectTriggerClasses =
  "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/*
 * Closed selects keep their options UNMOUNTED.
 *
 * Radix keeps every <SelectItem> of a closed Select mounted in a detached fragment, only
 * to feed its hidden native <select> and to portal the selected option's text into the
 * trigger. Under React <Activity> (task tabs hide their panels with it) that is costly:
 * re-showing a tab re-runs every item's ref/layout effects, and Radix creates a NEW
 * fragment on each re-show, which remounts all of them — ~680 renders per tab switch
 * from the task settings panel's four selects.
 *
 * So while a Select is closed this wrapper renders only the selected option's children,
 * into the trigger's value (what Radix showed there). The real items mount while:
 *  - the Select is open;
 *  - its trigger has focus — a closed trigger selects by typeahead, which needs them;
 *  - it is a native form control (inside a <form>, or `name`/`form` given) — the
 *    hidden native <select> then needs its <option>s.
 */
type SelectLazyState = {
  /** Mount the Radix items (open, focused trigger, or form control). */
  itemsMounted: boolean
  closed: ClosedSelect
  onTriggerFocusChange: (focused: boolean) => void
  onTriggerNode: (node: HTMLElement | null) => void
}
type ClosedSelect = {
  value: string | undefined
  /** Lives inside the trigger's value span; the selected option's children render here. */
  labelHost: HTMLElement
}

const SelectLazyContext = React.createContext<SelectLazyState | null>(null)
/** Set while a closed Select renders its items as labels only. */
const ClosedSelectContext = React.createContext<ClosedSelect | null>(null)

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as React.RefObject<T | null>).current = value
}

function Select({
  onValueChange,
  value: valueProp,
  defaultValue,
  open: openProp,
  defaultOpen,
  onOpenChange,
  name,
  form,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  // Mirrors Radix's own value so the closed label shows what Radix would show, for
  // controlled and uncontrolled selects alike.
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
  const value = valueProp !== undefined ? valueProp : uncontrolledValue
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const open = openProp !== undefined ? openProp : uncontrolledOpen
  const [triggerFocused, setTriggerFocused] = React.useState(false)
  const [inForm, setInForm] = React.useState(false)
  // Compared before setting, so re-attaching the trigger (every <Activity> re-show)
  // schedules no update when nothing changed.
  const inFormRef = React.useRef(false)
  const [labelHost] = React.useState(() => {
    const host = document.createElement('span')
    // Its children lay out as direct children of the value span, as Radix's own
    // portal of the selected option's text does.
    host.style.display = 'contents'
    return host
  })

  const handleValueChange = React.useCallback(
    (next: string) => {
      setUncontrolledValue(next)
      // Radix forbids '' as an item value, so onValueChange('') is never a real
      // selection. It is Radix's hidden native <select> misfiring: inside
      // <Activity mode="hidden"> (task tabs) that <select> renders with no
      // <option>s, so a value change landing while hidden reads back '' on
      // re-show — which the task panel used to save as status/priority.
      if (next !== '') onValueChange?.(next)
    },
    [onValueChange]
  )
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  const onTriggerNode = React.useCallback((node: HTMLElement | null) => {
    if (!node) return
    const isInForm = node.closest('form') !== null
    if (inFormRef.current === isInForm) return
    inFormRef.current = isInForm
    setInForm(isInForm)
  }, [])

  const itemsMounted = open || triggerFocused || inForm || name !== undefined || form !== undefined
  const closed = React.useMemo(() => ({ value, labelHost }), [value, labelHost])
  const lazy = React.useMemo(
    () => ({ itemsMounted, closed, onTriggerFocusChange: setTriggerFocused, onTriggerNode }),
    [itemsMounted, closed, onTriggerNode]
  )

  return (
    <SelectPrimitive.Root
      data-slot="select"
      value={valueProp}
      defaultValue={defaultValue}
      onValueChange={handleValueChange}
      open={openProp}
      defaultOpen={defaultOpen}
      onOpenChange={handleOpenChange}
      name={name}
      form={form}
      {...props}
    >
      <SelectLazyContext value={lazy}>{children}</SelectLazyContext>
    </SelectPrimitive.Root>
  )
}

function SelectGroup({ children, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  if (React.useContext(ClosedSelectContext)) return <>{children}</>
  return (
    <SelectPrimitive.Group data-slot="select-group" {...props}>
      {children}
    </SelectPrimitive.Group>
  )
}

function SelectValue({ ref, ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  const labelHost = React.useContext(SelectLazyContext)?.closed.labelHost
  // Explicit children replace the selected option's text (Radix semantics).
  const showsOption = props.children === undefined
  const valueRef = React.useCallback(
    (node: HTMLSpanElement | null) => {
      setRef(ref, node)
      if (!node || !labelHost) return
      if (showsOption && labelHost.parentNode !== node) node.appendChild(labelHost)
      else if (!showsOption && labelHost.parentNode === node) node.removeChild(labelHost)
    },
    [ref, labelHost, showsOption]
  )
  return <SelectPrimitive.Value data-slot="select-value" ref={valueRef} {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ref,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: 'sm' | 'default'
}) {
  const lazy = React.useContext(SelectLazyContext)
  const onTriggerNode = lazy?.onTriggerNode
  const onTriggerFocusChange = lazy?.onTriggerFocusChange
  const triggerRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      setRef(ref, node)
      onTriggerNode?.(node)
    },
    [ref, onTriggerNode]
  )
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(selectTriggerClasses, className)}
      ref={triggerRef}
      onFocus={(event) => {
        onFocus?.(event)
        onTriggerFocusChange?.(true)
      }}
      onBlur={(event) => {
        onBlur?.(event)
        onTriggerFocusChange?.(false)
      }}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'item-aligned',
  align = 'center',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const lazy = React.useContext(SelectLazyContext)
  // Created once: a closed Select's label-only items render into it (detached, never
  // shown), so anything else in the content stays out of the page.
  const [detached] = React.useState(() => document.createDocumentFragment())
  if (lazy && !lazy.itemsMounted) {
    return createPortal(
      <ClosedSelectContext value={lazy.closed}>{children}</ClosedSelectContext>,
      detached
    )
  }
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1'
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  if (React.useContext(ClosedSelectContext)) return null
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('text-muted-foreground px-2 py-1.5 text-xs', className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  const closed = React.useContext(ClosedSelectContext)
  if (closed) {
    // What Radix portals into the trigger for the selected option: its text children.
    return closed.value === props.value ? createPortal(children, closed.labelHost) : null
  }
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  if (React.useContext(ClosedSelectContext)) return null
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('bg-border pointer-events-none -mx-1 my-1 h-px', className)}
      {...props}
    />
  )
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('flex cursor-default items-center justify-center py-1', className)}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue
}

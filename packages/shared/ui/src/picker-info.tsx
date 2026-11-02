import type { ReactNode } from 'react'
import { Info } from 'lucide-react'
import { cn } from './utils'

/**
 * Shared parts of the chat pickers' (mode / model / effort) info pane: each
 * row's ⓘ toggle, the "default" tag, and the side pane that explains the row
 * and offers "Set as default".
 */

export function PickerInfoButton({
  label,
  active,
  onToggle
}: {
  label: string
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`About ${label}`}
      aria-pressed={active}
      className={cn(
        'shrink-0 rounded p-0.5 text-muted-foreground opacity-50 transition-opacity hover:opacity-100',
        active && 'opacity-100'
      )}
      onClick={(e) => {
        // Keep the menu item from selecting (and closing) on this click.
        e.stopPropagation()
        onToggle()
      }}
    >
      <Info className="size-3.5" />
    </button>
  )
}

export function PickerDefaultTag() {
  return <span className="shrink-0 text-[10px] text-muted-foreground">default</span>
}

export function PickerInfoPane({
  title,
  className,
  children,
  details,
  isDefault,
  onSetDefault,
  setDisabled
}: {
  /** Pane heading (icon + label). */
  title: ReactNode
  /** Pane color (heading, illustration, button) — e.g. the mode's text color. */
  className?: string
  /** Optional illustration above the text. */
  children?: ReactNode
  details: ReactNode
  isDefault: boolean
  /** Absent: no default row (the caller doesn't support defaults). */
  onSetDefault?: () => void
  setDisabled?: boolean
}) {
  return (
    <div className={cn('flex w-72 flex-col gap-3 border-l border-border p-3', className)}>
      <div className="flex items-center gap-2 text-xs font-medium">{title}</div>
      {children}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{details}</p>
      {onSetDefault && (
        <div className="mt-auto flex items-center justify-end">
          {isDefault ? (
            <span className="text-[10px] text-muted-foreground">Default for new chats</span>
          ) : (
            <button
              type="button"
              disabled={setDisabled}
              className={cn(
                'rounded px-2 py-1 text-[11px] ring-1 ring-current/30 hover:bg-muted/60 disabled:opacity-50'
              )}
              onClick={onSetDefault}
            >
              Set as default
            </button>
          )}
        </div>
      )}
    </div>
  )
}

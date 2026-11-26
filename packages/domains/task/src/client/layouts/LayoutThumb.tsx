import type { LayoutColumn, LayoutTree } from '@slayzone/task-contracts'
import { isColumnVisible, isSlotVisible } from '@slayzone/task-contracts'
import { cn } from '@slayzone/ui'

/** A column's share of the thumbnail width, from its default size. */
function columnWeight(column: LayoutColumn): number {
  const { unit, value } = column.size
  if (unit === 'fr') return Math.max(0.3, value)
  if (unit === 'pct') return Math.max(0.3, value / 25)
  return Math.max(0.3, value / 320)
}

/**
 * A layout in miniature: its shown columns left to right, each column's shown
 * groups top to bottom (the group holding the primary agent tinted). For menus and
 * the Manage layouts list.
 */
export function LayoutThumb({
  tree,
  active = false,
  className
}: {
  tree: LayoutTree
  active?: boolean
  className?: string
}): React.JSX.Element {
  const columns = tree.columns.filter(isColumnVisible)
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex h-6 w-9 shrink-0 gap-px overflow-hidden rounded-[3px] border p-px',
        active ? 'border-primary' : 'border-border',
        className
      )}
    >
      {columns.map((column) => (
        <span
          key={column.id}
          className="flex min-w-0 flex-col gap-px"
          style={{ flex: columnWeight(column) }}
        >
          {column.slots.filter(isSlotVisible).map((slot) => (
            <span
              key={slot.id}
              className={cn(
                'min-h-0 rounded-[1px]',
                slot.tabs.some((t) => t.instanceId === 'terminal' && !t.hidden)
                  ? 'bg-primary/50'
                  : 'bg-muted-foreground/30'
              )}
              style={{ flex: slot.weight }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

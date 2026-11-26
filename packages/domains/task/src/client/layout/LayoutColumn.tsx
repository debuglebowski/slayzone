import type { LayoutColumn as LayoutColumnModel, TaskLayout } from '@slayzone/task-contracts'
import { isSlotVisible } from '@slayzone/task-contracts'
import { TabGroup } from './TabGroup'

interface LayoutColumnProps {
  layout: TaskLayout
  column: LayoutColumnModel
  /** Resolved px width and flex order of this column in the strip. */
  width: number | undefined
  order: number
  onActivateTab?: (instanceId: string) => void
}

/**
 * One strip column: its visible groups stacked top to bottom by weight.
 *
 * A column showing just the panel it is named after (every Classic column) renders
 * that panel bare — the panel's frame takes the column's width and order itself
 * (they are keyed by the same id) — so Classic adds no wrapper to the DOM.
 */
export function LayoutColumn({
  layout,
  column,
  width,
  order,
  onActivateTab
}: LayoutColumnProps): React.JSX.Element | null {
  const slots = column.slots.filter(isSlotVisible)
  if (slots.length === 0) return null
  const bare =
    slots.length === 1 &&
    !slots[0].name &&
    slots[0].tabs.filter((t) => !t.hidden).length === 1 &&
    slots[0].tabs.find((t) => !t.hidden)?.instanceId === column.id
  if (bare) return <TabGroup layout={layout} slot={slots[0]} onActivateTab={onActivateTab} />

  return (
    <div
      data-column-id={column.id}
      className="shrink-0 min-h-0 flex flex-col gap-4"
      style={{ width, order }}
    >
      {slots.map((slot) => (
        <div
          key={slot.id}
          className="min-h-0 flex [&>[data-panel-id]]:flex-1"
          style={{ flex: `${slot.weight} 1 0` }}
        >
          <TabGroup layout={layout} slot={slot} onActivateTab={onActivateTab} />
        </div>
      ))}
    </div>
  )
}

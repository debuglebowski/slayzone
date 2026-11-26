import { Fragment, use } from 'react'
import type { LayoutColumn as LayoutColumnModel, TaskLayout } from '@slayzone/task-contracts'
import { isSlotVisible } from '@slayzone/task-contracts'
import { PanelCellContext } from '../panels/PanelFrame'
import { ResizeHandle } from '../ResizeHandle'
import { LayoutActionsContext } from './LayoutContext'
import { TabGroup } from './TabGroup'

/** A slot never shrinks below this while dragging a divider. */
export const MIN_SLOT_HEIGHT_PX = 80

interface LayoutColumnProps {
  layout: TaskLayout
  column: LayoutColumnModel
  /** Resolved px width and flex order of this column in the strip. */
  width: number | undefined
  order: number
  compact?: boolean
}

/**
 * One strip column: its visible groups stacked top to bottom by weight, a
 * divider between neighbours that moves weight from one to the other (persisted
 * in the layout; double-click evens the pair out).
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
  compact = false
}: LayoutColumnProps): React.JSX.Element | null {
  const actions = use(LayoutActionsContext)
  const slots = column.slots.filter(isSlotVisible)
  const bare =
    slots.length === 1 &&
    !slots[0].name &&
    slots[0].tabs.filter((t) => !t.hidden).length === 1 &&
    slots[0].tabs.find((t) => !t.hidden)?.instanceId === column.id
  if (slots.length === 0) return null
  if (bare || compact) return <TabGroup layout={layout} slot={slots[0]} compact={compact} />

  return (
    <div
      data-column-id={column.id}
      className="shrink-0 min-h-0 min-w-0 flex flex-col"
      style={{ width, order }}
    >
      <PanelCellContext value={true}>
        {slots.map((slot, i) => {
          const above = slots[i - 1]
          return (
            <Fragment key={slot.id}>
              {above && actions && (
                <ResizeHandle
                  axis="y"
                  measureSiblings
                  leftWidth={0}
                  rightWidth={0}
                  leftMinWidth={MIN_SLOT_HEIGHT_PX}
                  rightMinWidth={MIN_SLOT_HEIGHT_PX}
                  onResize={(top, bottom) => {
                    const pair = above.weight + slot.weight
                    const sum = top + bottom
                    if (sum <= 0) return
                    actions.resizeSlots(
                      column.id,
                      { [above.id]: (pair * top) / sum, [slot.id]: (pair * bottom) / sum },
                      false
                    )
                  }}
                  onDragStart={actions.onResizeStart}
                  onDragEnd={actions.onResizeEnd}
                  onReset={() => {
                    const even = (above.weight + slot.weight) / 2
                    actions.resizeSlots(column.id, { [above.id]: even, [slot.id]: even }, true)
                  }}
                />
              )}
              <div
                data-slot-id={slot.id}
                className="min-h-0 min-w-0 flex"
                style={{ flex: `${slot.weight} 1 0` }}
              >
                <TabGroup layout={layout} slot={slot} />
              </div>
            </Fragment>
          )
        })}
      </PanelCellContext>
    </div>
  )
}

import { memo, useLayoutEffect, useSyncExternalStore, type Key, type ReactNode } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'
import { stableAnchorKey } from './useChatDisplay'
import { TimelineRowIndexContext, TimelineRowKeyContext } from './row-ui-state'
import type { VirtualTimelineController } from './virtual-timeline'

export interface VirtualTimelineRowsProps {
  controller: VirtualTimelineController
  items: readonly TimelineItem[]
  itemKey: (item: TimelineItem, index: number) => Key
  renderRow: (item: TimelineItem, index: number) => ReactNode
  /** A row's index in the timeline (`data-row`: scroll anchors keep it). */
  rowOf?: (item: TimelineItem) => number | undefined
}

/**
 * The timeline's rows, only those in or near the view mounted (plan 4.1). The
 * one component that re-renders while scrolling: a row's content is memoized on
 * its item, so moving the view re-renders only rows that come into it.
 *
 * Rows are absolutely positioned at their measured offsets; each contains its
 * own margins (`flow-root`), so its measured height is the room it takes.
 *
 * Its props change only when the rows do — never for a stream delta (deltas
 * live outside `timeline`, see `useLiveBlock`) — so a delta re-renders none of
 * them but the one that streams. `memo` keeps that true with or without the
 * compiler's caching of this element in its parent.
 */
export const VirtualTimelineRows = memo(function VirtualTimelineRows({
  controller,
  items,
  itemKey,
  renderRow,
  rowOf
}: VirtualTimelineRowsProps) {
  const version = useSyncExternalStore(
    controller.subscribe,
    controller.getVersion,
    controller.getVersion
  )
  const view = controller.view(items, itemKey, version)
  useLayoutEffect(() => {
    controller.afterRender()
  })
  return (
    <div data-virtual-list className="relative w-full" style={{ height: view.totalSize }}>
      {view.items.map((row) => (
        <TimelineRow
          key={row.key}
          rowKey={row.key}
          item={items[row.index]}
          index={row.index}
          row={rowOf?.(items[row.index])}
          start={row.start}
          measure={controller.measureElement}
          renderRow={renderRow}
        />
      ))}
    </div>
  )
})

const TimelineRow = memo(function TimelineRow({
  rowKey,
  item,
  index,
  row,
  start,
  measure,
  renderRow
}: {
  rowKey: Key
  item: TimelineItem
  index: number
  row: number | undefined
  start: number
  measure: (el: HTMLElement | null) => void
  renderRow: (item: TimelineItem, index: number) => ReactNode
}) {
  return (
    <div
      ref={measure}
      data-index={index}
      data-row={row}
      data-item-key={String(rowKey)}
      data-anchor-key={stableAnchorKey(item) ?? undefined}
      className="absolute inset-x-0 top-0 flow-root"
      style={{ transform: `translateY(${start}px)` }}
    >
      <TimelineRowKeyContext.Provider value={String(rowKey)}>
        <TimelineRowIndexContext.Provider value={row}>
          <RowContent item={item} index={index} renderRow={renderRow} />
        </TimelineRowIndexContext.Provider>
      </TimelineRowKeyContext.Provider>
    </div>
  )
})

/** What a row shows: re-renders only when its item (or position in the list) does. */
const RowContent = memo(function RowContent({
  item,
  index,
  renderRow
}: {
  item: TimelineItem
  index: number
  renderRow: (item: TimelineItem, index: number) => ReactNode
}) {
  return <>{renderRow(item, index)}</>
})

import { useLayoutEffect, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ListLayout, observeListLayout } from './DiffView.layout'

// ---- Virtualized row list (shared for unified + sbs) ----

interface VirtualRowListProps<Row> {
  rows: Row[]
  renderRow: (row: Row, index: number) => React.ReactNode
  estimateSize: number
  rowKey: (row: Row) => string
  className?: string
}

export function VirtualRowList<Row>({
  rows,
  renderRow,
  estimateSize,
  rowKey,
  className
}: VirtualRowListProps<Row>) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [layout, setLayout] = useState<ListLayout | null>(null)
  useLayoutEffect(() => {
    if (!element) return
    return observeListLayout(element, (next) => {
      setLayout((previous) =>
        previous?.parent === next.parent && Math.abs(previous.offset - next.offset) < 0.01
          ? previous
          : next
      )
    })
  }, [element])
  const parent = layout?.parent ?? null
  const offset = layout?.offset ?? 0
  const virtualizer = useVirtualizer({
    count: rows.length,
    // TanStack includes this origin in item starts and excludes it from total size.
    scrollMargin: offset,
    getScrollElement: () => parent,
    estimateSize: () => estimateSize,
    overscan: 8,
    getItemKey: (i) => rowKey(rows[i])
  })

  // Measurement frame: until scroll state known, reserve space with estimate.
  if (layout === null) {
    return (
      <div ref={setElement} className={className} style={{ height: rows.length * estimateSize }} />
    )
  }

  // Nested inside an outer virtualizer (e.g. GitDiffPanel continuous-flow mode)
  // — fall back to plain rendering. Outer virtualizer keeps offscreen files
  // unmounted, which handles the large-diff case at the file granularity.
  if (layout.parent === null) {
    return (
      <div ref={setElement} className={className}>
        {rows.map((r, i) => (
          <div key={rowKey(r)}>{renderRow(r, i)}</div>
        ))}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div
      ref={setElement}
      className={className}
      style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
    >
      {items.map((v) => (
        <div
          key={v.key}
          data-index={v.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${v.start - offset}px)`
          }}
        >
          {renderRow(rows[v.index], v.index)}
        </div>
      ))}
    </div>
  )
}

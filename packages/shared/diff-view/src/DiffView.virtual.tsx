import { useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { findScrollParent } from './DiffView.scroll'

// ---- Virtualized row list (shared for unified + sbs) ----

interface VirtualRowListProps<Row> {
  rows: Row[]
  renderRow: (row: Row, index: number) => React.ReactNode
  estimateSize: number
  rowKey: (row: Row) => string
  className?: string
}

type ScrollState = { parent: HTMLElement; nested: false } | { parent: null; nested: true } | null

export function VirtualRowList<Row>({
  rows,
  renderRow,
  estimateSize,
  rowKey,
  className
}: VirtualRowListProps<Row>) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const [scrollState, setScrollState] = useState<ScrollState>(null)

  useLayoutEffect(() => {
    const parent = findScrollParent(sentinelRef.current)
    if (parent) setScrollState({ parent, nested: false })
    else setScrollState({ parent: null, nested: true })
  }, [])

  const parent = scrollState?.nested === false ? scrollState.parent : null
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent,
    estimateSize: () => estimateSize,
    overscan: 8,
    getItemKey: (i) => rowKey(rows[i])
  })

  // Measurement frame: until scroll state known, reserve space with estimate.
  if (scrollState === null) {
    return (
      <div ref={sentinelRef} className={className} style={{ height: rows.length * estimateSize }} />
    )
  }

  // Nested inside an outer virtualizer (e.g. GitDiffPanel continuous-flow mode)
  // — fall back to plain rendering. Outer virtualizer keeps offscreen files
  // unmounted, which handles the large-diff case at the file granularity.
  if (scrollState.nested) {
    return (
      <div ref={sentinelRef} className={className}>
        {rows.map((r, i) => (
          <div key={rowKey(r)}>{renderRow(r, i)}</div>
        ))}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div
      ref={sentinelRef}
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
            transform: `translateY(${v.start}px)`
          }}
        >
          {renderRow(rows[v.index], v.index)}
        </div>
      ))}
    </div>
  )
}

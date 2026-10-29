import { memo, useEffect, useMemo, useState } from 'react'
import { FileImage, FileMinus } from 'lucide-react'
import { cn } from '@slayzone/ui'
import { ensureInlineHighlights } from './parse-diff'
import { tokenizeContent } from './highlight'
import type { DiffViewProps, FlatLine, SbsRow, UnifiedRow } from './DiffView.types'
import { flattenDiff, applySpans } from './DiffView.flatten'
import { computeChunks, buildUnifiedRows, buildSbsRowList } from './DiffView.chunks'
import { UnifiedLine, SbsHalf, GapDivider } from './DiffView.render'
import { useSbsSync } from './DiffView.scroll'
import { VirtualRowList } from './DiffView.virtual'

// Threshold under which virtualization overhead isn't worth it. Small diffs
// render every row directly so there's no measurement/positioning overhead.
const VIRTUALIZE_THRESHOLD = 100

// ---- Side-by-side column renderers ----
// Two columns each scroll horizontally as ONE unit. Both show native
// overlay scrollbars; useSbsSync mirrors scrollLeft so the two halves
// stay locked together.

export const DiffView = memo(function DiffView({
  diff,
  sideBySide = false,
  wrap = false,
  contextLines = '3'
}: DiffViewProps) {
  // Lazy inline-highlight pass: parseUnifiedDiff no longer runs this per-file.
  // Calling here means offscreen files in a large virtualized patch never pay
  // the cost. `ensureInlineHighlights` is idempotent via a flag on FileDiff.
  const flattened = useMemo(() => {
    ensureInlineHighlights(diff)
    return flattenDiff(diff)
  }, [diff])
  const [highlighted, setHighlighted] = useState<FlatLine[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setHighlighted(null)
    const { flat, refs, oldContent, newContent } = flattened
    if (flat.length === 0) return
    Promise.all([tokenizeContent(oldContent, diff.path), tokenizeContent(newContent, diff.path)])
      .then(([oldSpans, newSpans]) => {
        if (cancelled) return
        setHighlighted(applySpans(flat, refs, oldSpans, newSpans))
      })
      .catch(() => {
        // highlight.ts already swallows/logs; fall through to plain rendering
      })
    return () => {
      cancelled = true
    }
  }, [flattened, diff.path])

  const flat = highlighted ?? flattened.flat
  const chunks = useMemo(() => computeChunks(flat, contextLines), [flat, contextLines])

  const unifiedRows = useMemo(
    () => (sideBySide ? [] : buildUnifiedRows(chunks)),
    [chunks, sideBySide]
  )
  const sbsRows = useMemo(() => (sideBySide ? buildSbsRowList(chunks) : []), [chunks, sideBySide])

  const sbsSync = useSbsSync()

  if (diff.isBinary) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileImage className="size-10 opacity-30" />
          <div className="text-center">
            <p className="text-base font-medium text-foreground/60">Binary file</p>
            <p className="text-sm mt-0.5 opacity-60">Diff not available for binary files</p>
          </div>
        </div>
      </div>
    )
  }

  if (flat.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <FileMinus className="size-10 opacity-30" />
          <div className="text-center">
            <p className="text-base font-medium text-foreground/60">No changes</p>
            <p className="text-sm mt-0.5 opacity-60">Metadata or mode change only</p>
          </div>
        </div>
      </div>
    )
  }

  if (sideBySide) {
    const renderLeft = (row: SbsRow) => {
      if (row.kind === 'gap') return <GapDivider count={row.count} />
      return <SbsHalf item={row.row.left} side="left" wrap={wrap} />
    }
    const renderRight = (row: SbsRow) => {
      if (row.kind === 'gap') return <GapDivider count={row.count} />
      return <SbsHalf item={row.row.right} side="right" wrap={wrap} />
    }
    // Small diffs: skip virtualizer overhead entirely.
    if (sbsRows.length < VIRTUALIZE_THRESHOLD) {
      return (
        <div className="relative font-mono text-xs leading-5 flex">
          <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-border/40 z-10" />
          <div
            ref={sbsSync.register}
            onScroll={sbsSync.onScroll}
            className={cn('basis-1/2 min-w-0', !wrap && 'overflow-x-auto')}
          >
            <div className={cn('flex flex-col', !wrap && 'min-w-full w-max')}>
              {sbsRows.map((r) => (
                <div key={r.key}>{renderLeft(r)}</div>
              ))}
            </div>
          </div>
          <div
            ref={sbsSync.register}
            onScroll={sbsSync.onScroll}
            className={cn('basis-1/2 min-w-0', !wrap && 'overflow-x-auto')}
          >
            <div className={cn('flex flex-col', !wrap && 'min-w-full w-max')}>
              {sbsRows.map((r) => (
                <div key={r.key}>{renderRight(r)}</div>
              ))}
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="relative font-mono text-xs leading-5 flex">
        <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 w-px bg-border/40 z-10" />
        <div
          ref={sbsSync.register}
          onScroll={sbsSync.onScroll}
          className={cn('basis-1/2 min-w-0', !wrap && 'overflow-x-auto scrollbar-hide')}
        >
          <div className={cn(!wrap && 'min-w-full w-max')}>
            <VirtualRowList<SbsRow>
              rows={sbsRows}
              renderRow={renderLeft}
              estimateSize={20}
              rowKey={(r) => r.key}
            />
          </div>
        </div>
        <div
          ref={sbsSync.register}
          onScroll={sbsSync.onScroll}
          className={cn('basis-1/2 min-w-0', !wrap && 'overflow-x-auto')}
        >
          <div className={cn(!wrap && 'min-w-full w-max')}>
            <VirtualRowList<SbsRow>
              rows={sbsRows}
              renderRow={renderRight}
              estimateSize={20}
              rowKey={(r) => r.key}
            />
          </div>
        </div>
      </div>
    )
  }

  const renderUnifiedRow = (row: UnifiedRow) => {
    if (row.kind === 'gap') return <GapDivider count={row.count} />
    return <UnifiedLine item={row.item} wrap={wrap} />
  }

  // Small diffs: skip virtualizer overhead entirely.
  if (unifiedRows.length < VIRTUALIZE_THRESHOLD) {
    return (
      <div className={cn('font-mono text-xs leading-5', !wrap && 'overflow-x-auto')}>
        <div className={cn('flex flex-col', !wrap && 'min-w-full w-max')}>
          {unifiedRows.map((r) => (
            <div key={r.key}>{renderUnifiedRow(r)}</div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('font-mono text-xs leading-5', !wrap && 'overflow-x-auto')}>
      <div className={cn(!wrap && 'min-w-full w-max')}>
        <VirtualRowList<UnifiedRow>
          rows={unifiedRows}
          renderRow={renderUnifiedRow}
          estimateSize={20}
          rowKey={(r) => r.key}
        />
      </div>
    </div>
  )
})

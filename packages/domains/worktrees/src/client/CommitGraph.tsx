import { cn, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { memo, useState, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ResolvedGraph } from '../shared/types'
import {
  ROW_HEIGHT,
  COLUMN_WIDTH,
  DOT_RADIUS,
  GUTTER_PAD,
  DOT_HIT_SIZE,
  MERGED_DOT_OFFSET,
  colX,
  rowY
} from './CommitGraph.constants'
import { getColor, getBranchColor } from './dag-colors'
import { computeDagLayout, computeCollapsedDag, computeTipsLayout } from './dag-layout'
import { SvgStraightEdge, SvgCurveEdge, SvgDot, DotOverlays } from './graph-svg'
import { CommitRow } from './CommitRow'

// Re-export the pure layout module so deep-path importers (e.g. unit tests that
// import from '../client/CommitGraph') keep resolving the same symbols.
export {
  computeDagLayout,
  computeCollapsedDag,
  computeTipsLayout
} from './dag-layout'
export type { LayoutNode, LayoutEdge, DagLayout, CollapsedDag } from './dag-layout'

// --- Public interface ---

interface CommitGraphProps {
  graph: ResolvedGraph
  filterQuery?: string
  tipsOnly?: boolean
  /** When tipsOnly, break collapse chain at tagged commits */
  includeTags?: boolean
  /** When tipsOnly, break collapse chain at merged PR commits (syntheticBranch) */
  breakOnMerges?: boolean
  /** Max rows to render (layout uses all commits for accurate topology) */
  renderLimit?: number
  className?: string
}

// --- Copy hash hook ---

function useCopyHash() {
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleCopy = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedHash(null), 1500)
  }, [])

  return { copiedHash, handleCopy }
}

// --- Main component ---

const OVERSCAN = 10

function CommitGraphImpl({
  graph,
  filterQuery,
  tipsOnly,
  includeTags,
  breakOnMerges,
  renderLimit,
  className
}: CommitGraphProps) {
  const { copiedHash, handleCopy } = useCopyHash()
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const hasTopology = useMemo(() => graph.commits.some((c) => c.parents.length > 0), [graph])
  const fullLayout = useMemo(
    () =>
      hasTopology
        ? computeDagLayout(graph.commits, graph.baseBranch)
        : computeTipsLayout(graph.commits, graph.baseBranch),
    [graph, hasTopology]
  )
  const collapsed = useMemo(
    () =>
      tipsOnly
        ? computeCollapsedDag(fullLayout, graph.baseBranch, includeTags, breakOnMerges, renderLimit)
        : null,
    [fullLayout, graph.baseBranch, tipsOnly, includeTags, breakOnMerges, renderLimit]
  )

  // Map colorIndex → branch name for tooltip overlays
  const colorBranch = useMemo(() => {
    const map = new Map<number, string>()
    for (const node of fullLayout.nodes) {
      if (map.has(node.colorIndex)) continue
      if (node.commit.branch) {
        map.set(node.colorIndex, node.commit.branch)
      }
    }
    return map
  }, [fullLayout])

  // Filter dimming
  const matchSet = useMemo(() => {
    if (!filterQuery) return null
    const q = filterQuery.toLowerCase()
    const set = new Set<string>()
    for (const c of graph.commits) {
      if (
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.branchRefs.some((r) => r.toLowerCase().includes(q)) ||
        c.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        set.add(c.hash)
      }
    }
    return set
  }, [graph.commits, filterQuery])

  // Build row x-offsets for merged commits (shift main dot right)
  const rowOffsets = useMemo(() => {
    const map = new Map<number, number>()
    for (const node of fullLayout.nodes) {
      if (node.syntheticBranch) map.set(node.row, MERGED_DOT_OFFSET)
    }
    return map
  }, [fullLayout])

  // Choose layout: collapsed or full
  const layout = collapsed ?? fullLayout
  const activeRowOffsets = collapsed ? collapsed.rowOffsets : rowOffsets
  const maxRow = renderLimit != null ? renderLimit : layout.nodes.length

  // Compute maxColumn from only the rendered rows so stale branches deep in history
  // don't inflate the gutter width when they're not visible.
  // Synthetic branch dots render at a fixed pixel offset (MERGED_DOT_OFFSET + 12) from
  // the main dot, not at colX(syntheticBranch.column), so don't include them here.
  const visibleMaxColumn = useMemo(() => {
    let max = 0
    for (const n of layout.nodes) {
      if (n.row >= maxRow) continue
      if (n.column > max) max = n.column
    }
    for (const e of layout.edges) {
      if (e.fromRow >= maxRow && e.toRow >= maxRow) continue
      if (e.fromCol > max) max = e.fromCol
      if (e.toCol > max) max = e.toCol
    }
    return max
  }, [layout, maxRow])
  // Add extra pixel space for synthetic/behind branch dots if any are visible
  const hasBranchIndicators = useMemo(
    () => layout.nodes.some((n) => n.row < maxRow && (n.syntheticBranch || n.behindBranch)),
    [layout.nodes, maxRow]
  )
  const gutterWidth =
    (visibleMaxColumn + 1) * COLUMN_WIDTH +
    GUTTER_PAD +
    (hasBranchIndicators ? MERGED_DOT_OFFSET + 12 + 6 + DOT_RADIUS * 2 : 0)
  const totalRowCount = Math.min(collapsed ? collapsed.totalRows : layout.nodes.length, maxRow)
  const totalHeight = totalRowCount * ROW_HEIGHT

  // Build ordered list of rows for rendering content (commits only, no group placeholders)
  const rowItems = useMemo(() => layout.nodes.filter((n) => n.row < maxRow), [layout.nodes, maxRow])

  // Virtualizer — only render visible rows + overscan buffer
  const virtualizer = useVirtualizer({
    count: rowItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN
  })

  const virtualItems = virtualizer.getVirtualItems()

  // Compute visible row range for filtering SVG/overlays
  const startRow =
    virtualItems.length > 0 && rowItems[virtualItems[0].index]
      ? rowItems[virtualItems[0].index].row
      : 0
  const endRow =
    virtualItems.length > 0 && rowItems[virtualItems[virtualItems.length - 1].index]
      ? rowItems[virtualItems[virtualItems.length - 1].index].row
      : totalRowCount

  // Expand range for edge visibility (edges can span many rows)
  const edgeBufferRows = 5
  const visStartRow = Math.max(0, startRow - edgeBufferRows)
  const visEndRow = Math.min(totalRowCount, endRow + edgeBufferRows)

  // Filter nodes, edges to visible range
  const visibleNodes = useMemo(
    () => layout.nodes.filter((n) => n.row >= visStartRow && n.row <= visEndRow && n.row < maxRow),
    [layout.nodes, visStartRow, visEndRow, maxRow]
  )
  const visibleEdges = useMemo(
    () =>
      layout.edges.filter((e) => {
        if (e.toRow === -1 || e.fromRow >= maxRow) return false
        const eMin = Math.min(e.fromRow, e.toRow)
        const eMax = Math.max(e.fromRow, e.toRow)
        return eMax >= visStartRow && eMin <= visEndRow
      }),
    [layout.edges, visStartRow, visEndRow, maxRow]
  )

  const noMatches = matchSet !== null && matchSet.size === 0

  return (
    <div ref={scrollContainerRef} className={cn('h-full overflow-y-auto', className)}>
      {noMatches && (
        <div className="flex items-center justify-center h-16 text-xs text-muted-foreground">
          No matches
        </div>
      )}
      <div style={{ height: totalHeight, position: 'relative' }}>
        <svg
          className="absolute top-0 left-0 pointer-events-none"
          width={gutterWidth}
          height={totalHeight}
          style={{ zIndex: 0 }}
        >
          {visibleEdges.map((edge, i) => {
            const clampedEdge = edge.toRow >= maxRow ? { ...edge, toRow: maxRow - 1 } : edge
            return clampedEdge.type === 'straight' ? (
              <SvgStraightEdge key={`e-${i}`} edge={clampedEdge} rowOffsets={activeRowOffsets} />
            ) : (
              <SvgCurveEdge key={`e-${i}`} edge={clampedEdge} rowOffsets={activeRowOffsets} />
            )
          })}
          {visibleNodes.map((node) => {
            const offset = activeRowOffsets.get(node.row) ?? 0
            const cx = colX(node.column) + (node.column === 0 ? offset : 0)
            const cy = rowY(node.row)
            const color = getBranchColor(node.commit.branch, node.colorIndex)
            const dotType = node.isMerge ? 'merge' : 'regular'
            const dimmed = matchSet !== null && !matchSet.has(node.commit.hash)
            return (
              <g key={node.commit.hash}>
                <SvgDot cx={cx} cy={cy} color={color} type={dotType} dimmed={dimmed} />
                {node.syntheticBranch &&
                  (() => {
                    const bx = cx + MERGED_DOT_OFFSET + 12 + 6
                    const by = cy + 12
                    const sc = getColor(node.syntheticBranch.colorIndex)
                    return (
                      <g opacity={dimmed ? 0.2 : undefined}>
                        <path
                          d={`M${bx},${by} C${cx},${by} ${cx},${cy} ${cx},${cy}`}
                          stroke={sc}
                          strokeWidth={2}
                          fill="none"
                          opacity={0.35}
                        />
                        <circle cx={bx} cy={by} r={DOT_RADIUS} fill={sc} />
                      </g>
                    )
                  })()}
                {node.behindBranch &&
                  (() => {
                    const bx = cx + MERGED_DOT_OFFSET + 12 + 6
                    const by = cy - 12
                    const sc = getColor(node.behindBranch.colorIndex)
                    return (
                      <g opacity={dimmed ? 0.2 : undefined}>
                        <path
                          d={`M${bx},${by} C${cx},${by} ${cx},${cy} ${cx},${cy}`}
                          stroke={sc}
                          strokeWidth={2}
                          fill="none"
                          opacity={0.35}
                        />
                        <circle cx={bx} cy={by} r={DOT_RADIUS} fill={sc} />
                      </g>
                    )
                  })()}
              </g>
            )
          })}
          {visibleEdges
            .filter((e) => e.collapsedCount)
            .map((edge, i) => {
              const midY = (rowY(edge.fromRow) + rowY(edge.toRow)) / 2
              const cx =
                edge.fromCol === edge.toCol
                  ? colX(edge.fromCol)
                  : (colX(edge.fromCol) + colX(edge.toCol)) / 2
              return (
                <g key={`ci-${i}`}>
                  <line
                    x1={cx - 4}
                    y1={midY - 1.5}
                    x2={cx + 4}
                    y2={midY - 1.5}
                    stroke={edge.color}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    opacity={0.25}
                  />
                  <line
                    x1={cx - 4}
                    y1={midY + 1.5}
                    x2={cx + 4}
                    y2={midY + 1.5}
                    stroke={edge.color}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    opacity={0.25}
                  />
                </g>
              )
            })}
        </svg>
        <DotOverlays
          items={[
            ...visibleNodes.map((node) => ({
              key: node.commit.hash,
              row: node.row,
              column: node.column,
              color: getBranchColor(node.commit.branch, node.colorIndex),
              branchName: colorBranch.get(node.colorIndex),
              xOffset: node.column === 0 ? (activeRowOffsets.get(node.row) ?? 0) : 0
            })),
            ...visibleNodes
              .filter((n) => n.syntheticBranch)
              .map((node) => ({
                key: `${node.commit.hash}-synth`,
                row: node.row,
                column: node.column,
                color: getColor(node.syntheticBranch!.colorIndex),
                branchName: node.syntheticBranch!.branchName,
                xOffset: (activeRowOffsets.get(node.row) ?? 0) + MERGED_DOT_OFFSET + 12 + 6,
                yOffset: 12,
                isSynthetic: true
              })),
            ...visibleNodes
              .filter((n) => n.behindBranch)
              .map((node) => ({
                key: `${node.commit.hash}-behind`,
                row: node.row,
                column: node.column,
                color: getColor(node.behindBranch!.colorIndex),
                branchName: node.behindBranch!.branchName,
                xOffset: MERGED_DOT_OFFSET + 12 + 6,
                yOffset: -12
              }))
          ]}
        />
        {visibleEdges
          .filter((e) => e.collapsedCount)
          .map((edge, i) => {
            const midY = (rowY(edge.fromRow) + rowY(edge.toRow)) / 2
            const cx =
              edge.fromCol === edge.toCol
                ? colX(edge.fromCol)
                : (colX(edge.fromCol) + colX(edge.toCol)) / 2
            return (
              <Tooltip key={`ci-tip-${i}`}>
                <TooltipTrigger asChild>
                  <div
                    className="absolute"
                    style={{
                      left: cx - DOT_HIT_SIZE / 2,
                      top: midY - DOT_HIT_SIZE / 2,
                      width: DOT_HIT_SIZE,
                      height: DOT_HIT_SIZE,
                      borderRadius: '50%',
                      zIndex: 1
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {edge.collapsedCount} commit{edge.collapsedCount! > 1 ? 's' : ''}
                </TooltipContent>
              </Tooltip>
            )
          })}
        {virtualItems.map((virtualRow) => {
          const node = rowItems[virtualRow.index]
          if (!node) return null
          const dimmed = matchSet !== null && !matchSet.has(node.commit.hash)
          const refs = [...node.commit.branchRefs, ...node.commit.tags.map((t) => `🏷 ${t}`)]
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: ROW_HEIGHT,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <CommitRow
                shortHash={node.commit.shortHash}
                message={node.commit.message}
                author={node.commit.author}
                relativeDate={node.commit.relativeDate}
                refs={refs.length > 0 ? refs : undefined}
                mergedFrom={node.commit.mergedFrom}
                color={getBranchColor(node.commit.branch, node.colorIndex)}
                gutterWidth={gutterWidth}
                copiedHash={copiedHash}
                onCopy={handleCopy}
                dimmed={dimmed}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Memoized export — relies on stable `graph` prop reference (upstream pollers
// dedup their state via content hash + useStablePoll, so the same data does not
// produce a new object). Default shallow check on remaining primitive props
// (filterQuery, tipsOnly, includeTags, breakOnMerges, renderLimit, className).
export const CommitGraph = memo(CommitGraphImpl)

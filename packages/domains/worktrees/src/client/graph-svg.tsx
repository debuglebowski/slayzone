// --- Commit graph SVG rendering helpers ---
// Presentational, stateless components for edges, dots, and dot tooltip overlays.

import { Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import type { LayoutEdge } from './dag-layout'
import {
  colX,
  rowY,
  DOT_RADIUS,
  MERGE_DOT_OUTER,
  MERGE_DOT_INNER,
  DOT_HIT_SIZE
} from './CommitGraph.constants'

export function SvgStraightEdge({
  edge,
  rowOffsets
}: {
  edge: LayoutEdge
  rowOffsets?: Map<number, number>
}) {
  const x1 = colX(edge.fromCol) + (edge.fromCol === 0 ? (rowOffsets?.get(edge.fromRow) ?? 0) : 0)
  const x2 = colX(edge.toCol) + (edge.toCol === 0 ? (rowOffsets?.get(edge.toRow) ?? 0) : 0)
  const y1 = rowY(edge.fromRow),
    y2 = rowY(edge.toRow)
  const dash = edge.dashed ? '4 3' : undefined
  if (x1 !== x2) {
    // Smooth bezier jog between shifted and unshifted positions
    const dy = y2 - y1
    const d = `M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}`
    return (
      <path
        d={d}
        stroke={edge.color}
        strokeWidth={2}
        fill="none"
        opacity={0.35}
        strokeDasharray={dash}
      />
    )
  }
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={edge.color}
      strokeWidth={2}
      opacity={0.35}
      strokeDasharray={dash}
    />
  )
}

export function SvgCurveEdge({
  edge,
  rowOffsets
}: {
  edge: LayoutEdge
  rowOffsets?: Map<number, number>
}) {
  const x1 = colX(edge.fromCol) + (edge.fromCol === 0 ? (rowOffsets?.get(edge.fromRow) ?? 0) : 0)
  const y1 = rowY(edge.fromRow)
  const x2 = colX(edge.toCol) + (edge.toCol === 0 ? (rowOffsets?.get(edge.toRow) ?? 0) : 0)
  const y2 = rowY(edge.toRow)
  const dash = edge.dashed ? '4 3' : undefined

  if (edge.fromRow === edge.toRow) {
    return (
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={edge.color}
        strokeWidth={2}
        opacity={0.35}
        strokeDasharray={dash}
      />
    )
  }

  const dy = y2 - y1
  const d = `M${x1},${y1} C${x1},${y1 + dy * 0.4} ${x2},${y2 - dy * 0.4} ${x2},${y2}`
  return (
    <path
      d={d}
      stroke={edge.color}
      strokeWidth={2}
      fill="none"
      opacity={0.35}
      strokeDasharray={dash}
    />
  )
}

export function SvgDot({
  cx,
  cy,
  color,
  type,
  dimmed
}: {
  cx: number
  cy: number
  color: string
  type: 'merge' | 'regular'
  dimmed?: boolean
}) {
  const opacity = dimmed ? 0.2 : undefined
  if (type === 'merge') {
    return (
      <g opacity={opacity}>
        <circle cx={cx} cy={cy} r={MERGE_DOT_OUTER} fill="none" stroke={color} strokeWidth={2} />
        <circle cx={cx} cy={cy} r={MERGE_DOT_INNER} fill="var(--background, #1a1a1a)" />
      </g>
    )
  }
  return <circle cx={cx} cy={cy} r={DOT_RADIUS} fill={color} opacity={opacity} />
}

// --- Dot tooltip overlay ---

export function DotOverlays({
  items
}: {
  items: Array<{
    key: string
    row: number
    column: number
    color: string
    branchName?: string
    xOffset?: number
    yOffset?: number
    isSynthetic?: boolean
  }>
}) {
  return (
    <>
      {items.map(({ key, row, column, color, branchName, xOffset, yOffset, isSynthetic }) => {
        if (!branchName) return null
        const cx = colX(column) + (xOffset ?? 0)
        const cy = rowY(row) + (yOffset ?? 0)
        return (
          <Tooltip key={key}>
            <TooltipTrigger asChild>
              <div
                className="absolute transition-shadow duration-150"
                style={{
                  left: cx - DOT_HIT_SIZE / 2,
                  top: cy - DOT_HIT_SIZE / 2,
                  width: DOT_HIT_SIZE,
                  height: DOT_HIT_SIZE,
                  borderRadius: '50%',
                  zIndex: 1,
                  boxShadow: `0 0 0 0px ${color}50`
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px ${color}50`
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 0px ${color}50`
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className={isSynthetic ? 'max-w-none' : undefined}>
              {isSynthetic ? (
                <div className="text-left whitespace-nowrap">
                  <div>{branchName}</div>
                  <div className="text-muted-foreground text-[10px]">
                    Merged branch (deleted). See info (i) in toolbar.
                  </div>
                </div>
              ) : (
                branchName
              )}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}

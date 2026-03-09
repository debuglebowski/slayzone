import { cn } from '@slayzone/ui'
import { Copy, Check } from 'lucide-react'
import { useState, useRef, useCallback, useMemo } from 'react'
import type { CommitInfo } from '../shared/types'

export interface GraphNode {
  commit: CommitInfo
  column: number
  type: 'commit' | 'branch-tip' | 'fork-point'
  branchName?: string
  branchLabel?: string
}

interface BranchGraphProps {
  nodes: GraphNode[]
  maxColumns: number
  className?: string
}

const COLUMN_COLORS = [
  'var(--color-primary)',
  '#a78bfa', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f472b6', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
]

function getColor(column: number): string {
  return COLUMN_COLORS[column % COLUMN_COLORS.length]
}

const ROW_HEIGHT = 36
const GUTTER_WIDTH = 20
const DOT_RADIUS = 4

export function BranchGraph({ nodes, maxColumns, className }: BranchGraphProps) {
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const handleCopy = useCallback((hash: string) => {
    navigator.clipboard.writeText(hash)
    setCopiedHash(hash)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedHash(null), 1500)
  }, [])

  const gutterTotal = GUTTER_WIDTH * Math.max(maxColumns, 1) + 12

  // Pre-compute first/last row index per column (avoids O(n²) in render)
  const columnRanges = useMemo(() => {
    const ranges: Record<number, { first: number; last: number }> = {}
    for (let i = 0; i < nodes.length; i++) {
      const col = nodes[i].column
      if (!(col in ranges)) {
        ranges[col] = { first: i, last: i }
      } else {
        ranges[col].last = i
      }
    }
    return ranges
  }, [nodes])

  return (
    <div className={cn('relative', className)}>
      {nodes.map((node, i) => {
        const cx = node.column * GUTTER_WIDTH + GUTTER_WIDTH / 2 + 4
        const color = getColor(node.column)

        return (
          <div
            key={`${node.commit.hash}-${i}`}
            className="flex items-center group hover:bg-accent/50 rounded transition-colors cursor-pointer"
            style={{ height: ROW_HEIGHT }}
            onClick={() => handleCopy(node.commit.shortHash)}
            title="Click to copy hash"
          >
            {/* Gutter with graph lines */}
            <div className="shrink-0 relative" style={{ width: gutterTotal, height: ROW_HEIGHT }}>
              {/* Vertical lines for active columns */}
              {Array.from({ length: maxColumns }, (_, col) => {
                const range = columnRanges[col]
                if (!range || i < range.first || i > range.last) return null

                const lineX = col * GUTTER_WIDTH + GUTTER_WIDTH / 2 + 4
                return (
                  <div
                    key={col}
                    className="absolute top-0"
                    style={{
                      left: lineX - 1,
                      width: 2,
                      height: ROW_HEIGHT,
                      backgroundColor: getColor(col),
                      opacity: 0.3
                    }}
                  />
                )
              })}

              {/* Fork line: horizontal from trunk to branch */}
              {node.type === 'fork-point' && maxColumns > 1 && (
                <div
                  className="absolute"
                  style={{
                    left: cx,
                    top: ROW_HEIGHT / 2 - 1,
                    width: (maxColumns - 1) * GUTTER_WIDTH,
                    height: 2,
                    backgroundColor: getColor(1),
                    opacity: 0.3
                  }}
                />
              )}

              {/* Dot */}
              <div
                className="absolute rounded-full"
                style={{
                  left: cx - DOT_RADIUS,
                  top: ROW_HEIGHT / 2 - DOT_RADIUS,
                  width: DOT_RADIUS * 2,
                  height: DOT_RADIUS * 2,
                  backgroundColor: node.type === 'branch-tip' ? color : undefined,
                  border: node.type === 'branch-tip' ? 'none' : `2px solid ${color}`,
                  boxShadow: node.type === 'branch-tip' ? `0 0 6px ${color}40` : undefined,
                  zIndex: 1
                }}
              />
            </div>

            {/* Commit info */}
            <div className="flex-1 min-w-0 flex items-center gap-2 pr-3">
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">
                  {node.branchLabel && (
                    <span
                      className="inline-block px-1.5 py-0 rounded text-[10px] font-medium mr-1.5"
                      style={{ backgroundColor: `${color}20`, color }}
                    >
                      {node.branchLabel}
                    </span>
                  )}
                  {node.commit.message}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  <span className="font-mono">{node.commit.shortHash}</span>
                  {' · '}{node.commit.author}
                  {' · '}{node.commit.relativeDate}
                </div>
              </div>
              {copiedHash === node.commit.shortHash ? (
                <Check className="h-3 w-3 text-green-500 shrink-0" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'
import { X } from 'lucide-react'

export interface DependencyEdgeData {
  depType: 'explicit' | 'implicit'
  onDelete?: (edgeId: string) => void
  [key: string]: unknown
}

export const DependencyEdge = memo(function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const { depType, onDelete } = (data ?? {}) as DependencyEdgeData
  const isImplicit = depType === 'implicit'

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          strokeDasharray: isImplicit ? '5 5' : undefined,
          stroke: isImplicit ? 'var(--color-muted-foreground)' : 'var(--color-primary)',
          strokeWidth: isImplicit ? 1 : 1.5,
          opacity: isImplicit ? 0.5 : 0.8,
        }}
        markerEnd={markerEnd}
      />
      {!isImplicit && onDelete && (
        <EdgeLabelRenderer>
          <button
            onClick={() => onDelete(id)}
            className="nodrag nopan absolute flex h-4 w-4 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
          >
            <X className="size-2.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

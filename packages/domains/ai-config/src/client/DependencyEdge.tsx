import { memo } from 'react'
import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react'

export interface DependencyEdgeData {
  depType: 'explicit' | 'implicit'
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
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        ...style,
        strokeDasharray: '5 5',
        stroke: 'var(--color-muted-foreground)',
        strokeWidth: 1,
        opacity: 0.5,
      }}
      markerEnd={markerEnd}
    />
  )
})

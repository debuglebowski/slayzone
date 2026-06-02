import { useRef, useCallback, useEffect, type CSSProperties } from 'react'

interface ResizeHandleProps {
  /** Current width of the panel immediately left of this handle */
  leftWidth: number
  /** Current width of the panel immediately right of this handle */
  rightWidth: number
  leftMinWidth: number
  rightMinWidth: number
  /** Optional max widths — drag won't grow a panel past these */
  leftMaxWidth?: number
  rightMaxWidth?: number
  /** Commit new widths for both adjacent panels (their sum is preserved) */
  onResize: (leftWidth: number, rightWidth: number) => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onReset?: () => void
  style?: CSSProperties
}

/**
 * Divider between two panels. Dragging moves the shared boundary: the left
 * panel grows while the right panel shrinks (and vice versa). The pair's
 * combined width is kept constant, so no other panel shifts and no dead space
 * opens up — regardless of which panels sit on either side.
 */
export function ResizeHandle({
  leftWidth,
  rightWidth,
  leftMinWidth,
  rightMinWidth,
  leftMaxWidth,
  rightMaxWidth,
  onResize,
  onDragStart,
  onDragEnd,
  onReset,
  style
}: ResizeHandleProps) {
  const isDragging = useRef(false)
  const startX = useRef(0)
  const startLeft = useRef(leftWidth)
  const startRight = useRef(rightWidth)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      cleanupRef.current?.()
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDragging.current = true
      startX.current = e.clientX
      startLeft.current = leftWidth
      startRight.current = rightWidth
      onDragStart?.()

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return
        const delta = e.clientX - startX.current
        const total = startLeft.current + startRight.current
        // newLeft bounds: respect both panels' min AND max (right's bounds map to
        // newLeft = total - rightWidth).
        const lower = Math.max(leftMinWidth, total - (rightMaxWidth ?? Infinity))
        const upper = Math.min(leftMaxWidth ?? Infinity, total - rightMinWidth)
        const target = Math.min(upper, Math.max(lower, startLeft.current + delta))
        const newLeft = lower > upper ? lower : target
        onResize(newLeft, total - newLeft)
      }

      const handleMouseUp = () => {
        isDragging.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        cleanupRef.current = null
        onDragEnd?.()
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      cleanupRef.current = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }
    },
    [
      leftWidth,
      rightWidth,
      leftMinWidth,
      rightMinWidth,
      leftMaxWidth,
      rightMaxWidth,
      onResize,
      onDragStart,
      onDragEnd
    ]
  )

  return (
    <div
      data-testid="panel-resize-handle"
      className="w-4 shrink-0 cursor-col-resize flex items-center justify-center group z-10"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      style={style}
    >
      <div className="w-1 h-8 rounded-full opacity-0 group-hover:opacity-100 group-active:opacity-100 bg-primary/30 group-active:bg-primary/50 transition-opacity" />
    </div>
  )
}

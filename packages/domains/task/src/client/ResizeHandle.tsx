import { useRef, useCallback, useEffect, type CSSProperties } from 'react'

interface ResizeHandleProps {
  /**
   * `x` (default): a vertical divider between two columns. `y`: a horizontal
   * divider between two stacked slots — "left"/"right" then mean top/bottom and
   * the widths are heights.
   */
  axis?: 'x' | 'y'
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
  /**
   * Take the starting sizes from the handle's neighbouring elements (their
   * rendered width/height) instead of `leftWidth`/`rightWidth` — for neighbours
   * sized by flex weight rather than resolved px.
   */
  measureSiblings?: boolean
  style?: CSSProperties
}

/**
 * Divider between two panels. Dragging moves the shared boundary: the left
 * panel grows while the right panel shrinks (and vice versa). The pair's
 * combined width is kept constant, so no other panel shifts and no dead space
 * opens up — regardless of which panels sit on either side.
 */
export function ResizeHandle({
  axis = 'x',
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
  measureSiblings = false,
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
      startX.current = axis === 'y' ? e.clientY : e.clientX
      startLeft.current = leftWidth
      startRight.current = rightWidth
      if (measureSiblings) {
        const size = (el: Element | null): number => {
          const r = el?.getBoundingClientRect()
          return r ? (axis === 'y' ? r.height : r.width) : 0
        }
        startLeft.current = size(e.currentTarget.previousElementSibling)
        startRight.current = size(e.currentTarget.nextElementSibling)
      }
      onDragStart?.()

      const handleMouseMove = (e: MouseEvent) => {
        if (!isDragging.current) return
        const delta = (axis === 'y' ? e.clientY : e.clientX) - startX.current
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
      axis,
      measureSiblings,
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
      data-testid={axis === 'y' ? 'slot-resize-handle' : 'panel-resize-handle'}
      className={
        axis === 'y'
          ? 'h-4 shrink-0 cursor-row-resize flex items-center justify-center group z-10'
          : 'w-4 shrink-0 cursor-col-resize flex items-center justify-center group z-10'
      }
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      style={style}
    >
      <div
        className={
          axis === 'y'
            ? 'h-1 w-8 rounded-full opacity-0 group-hover:opacity-100 group-active:opacity-100 bg-primary/30 group-active:bg-primary/50 transition-opacity'
            : 'w-1 h-8 rounded-full opacity-0 group-hover:opacity-100 group-active:opacity-100 bg-primary/30 group-active:bg-primary/50 transition-opacity'
        }
      />
    </div>
  )
}

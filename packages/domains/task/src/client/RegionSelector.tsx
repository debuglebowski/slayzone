import { useState, useCallback, useRef, useEffect } from 'react'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface RegionSelectorProps {
  onSelect: (rect: Rect) => void
  onCancel: () => void
}

export function RegionSelector({ onSelect, onCancel }: RegionSelectorProps) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setStart({ x: e.clientX, y: e.clientY })
    setCurrent({ x: e.clientX, y: e.clientY })
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!start) return
      setCurrent({ x: e.clientX, y: e.clientY })
    },
    [start]
  )

  const handleMouseUp = useCallback(() => {
    if (!start || !current) return
    const x = Math.min(start.x, current.x)
    const y = Math.min(start.y, current.y)
    const width = Math.abs(current.x - start.x)
    const height = Math.abs(current.y - start.y)

    if (width < 10 || height < 10) {
      onCancel()
      return
    }

    onSelect({ x, y, width, height })
  }, [start, current, onSelect, onCancel])

  // Escape to cancel (capture phase to beat xterm's key handler)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
  }, [onCancel])

  // Auto-focus overlay on mount
  useEffect(() => {
    overlayRef.current?.focus()
  }, [])

  const selectionRect =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y)
        }
      : null

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      data-testid="region-selector-overlay"
      className="fixed inset-0 z-[9999] cursor-crosshair select-none outline-none"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Selection rectangle (clear cutout) */}
      {selectionRect && selectionRect.width > 0 && selectionRect.height > 0 && (
        <>
          <div
            className="absolute border-2 border-white/80 bg-transparent"
            style={selectionRect}
          />
          {/* Dimension label */}
          <div
            className="absolute text-xs text-white/80 bg-black/60 px-1.5 py-0.5 rounded"
            style={{
              left: selectionRect.left,
              top: selectionRect.top + selectionRect.height + 4
            }}
          >
            {Math.round(selectionRect.width)} x {Math.round(selectionRect.height)}
          </div>
        </>
      )}
    </div>
  )
}

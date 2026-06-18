import { useCallback, useRef } from 'react'

interface SidebarResizeHandleProps {
  currentWidth: number
  minWidth: number
  maxWidth: number
  defaultWidth: number
  onChange: (width: number) => void
  onReset: () => void
  onDragStateChange?: (dragging: boolean) => void
}

export function SidebarResizeHandle({
  currentWidth,
  minWidth,
  maxWidth,
  defaultWidth,
  onChange,
  onReset,
  onDragStateChange
}: SidebarResizeHandleProps) {
  const startRef = useRef<{ x: number; w: number } | null>(null)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      startRef.current = { x: e.clientX, w: currentWidth }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      onDragStateChange?.(true)

      const move = (ev: MouseEvent) => {
        if (!startRef.current) return
        const delta = ev.clientX - startRef.current.x
        const next = Math.min(maxWidth, Math.max(minWidth, startRef.current.w + delta))
        onChange(next)
      }
      const up = () => {
        startRef.current = null
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        onDragStateChange?.(false)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [currentWidth, minWidth, maxWidth, onChange, onDragStateChange]
  )

  void defaultWidth

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      className="group absolute right-0.5 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center"
    >
      <div className="h-10 w-1 rounded-full bg-primary/30 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-active:bg-primary/70 group-active:opacity-100" />
    </div>
  )
}

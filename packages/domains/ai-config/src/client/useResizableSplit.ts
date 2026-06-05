import { useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useContextManagerStore } from './useContextManagerStore'

/**
 * Pixel-based resizable split for the project context tree. Owns the container ref and
 * drag state; persists the width via the context manager store. Width is clamped to
 * 15%–80% of the container while dragging. `resetSplit` restores the default (350px).
 */
export function useResizableSplit() {
  const splitWidth = useContextManagerStore((s) => s.projectSplitWidth)
  const setSplitWidth = useContextManagerStore((s) => s.setProjectSplitWidth)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: globalThis.MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const px = ev.clientX - rect.left
      const min = rect.width * 0.15
      const max = rect.width * 0.8
      setSplitWidth(Math.min(Math.max(px, min), max))
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const resetSplit = () => setSplitWidth(350)

  return { containerRef, splitWidth, onDragStart, resetSplit }
}

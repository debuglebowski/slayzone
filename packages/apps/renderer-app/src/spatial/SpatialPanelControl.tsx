import { useRef, useState, type PointerEvent } from 'react'

const tearOutDistance = 56

interface Drag {
  pointerId: number
  x: number
  y: number
}

export function SpatialPanelControl({
  label,
  onDetach
}: {
  label: string
  onDetach: () => void
}): React.JSX.Element {
  const drag = useRef<Drag | null>(null)
  const dragged = useRef(false)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)

  function start(event: PointerEvent<HTMLButtonElement>): void {
    if (!event.isPrimary || event.button !== 0) return
    dragged.current = false
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function displacement(event: PointerEvent<HTMLButtonElement>): { x: number; y: number } | null {
    if (drag.current?.pointerId !== event.pointerId) return null
    return { x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }
  }

  function move(event: PointerEvent<HTMLButtonElement>): void {
    const delta = displacement(event)
    if (!delta) return
    if (Math.hypot(delta.x, delta.y) >= 6) dragged.current = true
    if (dragged.current) setOffset(delta)
  }

  function finish(event: PointerEvent<HTMLButtonElement>): void {
    const delta = displacement(event)
    if (!delta) return
    drag.current = null
    setOffset(null)
    if (event.type === 'pointerup' && Math.hypot(delta.x, delta.y) >= tearOutDistance) {
      dragged.current = true
      onDetach()
    } else if (event.type !== 'pointerup') {
      dragged.current = true
    }
  }

  return (
    <button
      type="button"
      className="relative inline-flex min-h-11 touch-none select-none items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-accent active:cursor-grabbing"
      aria-label={`Detach ${label}`}
      title={`Drag or press to detach ${label}`}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onClick={(event) => {
        if (event.detail === 0 || !dragged.current) onDetach()
        dragged.current = false
      }}
    >
      {label}
      <span aria-hidden="true">↗</span>
      {offset && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-50 grid place-items-center whitespace-nowrap rounded-lg border border-ring bg-popover px-3 text-popover-foreground shadow-lg"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        >
          {Math.hypot(offset.x, offset.y) >= tearOutDistance ? 'Release to detach' : label}
        </span>
      )}
    </button>
  )
}

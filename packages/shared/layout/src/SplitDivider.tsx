// Draggable divider between two split children. Mirrors the electron app's
// ResizeHandle: capture start pointer + fractions in a ref on mousedown, attach
// document mousemove/up, clamp via the pure applySplitResize, double-click to
// reset. Inline-styled (no Tailwind).
import { useEffect, useRef, useState } from 'react'
import type { Rect, SplitDirection } from './types'
import { applySplitResize, resetSplitFractions } from './resize'
import { COLORS } from './colors'

interface SplitDividerProps {
  index: number
  rect: Rect
  direction: SplitDirection
  childMinsPx: number[]
  totalContentPx: number
  /** Read the split's current fractions (captured live at mousedown). */
  getFractions: () => number[]
  onResize: (fractions: number[]) => void
}

export function SplitDivider(props: SplitDividerProps) {
  const { index, rect, direction, childMinsPx, totalContentPx, getFractions, onResize } = props
  const horizontal = direction === 'row'
  const dragRef = useRef<{ pos: number; fractions: number[] } | null>(null)
  const moveRef = useRef<((e: MouseEvent) => void) | null>(null)
  const upRef = useRef<(() => void) | null>(null)
  const [active, setActive] = useState(false)
  const [hover, setHover] = useState(false)

  const cleanup = (): void => {
    if (moveRef.current) document.removeEventListener('mousemove', moveRef.current)
    if (upRef.current) document.removeEventListener('mouseup', upRef.current)
    moveRef.current = null
    upRef.current = null
  }
  useEffect(() => cleanup, [])

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    dragRef.current = { pos: horizontal ? e.clientX : e.clientY, fractions: getFractions() }
    setActive(true)
    const onMove = (ev: MouseEvent): void => {
      const d = dragRef.current
      if (!d) return
      const delta = (horizontal ? ev.clientX : ev.clientY) - d.pos
      onResize(applySplitResize(d.fractions, childMinsPx, index, delta, totalContentPx))
    }
    const onUp = (): void => {
      dragRef.current = null
      setActive(false)
      cleanup()
    }
    moveRef.current = onMove
    upRef.current = onUp
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const onDoubleClick = (): void => {
    onResize(resetSplitFractions(getFractions().length))
  }

  const lineColor = active ? COLORS.dividerActive : hover ? COLORS.dividerHover : 'transparent'

  return (
    <div
      data-testid="split-divider"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        style={
          horizontal
            ? { width: 2, height: '100%', background: lineColor }
            : { width: '100%', height: 2, background: lineColor }
        }
      />
    </div>
  )
}

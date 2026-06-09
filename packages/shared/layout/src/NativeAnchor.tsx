// A native-kind tile's body: an empty positioned div whose live screen rect is
// measured and published to the NativeSurfaceHost. The native surface (when one
// exists) is composited on top at that rect. The placeholder fill doubles as
// the backdrop while the surface is loading or policy-hidden.
//
// Visibility is engine-derived (occlusion policy): dialog overlays / divider
// drags hide the surface via host.setVisible — centralized here so no panel
// reimplements it.
import { useEffect, useRef } from 'react'
import type { NativeSurfaceHost } from './NativeSurfaceHost'
import { useNativeTilesVisible } from './store'
import { COLORS } from './colors'

interface NativeAnchorProps {
  tileId: string
  host: NativeSurfaceHost
  label?: string
}

export function NativeAnchor({ tileId, host, label }: NativeAnchorProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNativeTilesVisible()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const publish = (): void => {
      raf = 0
      const r = el.getBoundingClientRect()
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      // CSS px — shell page is full-bleed at the container origin, so these map
      // 1:1 to view DIPs; the native side owns device scaling.
      host.place({
        tileId,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        devicePixelRatio: dpr
      })
    }
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(publish)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // resize/scroll move the rect too; the v1 layout doesn't scroll, but cover resize.
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
      host.remove(tileId)
    }
  }, [tileId, host])

  // Engine-derived visibility → native surface. On reveal, re-publish the rect
  // (it may have moved while hidden, e.g. hide-during-drag).
  useEffect(() => {
    host.setVisible(tileId, visible)
    if (visible) {
      const el = ref.current
      if (el) {
        const r = el.getBoundingClientRect()
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        host.place({ tileId, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, devicePixelRatio: dpr })
      }
    }
  }, [visible, tileId, host])

  return (
    <div
      ref={ref}
      data-native-tile={tileId}
      style={{
        position: 'absolute',
        inset: 0,
        background: COLORS.nativePlaceholderBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: COLORS.faint,
        fontSize: 12
      }}
    >
      {visible ? (label ?? 'native pane') : `${label ?? 'native pane'} — paused`}
    </div>
  )
}

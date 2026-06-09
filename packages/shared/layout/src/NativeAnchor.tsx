// A native-kind tile's body: an empty positioned div whose live screen rect is
// measured and published to the NativeSurfaceHost. The native surface (when one
// exists) is composited on top at that rect. v1 also paints a placeholder fill
// so the slot is visible in screenshots while the host is a no-op.
import { useEffect, useRef } from 'react'
import type { NativeSurfaceHost } from './NativeSurfaceHost'
import { COLORS } from './colors'

interface NativeAnchorProps {
  tileId: string
  host: NativeSurfaceHost
  label?: string
}

export function NativeAnchor({ tileId, host, label }: NativeAnchorProps) {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const publish = (): void => {
      raf = 0
      const r = el.getBoundingClientRect()
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      host.place({
        tileId,
        rect: { x: r.x * dpr, y: r.y * dpr, w: r.width * dpr, h: r.height * dpr },
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
      {label ?? 'native pane'}
    </div>
  )
}

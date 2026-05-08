import { useCallback, useEffect, useMemo, useRef } from 'react'

export interface PanZoomOptions {
  zoomScaleSensitivity?: number
  fitOnMount?: boolean
  fitOnResize?: boolean
  wheelZoom?: 'always' | 'modifier'
  doubleClickToReset?: boolean
  /**
   * Override how the transform is applied each frame. Default writes
   * `translate3d + scale` to `contentRef.style.transform` (CSS rasterizes
   * scaled content → blurry for SVG). Pass a custom fn to apply scale on the
   * native element (e.g. mutate `<svg width/height>` for vector re-raster).
   */
  onApplyTransform?: (t: PanZoomTransform, content: HTMLDivElement, host: HTMLDivElement) => void
}

export interface PanZoomTransform {
  x: number
  y: number
  scale: number
}

export interface PanZoomControls {
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
  fit: () => void
  setTransform: (t: PanZoomTransform) => void
  getTransform: () => PanZoomTransform
}

export interface UsePanZoomReturn {
  hostRef: React.RefObject<HTMLDivElement | null>
  contentRef: React.RefObject<HTMLDivElement | null>
  controls: PanZoomControls
}

const DEFAULTS = {
  zoomScaleSensitivity: 0.4,
  fitOnMount: true,
  fitOnResize: true,
  wheelZoom: 'always' as const,
  doubleClickToReset: true,
}

const IDENTITY: PanZoomTransform = { x: 0, y: 0, scale: 1 }

interface ContentSize {
  w: number
  h: number
}

function measureContent(content: HTMLDivElement): ContentSize {
  const svg = content.querySelector('svg') as SVGSVGElement | null
  if (svg) {
    const vb = svg.viewBox?.baseVal
    if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height }
    try {
      const bb = svg.getBBox()
      if (bb.width > 0 && bb.height > 0) return { w: bb.width, h: bb.height }
    } catch {
      // jsdom + detached SVGs may throw
    }
  }
  return { w: content.scrollWidth, h: content.scrollHeight }
}

export function usePanZoom(opts: PanZoomOptions = {}): UsePanZoomReturn {
  const cfg = { ...DEFAULTS, ...opts }

  const hostRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<PanZoomTransform>({ ...IDENTITY })
  const userInteractedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ startDist: number; lastFactor: number } | null>(null)

  const onApplyTransform = opts.onApplyTransform
  const flush = useCallback(() => {
    rafRef.current = null
    const el = contentRef.current
    if (!el) return
    const t = transformRef.current
    if (onApplyTransform) {
      const host = hostRef.current
      if (host) onApplyTransform(t, el, host)
      return
    }
    el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`
  }, [onApplyTransform])

  const schedule = useCallback(() => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(flush)
  }, [flush])

  const apply = useCallback(
    (next: PanZoomTransform) => {
      transformRef.current = next
      schedule()
    },
    [schedule],
  )

  const fit = useCallback(() => {
    const host = hostRef.current
    const content = contentRef.current
    if (!host || !content) return
    const hostRect = host.getBoundingClientRect()
    if (hostRect.width <= 0 || hostRect.height <= 0) return
    const { w, h } = measureContent(content)
    if (w <= 0 || h <= 0) return
    const scale = Math.min(hostRect.width / w, hostRect.height / h)
    const x = (hostRect.width - w * scale) / 2
    const y = (hostRect.height - h * scale) / 2
    apply({ x, y, scale })
  }, [apply])

  const reset = useCallback(() => {
    userInteractedRef.current = false
    fit()
  }, [fit])

  const zoomAt = useCallback(
    (ax: number, ay: number, factor: number) => {
      const t = transformRef.current
      const newScale = t.scale * factor
      if (newScale === t.scale || newScale <= 0) return
      const ratio = newScale / t.scale
      apply({
        x: ax - (ax - t.x) * ratio,
        y: ay - (ay - t.y) * ratio,
        scale: newScale,
      })
    },
    [apply],
  )

  const zoomCenter = useCallback(
    (factor: number) => {
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      userInteractedRef.current = true
      zoomAt(r.width / 2, r.height / 2, factor)
    },
    [zoomAt],
  )

  const ZOOM_STEP = 1 + cfg.zoomScaleSensitivity
  const zoomIn = useCallback(() => zoomCenter(ZOOM_STEP), [zoomCenter, ZOOM_STEP])
  const zoomOut = useCallback(() => zoomCenter(1 / ZOOM_STEP), [zoomCenter, ZOOM_STEP])

  const setTransform = useCallback(
    (t: PanZoomTransform) => {
      apply({ x: t.x, y: t.y, scale: t.scale })
    },
    [apply],
  )

  const getTransform = useCallback(() => ({ ...transformRef.current }), [])

  // Effect: attach DOM listeners + ResizeObserver.
  useEffect(() => {
    const host = hostRef.current
    const content = contentRef.current
    if (!host || !content) return

    content.style.transformOrigin = '0 0'
    content.style.willChange = 'transform'
    host.style.touchAction = 'none'

    flush()

    const hostLocal = (clientX: number, clientY: number) => {
      const r = host.getBoundingClientRect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    const onPointerDown = (e: PointerEvent) => {
      const pos = hostLocal(e.clientX, e.clientY)
      pointersRef.current.set(e.pointerId, pos)
      try {
        content.setPointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      if (pointersRef.current.size === 2) {
        const [a, b] = Array.from(pointersRef.current.values())
        const startDist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        pinchRef.current = { startDist, lastFactor: 1 }
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const prev = pointersRef.current.get(e.pointerId)
      if (!prev) return
      const next = hostLocal(e.clientX, e.clientY)
      pointersRef.current.set(e.pointerId, next)
      userInteractedRef.current = true

      if (pointersRef.current.size === 2 && pinchRef.current) {
        const [a, b] = Array.from(pointersRef.current.values())
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const factor = dist / pinchRef.current.startDist
        const step = factor / pinchRef.current.lastFactor
        pinchRef.current.lastFactor = factor
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        zoomAt(mx, my, step)
        return
      }

      if (pointersRef.current.size === 1) {
        const t = transformRef.current
        apply({ x: t.x + (next.x - prev.x), y: t.y + (next.y - prev.y), scale: t.scale })
      }
    }

    const releasePointer = (e: PointerEvent) => {
      pointersRef.current.delete(e.pointerId)
      try {
        content.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
      if (pointersRef.current.size < 2) pinchRef.current = null
    }

    const onWheel = (e: WheelEvent) => {
      if (cfg.wheelZoom === 'modifier' && !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const lineToPx = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1
      const dy = e.deltaY * lineToPx
      const factor = Math.exp(-dy * cfg.zoomScaleSensitivity * 0.01)
      const pos = hostLocal(e.clientX, e.clientY)
      userInteractedRef.current = true
      zoomAt(pos.x, pos.y, factor)
    }

    const onDblClick = () => {
      if (cfg.doubleClickToReset) reset()
    }

    content.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', releasePointer)
    window.addEventListener('pointercancel', releasePointer)
    content.addEventListener('lostpointercapture', releasePointer)
    content.addEventListener('wheel', onWheel, { passive: false })
    content.addEventListener('dblclick', onDblClick)

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (cfg.fitOnResize && !userInteractedRef.current) fit()
      })
      ro.observe(host)
    }

    if (cfg.fitOnMount) {
      requestAnimationFrame(() => {
        if (!userInteractedRef.current) fit()
      })
    }

    return () => {
      content.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', releasePointer)
      content.removeEventListener('lostpointercapture', releasePointer)
      content.removeEventListener('wheel', onWheel)
      content.removeEventListener('dblclick', onDblClick)
      ro?.disconnect()
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      pointersRef.current.clear()
      pinchRef.current = null
    }
  }, [apply, fit, flush, reset, zoomAt, cfg.doubleClickToReset, cfg.fitOnMount, cfg.fitOnResize, cfg.wheelZoom, cfg.zoomScaleSensitivity])

  const controls = useMemo<PanZoomControls>(
    () => ({ zoomIn, zoomOut, reset, fit, setTransform, getTransform }),
    [zoomIn, zoomOut, reset, fit, setTransform, getTransform],
  )

  return { hostRef, contentRef, controls }
}

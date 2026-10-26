import { useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState } from 'react'
import { Frame, Expand } from 'lucide-react'
import { IconButton, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { usePanZoom, type PanZoomControls, type PanZoomTransform } from './usePanZoom'

export type MediaSource = { kind: 'svg'; svg: string } | { kind: 'image'; src: string }

export interface MediaViewProps {
  source: MediaSource
  className?: string
  showControls?: boolean
}

type IntrinsicRef = React.MutableRefObject<{ w: number; h: number } | null>

interface FitFullMode {
  mode: 'fit' | 'full'
  fit: () => void
  full: () => void
  refitIfFitMode: () => void
}

/**
 * Fit-to-host / full-native-size mode + transforms over an intrinsic-dim
 * source. Both SVG-DOM and raster-canvas paths need identical pan/zoom anchor
 * behavior — only the rendering surface differs.
 */
function useFitFullMode(
  hostRef: React.RefObject<HTMLDivElement | null>,
  intrinsicRef: IntrinsicRef,
  controls: PanZoomControls
): FitFullMode {
  const [mode, setMode] = useState<'fit' | 'full'>('fit')
  const modeRef = useRef(mode)
  // Synced at commit (before layout/passive effects); read only by effects + callbacks.
  useInsertionEffect(() => {
    modeRef.current = mode
  })

  const computeFit = useCallback((): PanZoomTransform | null => {
    const host = hostRef.current
    const src = intrinsicRef.current
    if (!host || !src) return null
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    const scale = Math.min(r.width / src.w, r.height / src.h)
    return { x: (r.width - src.w * scale) / 2, y: (r.height - src.h * scale) / 2, scale }
  }, [hostRef, intrinsicRef])

  const computeFull = useCallback((): PanZoomTransform | null => {
    const host = hostRef.current
    const src = intrinsicRef.current
    if (!host || !src) return null
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return { x: (r.width - src.w) / 2, y: (r.height - src.h) / 2, scale: 1 }
  }, [hostRef, intrinsicRef])

  const fit = useCallback(() => {
    setMode('fit')
    const t = computeFit()
    if (t) controls.setTransform(t)
  }, [computeFit, controls])

  const full = useCallback(() => {
    setMode('full')
    const t = computeFull()
    if (t) controls.setTransform(t)
  }, [computeFull, controls])

  const refitIfFitMode = useCallback(() => {
    if (modeRef.current !== 'fit') return
    const t = computeFit()
    if (t) controls.setTransform(t)
  }, [computeFit, controls])

  return { mode, fit, full, refitIfFitMode }
}

function FitFullControls({
  mode,
  fit,
  full
}: {
  mode: 'fit' | 'full'
  fit: () => void
  full: () => void
}) {
  return (
    <div className="absolute top-2 right-2 flex gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="rounded-md border border-border bg-popover/90 p-0.5 shadow-sm">
            <IconButton
              aria-label="Fit to view"
              size="icon-sm"
              variant={mode === 'fit' ? 'secondary' : 'ghost'}
              onClick={fit}
            >
              <Frame className="size-3.5" />
            </IconButton>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">Fit to view</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="rounded-md border border-border bg-popover/90 p-0.5 shadow-sm">
            <IconButton
              aria-label="Full size"
              size="icon-sm"
              variant={mode === 'full' ? 'secondary' : 'ghost'}
              onClick={full}
            >
              <Expand className="size-3.5" />
            </IconButton>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">Full size</TooltipContent>
      </Tooltip>
    </div>
  )
}

export function MediaView(props: MediaViewProps) {
  // Split by media type: SVG renders inline (browser rasterizes vector natively
  // at any zoom; Chromium also blocks foreignObject in <img>-loaded SVG → canvas
  // path is unusable for mermaid + other HTML-in-SVG payloads). Raster images
  // keep the canvas pipeline for crisp blits.
  if (props.source.kind === 'svg') {
    return (
      <SvgVectorView
        svg={props.source.svg}
        className={props.className}
        showControls={props.showControls}
      />
    )
  }
  return (
    <RasterCanvasView
      src={props.source.src}
      className={props.className}
      showControls={props.showControls}
    />
  )
}

// Parse intrinsic dims from SVG string + strip width="100%"/max-width so the
// wrapper can size to concrete viewBox dims at render time (no DOM measurement
// needed). Returns null if the SVG has no usable viewBox.
function preprocessSvg(svg: string): { svg: string; w: number; h: number } | null {
  const vbMatch = svg.match(/viewBox=["']([\d.\s-]+)["']/)
  if (!vbMatch) return null
  const parts = vbMatch[1].trim().split(/\s+/).map(Number)
  if (parts.length < 4 || !Number.isFinite(parts[2]) || !Number.isFinite(parts[3])) return null
  const w = parts[2]
  const h = parts[3]
  if (!(w > 0 && h > 0)) return null
  // Drop width/height/style attrs on the root <svg> so our wrapper sizing wins
  // and mermaid's `style="max-width:Xpx"` doesn't cap the SVG. Operates only on
  // the root opening tag — inner <style> blocks/foreignObject attrs untouched.
  const fixed = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\swidth=["'][^"']*["']/g, '')
      .replace(/\sheight=["'][^"']*["']/g, '')
      .replace(/\sstyle=["'][^"']*["']/g, '')
  )
  return { svg: fixed, w, h }
}

function SvgVectorView({
  svg,
  className,
  showControls = true
}: {
  svg: string
  className?: string
  showControls?: boolean
}) {
  const processed = useMemo(() => preprocessSvg(svg), [svg])
  const intrinsicRef = useRef<{ w: number; h: number } | null>(processed)
  // Synced at commit (before layout/passive effects); read only by effects + callbacks.
  useInsertionEffect(() => {
    intrinsicRef.current = processed
  })
  const svgWrapperRef = useRef<HTMLDivElement | null>(null)

  const applyToSvg = useCallback((t: PanZoomTransform) => {
    const el = svgWrapperRef.current
    if (!el) return
    el.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`
  }, [])

  const opts = useMemo(
    () => ({
      fitOnMount: false,
      fitOnResize: false,
      doubleClickToReset: false,
      onApplyTransform: applyToSvg
    }),
    [applyToSvg]
  )
  const { hostRef, contentRef, controls } = usePanZoom(opts)
  const { mode, fit, full, refitIfFitMode } = useFitFullMode(hostRef, intrinsicRef, controls)

  // Refit when SVG content or host size changes (while in fit mode).
  useEffect(() => {
    refitIfFitMode()
  }, [processed, refitIfFitMode])

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(refitIfFitMode)
    ro.observe(host)
    return () => ro.disconnect()
  }, [hostRef, refitIfFitMode])

  // Host must size from the className prop (caller usually passes `absolute
  // inset-0` or flex-grow). Don't add `relative` here — Tailwind generates
  // `relative` AFTER `absolute`, so it would override the caller's `absolute`
  // and collapse the host to 0×0.
  const hostClass = ['overflow-hidden', className].filter(Boolean).join(' ')

  if (!processed) {
    return <div className={hostClass} dangerouslySetInnerHTML={{ __html: svg }} />
  }

  return (
    <div ref={hostRef} className={hostClass}>
      <div
        ref={svgWrapperRef}
        className="absolute top-0 left-0 select-none pointer-events-none"
        style={{ width: processed.w, height: processed.h, transformOrigin: '0 0' }}
        dangerouslySetInnerHTML={{ __html: processed.svg }}
      />
      <div ref={contentRef} className="absolute inset-0" />
      {showControls && <FitFullControls mode={mode} fit={fit} full={full} />}
    </div>
  )
}

function RasterCanvasView({
  src,
  className,
  showControls = true
}: {
  src: string
  className?: string
  showControls?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const bitmapRef = useRef<HTMLImageElement | null>(null)
  const intrinsicRef = useRef<{ w: number; h: number } | null>(null)

  const draw = useCallback((t: PanZoomTransform) => {
    const canvas = canvasRef.current
    const bitmap = bitmapRef.current
    const intrinsic = intrinsicRef.current
    if (!canvas || !bitmap || !intrinsic) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(t.scale * dpr, 0, 0, t.scale * dpr, t.x * dpr, t.y * dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, intrinsic.w, intrinsic.h)
  }, [])

  const onApplyTransform = useCallback(
    (t: PanZoomTransform) => {
      draw(t)
    },
    [draw]
  )

  const opts = useMemo(
    () => ({ fitOnMount: false, fitOnResize: false, doubleClickToReset: false, onApplyTransform }),
    [onApplyTransform]
  )
  const { hostRef, contentRef, controls } = usePanZoom(opts)
  const { mode, fit, full, refitIfFitMode } = useFitFullMode(hostRef, intrinsicRef, controls)

  const resizeCanvas = useCallback(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas) return false
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(r.width * dpr)
    const h = Math.round(r.height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    canvas.style.width = `${r.width}px`
    canvas.style.height = `${r.height}px`
    return true
  }, [hostRef])

  useEffect(() => {
    let cancelled = false
    bitmapRef.current = null
    intrinsicRef.current = null

    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      bitmapRef.current = img
      intrinsicRef.current = { w: img.naturalWidth || 1, h: img.naturalHeight || 1 }
      resizeCanvas()
      refitIfFitMode()
      // Paint identity in case fit mode no-ops (host has 0 dims at this tick).
      // ResizeObserver effect will refit once host lays out.
      draw({ x: 0, y: 0, scale: 1 })
    }
    img.onerror = () => {
      if (!cancelled) console.warn('[MediaView] image load failed:', src)
    }
    img.src = src

    return () => {
      cancelled = true
    }
  }, [src, resizeCanvas, refitIfFitMode, draw])

  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!resizeCanvas()) return
      refitIfFitMode()
      draw(controls.getTransform())
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [hostRef, resizeCanvas, controls, draw, refitIfFitMode])

  const hostClass = ['overflow-hidden', className].filter(Boolean).join(' ')

  return (
    <div ref={hostRef} className={hostClass}>
      <canvas ref={canvasRef} className="absolute inset-0 select-none" />
      <div ref={contentRef} className="absolute inset-0" />
      {showControls && <FitFullControls mode={mode} fit={fit} full={full} />}
    </div>
  )
}

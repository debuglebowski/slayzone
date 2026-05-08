import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Frame, Expand } from 'lucide-react'
import { IconButton, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import { usePanZoom, type PanZoomTransform } from './usePanZoom'

export type CanvasMediaSource =
  | { kind: 'svg'; svg: string }
  | { kind: 'image'; src: string }

export interface CanvasMediaViewProps {
  source: CanvasMediaSource
  className?: string
  showControls?: boolean
}

const MAX_BITMAP_DIM = 8192
const ZOOM_HEADROOM = 2 // raster has 2× headroom past current display scale before re-raster.

interface SourceState {
  bitmap: HTMLImageElement | ImageBitmap
  intrinsicW: number
  intrinsicH: number
  rasterScale: number
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${src}`))
    img.src = src
  })
}

function svgToDataUrl(svg: string): string {
  // CSP `img-src` excludes blob:, so use data: instead. encodeURIComponent
  // keeps the URL valid without base64 (smaller + faster, no btoa unicode pain).
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  return loadImage(svgToDataUrl(svg))
}

function rasterizeSvgImage(img: HTMLImageElement, oversample: number): SourceState {
  const intrinsicW = img.naturalWidth || 300
  const intrinsicH = img.naturalHeight || 150
  const maxOversample = MAX_BITMAP_DIM / Math.max(intrinsicW, intrinsicH)
  const rasterScale = Math.max(1, Math.min(maxOversample, oversample))
  const bw = Math.round(intrinsicW * rasterScale)
  const bh = Math.round(intrinsicH * rasterScale)
  if (typeof OffscreenCanvas !== 'undefined') {
    const off = new OffscreenCanvas(bw, bh)
    const ctx = off.getContext('2d')
    if (ctx) {
      ctx.drawImage(img, 0, 0, bw, bh)
      if ('transferToImageBitmap' in off) {
        return { bitmap: off.transferToImageBitmap(), intrinsicW, intrinsicH, rasterScale }
      }
    }
  }
  // Fallback: keep the SVG image element. drawImage on it works directly in
  // a 2d context. Browser handles re-raster per draw — slower but simple.
  return { bitmap: img, intrinsicW, intrinsicH, rasterScale: 1 }
}

async function loadRasterImage(src: string): Promise<SourceState> {
  const img = await loadImage(src)
  return {
    bitmap: img,
    intrinsicW: img.naturalWidth || 1,
    intrinsicH: img.naturalHeight || 1,
    rasterScale: 1,
  }
}

function pickRasterScale(intrinsicW: number, intrinsicH: number, hostW: number, hostH: number, dpr: number): number {
  // Desired raster density = displayPixelsPerSourcePixel * headroom for zoom-in.
  // displayScale (fit) = min(host/intrinsic). Final canvas-px-per-source-px =
  // displayScale * dpr. With ZOOM_HEADROOM, raster supports user zooming in
  // ~2× past fit before re-raster needed.
  const fitScale = Math.min(hostW / intrinsicW, hostH / intrinsicH)
  const desired = Math.max(1, fitScale * dpr * ZOOM_HEADROOM)
  const cap = MAX_BITMAP_DIM / Math.max(intrinsicW, intrinsicH)
  return Math.min(desired, cap)
}

export function CanvasMediaView({ source, className, showControls = true }: CanvasMediaViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sourceRef = useRef<SourceState | null>(null)
  // Hold the loaded SVG image so we can re-rasterize on host resize / zoom-in.
  const svgImageRef = useRef<HTMLImageElement | null>(null)
  const [mode, setMode] = useState<'fit' | 'full'>('fit')

  const draw = useCallback((t: PanZoomTransform) => {
    const canvas = canvasRef.current
    const src = sourceRef.current
    if (!canvas || !src) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // World coords = source intrinsic px. transform t is in CSS px / unitless.
    // Final canvas-px = (world * t.scale + t.x) * dpr.
    ctx.setTransform(t.scale * dpr, 0, 0, t.scale * dpr, t.x * dpr, t.y * dpr)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src.bitmap as CanvasImageSource, 0, 0, src.intrinsicW, src.intrinsicH)
  }, [])

  const onApplyTransform = useCallback(
    (t: PanZoomTransform) => {
      draw(t)
    },
    [draw],
  )

  const opts = useMemo(
    () => ({ fitOnMount: false, fitOnResize: false, doubleClickToReset: false, onApplyTransform }),
    [onApplyTransform],
  )
  const { hostRef, contentRef, controls } = usePanZoom(opts)

  // Resize canvas to host size × DPR. Triggered by ResizeObserver.
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

  const computeFitTransform = useCallback((): PanZoomTransform | null => {
    const host = hostRef.current
    const src = sourceRef.current
    if (!host || !src) return null
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    const scale = Math.min(r.width / src.intrinsicW, r.height / src.intrinsicH)
    const x = (r.width - src.intrinsicW * scale) / 2
    const y = (r.height - src.intrinsicH * scale) / 2
    return { x, y, scale }
  }, [hostRef])

  const computeFullTransform = useCallback((): PanZoomTransform | null => {
    const host = hostRef.current
    const src = sourceRef.current
    if (!host || !src) return null
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return {
      x: (r.width - src.intrinsicW) / 2,
      y: (r.height - src.intrinsicH) / 2,
      scale: 1,
    }
  }, [hostRef])

  const fit = useCallback(() => {
    setMode('fit')
    const t = computeFitTransform()
    if (t) controls.setTransform(t)
  }, [controls, computeFitTransform])

  const full = useCallback(() => {
    setMode('full')
    const t = computeFullTransform()
    if (t) controls.setTransform(t)
  }, [controls, computeFullTransform])

  const rasterizeForHost = useCallback(() => {
    const host = hostRef.current
    const img = svgImageRef.current
    if (!host || !img) return
    const r = host.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const intrinsicW = img.naturalWidth || 300
    const intrinsicH = img.naturalHeight || 150
    const dpr = window.devicePixelRatio || 1
    const oversample = pickRasterScale(intrinsicW, intrinsicH, r.width, r.height, dpr)
    const current = sourceRef.current
    // Skip re-raster if we already have ≥ this density (avoid thrashing on
    // tiny resize ticks).
    if (current && current.bitmap !== img && current.rasterScale >= oversample * 0.95) return
    sourceRef.current = rasterizeSvgImage(img, oversample)
  }, [hostRef])

  // Compare by primitive values so callers don't need to memoize the `source`
  // object literal — otherwise each parent render = new object ref = effect
  // re-runs = transform reverts to fit (clobbers Full clicks etc).
  const isSvg = source.kind === 'svg'
  const sourceData = isSvg ? source.svg : source.src

  // Load source whenever it changes. SVG: load once + rasterize at host-aware
  // density. Raster image: just load the Image element directly.
  useEffect(() => {
    let cancelled = false
    sourceRef.current = null
    svgImageRef.current = null

    const onLoaded = (state: SourceState | null, svgImg: HTMLImageElement | null) => {
      if (cancelled) return
      svgImageRef.current = svgImg
      if (svgImg) rasterizeForHost()
      else if (state) sourceRef.current = state
      resizeCanvas()
      const t = computeFitTransform()
      setMode('fit')
      if (t) controls.setTransform(t)
      else draw({ x: 0, y: 0, scale: 1 })
    }

    if (isSvg) {
      loadSvgImage(sourceData)
        .then((img) => onLoaded(null, img))
        .catch((err) => { if (!cancelled) console.warn('[CanvasMediaView] svg load failed:', err) })
    } else {
      loadRasterImage(sourceData)
        .then((s) => onLoaded(s, null))
        .catch((err) => { if (!cancelled) console.warn('[CanvasMediaView] image load failed:', err) })
    }

    return () => {
      cancelled = true
    }
  }, [isSvg, sourceData, resizeCanvas, computeFitTransform, controls, draw, rasterizeForHost])

  // Keep canvas pixel-size in sync with host + re-raster SVG at higher density
  // if host grew (keeps mermaid crisp on window enlarge). Resizing the canvas
  // clears its pixel buffer, so re-flush current transform to redraw — but do
  // NOT auto-refit, that would clobber any user pan/zoom in progress.
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!resizeCanvas()) return
      rasterizeForHost()
      draw(controls.getTransform())
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [hostRef, resizeCanvas, controls, rasterizeForHost, draw])

  const hostClass = ['overflow-hidden', className].filter(Boolean).join(' ')

  return (
    <div ref={hostRef} className={hostClass}>
      {/* contentRef is consumed by usePanZoom for pointer/wheel listener attachment.
          We let it cover the host so input events land on it; the canvas paints below. */}
      <canvas ref={canvasRef} className="absolute inset-0 select-none" />
      <div ref={contentRef} className="absolute inset-0" />
      {showControls && (
        <div className="absolute top-2 right-2 flex gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-md border border-border bg-popover/90 p-0.5 shadow-sm">
                <IconButton aria-label="Fit to view" size="icon-sm" variant={mode === 'fit' ? 'secondary' : 'ghost'} onClick={fit}>
                  <Frame className="size-3.5" />
                </IconButton>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">Fit to view</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-md border border-border bg-popover/90 p-0.5 shadow-sm">
                <IconButton aria-label="Full size" size="icon-sm" variant={mode === 'full' ? 'secondary' : 'ghost'} onClick={full}>
                  <Expand className="size-3.5" />
                </IconButton>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">Full size</TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
